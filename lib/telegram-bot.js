// Telegram admin bot — simple menu navigation over the Data Room's pages.
//
// This is the interactive side of the same bot that handles access-request
// approvals. From a private chat with the owner it offers:
//
//   /start · /menu   → main menu (All pages · Categories)
//   /list  · /all    → a flat listing of every page + its addresses
//   /categories      → pick a category, then a page, to get its URLs
//
// The message/keyboard bodies are built by pure functions (easy to unit-test);
// `handleAdminUpdate` is the router that reads a Telegram update, enforces that
// it came from the owner, loads the pages, and drives the Telegram client.
//
// Callback data namespace (kept well under Telegram's 64-byte cap):
//   m:home            main menu
//   m:all             all pages (flat)
//   m:cats            categories menu
//   m:c:<index>       pages in the Nth category (index into the sorted list)
//   m:p:<slug>        one page's detail (addresses)
//
// Categories are referenced by index rather than name so the payload can never
// overflow or need escaping. The sorted category list is deterministic for a
// given set of pages, so an index resolves consistently within a session.

const { escapeHtml } = require('./telegram');

const UNCATEGORIZED = 'Uncategorized';
const MAX_MESSAGE_LEN = 3800; // stay comfortably under Telegram's 4096 cap

function categoryOf(page) {
  return (page && page.category) || '';
}

function categoryLabel(category) {
  return category || UNCATEGORIZED;
}

function accessIcon(page) {
  return page && page.protected ? '🔒' : '🌐';
}

function bySlug(a, b) {
  return String(a.slug).localeCompare(String(b.slug));
}

// Deterministic, de-duplicated category list for a set of pages: named
// categories A→Z, with the "Uncategorized" bucket (empty string) last if any
// page is uncategorized.
function sortedCategories(pages) {
  const set = new Set(pages.map(categoryOf));
  const named = [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return set.has('') ? [...named, ''] : named;
}

function pagesInCategory(pages, category) {
  return pages.filter((p) => categoryOf(p) === category).sort(bySlug);
}

// ---- Pure view builders ---------------------------------------------------

function buildMainMenu(pages) {
  const total = pages.length;
  const cats = sortedCategories(pages).length;
  return {
    text:
      '🗂 <b>Data Room</b>\n' +
      `${total} page${total === 1 ? '' : 's'} in ${cats} categor${cats === 1 ? 'y' : 'ies'}.\n\n` +
      'Choose what to view:',
    replyMarkup: {
      inline_keyboard: [
        [{ text: '📄 All pages', callback_data: 'm:all' }],
        [{ text: '🗂 Categories', callback_data: 'm:cats' }]
      ]
    }
  };
}

function buildAllPagesText(pages, pageUrls) {
  if (!pages.length) {
    return { text: '📄 <b>All pages</b>\n\nNo pages published yet.', replyMarkup: backToMenu() };
  }
  const cats = sortedCategories(pages);
  const chunks = [`📄 <b>All pages</b> (${pages.length})`];
  let truncated = false;

  for (const category of cats) {
    const inCat = pagesInCategory(pages, category);
    const block = [`\n🗂 <b>${escapeHtml(categoryLabel(category))}</b>`];
    for (const page of inCat) {
      block.push(`${accessIcon(page)} <code>/${escapeHtml(page.slug)}</code>`);
      for (const url of pageUrls(page.slug)) block.push(`   ${escapeHtml(url)}`);
    }
    const candidate = block.join('\n');
    if (chunks.join('\n').length + candidate.length > MAX_MESSAGE_LEN) {
      truncated = true;
      break;
    }
    chunks.push(candidate);
  }
  if (truncated) {
    chunks.push('\n…list truncated. Use 🗂 Categories to browse the rest.');
  }
  return { text: chunks.join('\n'), replyMarkup: backToMenu() };
}

function buildCategoriesMenu(pages) {
  const cats = sortedCategories(pages);
  if (!cats.length) {
    return { text: '🗂 <b>Categories</b>\n\nNo pages published yet.', replyMarkup: backToMenu() };
  }
  const rows = cats.map((category, index) => {
    const count = pagesInCategory(pages, category).length;
    return [{ text: `🗂 ${categoryLabel(category)} (${count})`, callback_data: `m:c:${index}` }];
  });
  rows.push([{ text: '📄 All pages', callback_data: 'm:all' }]);
  return {
    text: '🗂 <b>Categories</b>\nPick a category to see its pages.',
    replyMarkup: { inline_keyboard: rows }
  };
}

function buildCategoryPages(pages, categoryIndex) {
  const cats = sortedCategories(pages);
  const category = cats[categoryIndex];
  if (category === undefined) {
    return { text: '🗂 That category no longer exists.', replyMarkup: backToCategories() };
  }
  const inCat = pagesInCategory(pages, category);
  const rows = inCat.map((page) => [
    { text: `${accessIcon(page)} /${page.slug}`, callback_data: `m:p:${page.slug}` }
  ]);
  rows.push([{ text: '⬅️ Categories', callback_data: 'm:cats' }]);
  return {
    text: `🗂 <b>${escapeHtml(categoryLabel(category))}</b> — ${inCat.length} page${inCat.length === 1 ? '' : 's'}\nPick a page to get its addresses.`,
    replyMarkup: { inline_keyboard: rows }
  };
}

function buildPageDetail(page, pageUrls) {
  if (!page) {
    return { text: '📄 That page no longer exists.', replyMarkup: backToCategories() };
  }
  const urls = pageUrls(page.slug);
  const lines = [
    `📄 <b>/${escapeHtml(page.slug)}</b>`,
    `Category: ${escapeHtml(categoryLabel(categoryOf(page)))}`,
    `Access: ${page.protected ? '🔒 Restricted' : '🌐 Public'}`,
    '',
    '<b>Addresses</b>',
    ...urls.map((u) => `• ${escapeHtml(u)}`)
  ];
  return {
    text: lines.join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: '⬅️ Categories', callback_data: 'm:cats' },
          { text: '🏠 Menu', callback_data: 'm:home' }
        ]
      ]
    }
  };
}

function backToMenu() {
  return { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'm:home' }]] };
}

function backToCategories() {
  return { inline_keyboard: [[{ text: '⬅️ Categories', callback_data: 'm:cats' }]] };
}

// ---- Routing --------------------------------------------------------------

// True if this Telegram update is one the bot menu should handle (a text
// command or an "m:" navigation callback). Approval callbacks (ok:/no:) are
// left to the access webhook.
function isBotUpdate(update) {
  if (!update) return false;
  if (update.message && typeof update.message.text === 'string') return true;
  const cb = update.callback_query;
  return Boolean(cb && typeof cb.data === 'string' && cb.data.startsWith('m:'));
}

function commandOf(text) {
  return String(text || '').trim().split(/\s+/)[0].toLowerCase();
}

// Handles a bot update end-to-end. `deps`:
//   tg          { sendMessage, editMessage, answerCallback, isAdminChat }
//   loadPages   () => Promise<page[]>   (page = { slug, protected, category })
//   pageUrls    (slug) => string[]
async function handleAdminUpdate(update, deps) {
  const { tg, loadPages, pageUrls } = deps;

  if (update.message && typeof update.message.text === 'string') {
    const chatId = update.message.chat && update.message.chat.id;
    if (!tg.isAdminChat(chatId)) {
      await tg.sendMessage({ chatId, text: '⛔️ This bot is private.' });
      return;
    }
    const cmd = commandOf(update.message.text);
    if (cmd === '/list' || cmd === '/all') {
      const pages = await loadPages();
      const view = buildAllPagesText(pages, pageUrls);
      await tg.sendMessage({ chatId, text: view.text, replyMarkup: view.replyMarkup });
      return;
    }
    if (cmd === '/categories' || cmd === '/cats' || cmd === '/category') {
      const pages = await loadPages();
      const view = buildCategoriesMenu(pages);
      await tg.sendMessage({ chatId, text: view.text, replyMarkup: view.replyMarkup });
      return;
    }
    // /start, /menu, /help and anything else → main menu.
    const pages = await loadPages();
    const view = buildMainMenu(pages);
    await tg.sendMessage({ chatId, text: view.text, replyMarkup: view.replyMarkup });
    return;
  }

  const cb = update.callback_query;
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  const fromId = cb.from && cb.from.id;
  if (!tg.isAdminChat(fromId) && !tg.isAdminChat(chatId)) {
    await tg.answerCallback(cb.id, '⛔️ Not authorized');
    return;
  }

  const route = cb.data.slice(2); // strip "m:"
  const pages = await loadPages();
  let view;
  if (route === 'home') {
    view = buildMainMenu(pages);
  } else if (route === 'all') {
    view = buildAllPagesText(pages, pageUrls);
  } else if (route === 'cats') {
    view = buildCategoriesMenu(pages);
  } else if (route.startsWith('c:')) {
    view = buildCategoryPages(pages, Number.parseInt(route.slice(2), 10));
  } else if (route.startsWith('p:')) {
    const slug = route.slice(2);
    view = buildPageDetail(pages.find((p) => p.slug === slug), pageUrls);
  } else {
    view = buildMainMenu(pages);
  }

  await tg.editMessage({ chatId, messageId, text: view.text, replyMarkup: view.replyMarkup });
  await tg.answerCallback(cb.id, '');
}

module.exports = {
  UNCATEGORIZED,
  sortedCategories,
  pagesInCategory,
  buildMainMenu,
  buildAllPagesText,
  buildCategoriesMenu,
  buildCategoryPages,
  buildPageDetail,
  isBotUpdate,
  handleAdminUpdate
};
