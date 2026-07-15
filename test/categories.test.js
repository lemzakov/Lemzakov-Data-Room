const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCategory } = require('../lib/page-meta');
const { getPageDomains, pageUrls } = require('../lib/config');
const bot = require('../lib/telegram-bot');

// ---------------------------------------------------------------------------
// Category normalization
// ---------------------------------------------------------------------------

test('normalizeCategory trims, collapses whitespace, and caps length', () => {
  assert.equal(normalizeCategory('  Investors  '), 'Investors');
  assert.equal(normalizeCategory('Board   Docs'), 'Board Docs');
  assert.equal(normalizeCategory(''), '');
  assert.equal(normalizeCategory(undefined), '');
  assert.equal(normalizeCategory('x'.repeat(200)).length, 60);
});

// ---------------------------------------------------------------------------
// Page domains / URLs
// ---------------------------------------------------------------------------

test('getPageDomains falls back to the two production domains', () => {
  assert.deepEqual(getPageDomains({}), ['data.lemzakov.com', 'data.wize.ae']);
});

test('getPageDomains parses PAGE_DOMAINS and strips scheme/slashes/dupes', () => {
  assert.deepEqual(
    getPageDomains({ PAGE_DOMAINS: 'https://a.com/, b.com  a.com' }),
    ['a.com', 'b.com']
  );
});

test('pageUrls builds one URL per domain for a clean slug', () => {
  assert.deepEqual(pageUrls('deck', { PAGE_DOMAINS: 'a.com,b.com' }), [
    'https://a.com/deck',
    'https://b.com/deck'
  ]);
  // leading slashes on the slug are stripped
  assert.deepEqual(pageUrls('/deck', { PAGE_DOMAINS: 'a.com' }), ['https://a.com/deck']);
});

// ---------------------------------------------------------------------------
// Bot view builders
// ---------------------------------------------------------------------------

const PAGES = [
  { slug: 'deck', protected: true, category: 'Investors' },
  { slug: 'memo', protected: false, category: 'Investors' },
  { slug: 'notes', protected: false, category: '' },
  { slug: 'brand', protected: false, category: 'Marketing' }
];
const urls = (slug) => [`https://data.lemzakov.com/${slug}`, `https://data.wize.ae/${slug}`];

test('sortedCategories: named A→Z then Uncategorized last', () => {
  assert.deepEqual(bot.sortedCategories(PAGES), ['Investors', 'Marketing', '']);
});

test('buildCategoriesMenu lists each category with counts and an index payload', () => {
  const view = bot.buildCategoriesMenu(PAGES);
  const buttons = view.replyMarkup.inline_keyboard.map((r) => r[0]);
  assert.deepEqual(buttons[0], { text: '🗂 Investors (2)', callback_data: 'm:c:0' });
  assert.deepEqual(buttons[1], { text: '🗂 Marketing (1)', callback_data: 'm:c:1' });
  assert.deepEqual(buttons[2], { text: '🗂 Uncategorized (1)', callback_data: 'm:c:2' });
});

test('buildCategoryPages resolves the index to that category and lists pages', () => {
  const view = bot.buildCategoryPages(PAGES, 0);
  const rows = view.replyMarkup.inline_keyboard;
  // Two pages (sorted by slug: deck < memo) + a back row.
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0][0], { text: '🔒 /deck', callback_data: 'm:p:deck' });
  assert.deepEqual(rows[1][0], { text: '🌐 /memo', callback_data: 'm:p:memo' });
  assert.equal(rows[2][0].callback_data, 'm:cats');
});

test('buildPageDetail lists every address for the page', () => {
  const view = bot.buildPageDetail(PAGES[0], urls);
  assert.match(view.text, /\/deck/);
  assert.match(view.text, /Restricted/);
  assert.match(view.text, /https:\/\/data\.lemzakov\.com\/deck/);
  assert.match(view.text, /https:\/\/data\.wize\.ae\/deck/);
});

// ---------------------------------------------------------------------------
// Bot routing (owner-only)
// ---------------------------------------------------------------------------

function fakeTg(adminId) {
  const calls = { send: [], edit: [], answer: [] };
  return {
    calls,
    tg: {
      sendMessage: async (a) => { calls.send.push(a); },
      editMessage: async (a) => { calls.edit.push(a); },
      answerCallback: async (id, text) => { calls.answer.push({ id, text }); },
      isAdminChat: (id) => String(id) === String(adminId)
    }
  };
}

const deps = (tg) => ({ tg, loadPages: async () => PAGES, pageUrls: urls });

test('isBotUpdate matches commands and m: callbacks, not approvals', () => {
  assert.equal(bot.isBotUpdate({ message: { text: '/start' } }), true);
  assert.equal(bot.isBotUpdate({ callback_query: { data: 'm:cats' } }), true);
  assert.equal(bot.isBotUpdate({ callback_query: { data: 'ok:abc' } }), false);
  assert.equal(bot.isBotUpdate({}), false);
});

test('a non-owner message is refused', async () => {
  const f = fakeTg(999);
  await bot.handleAdminUpdate({ message: { text: '/start', chat: { id: 5 } } }, deps(f.tg));
  assert.equal(f.calls.send.length, 1);
  assert.match(f.calls.send[0].text, /private/);
});

test('owner /list sends the full page listing with addresses', async () => {
  const f = fakeTg(5);
  await bot.handleAdminUpdate({ message: { text: '/list', chat: { id: 5 } } }, deps(f.tg));
  assert.equal(f.calls.send.length, 1);
  assert.match(f.calls.send[0].text, /All pages/);
  assert.match(f.calls.send[0].text, /https:\/\/data\.wize\.ae\/deck/);
});

test('owner /start shows the main menu', async () => {
  const f = fakeTg(5);
  await bot.handleAdminUpdate({ message: { text: '/start', chat: { id: 5 } } }, deps(f.tg));
  const buttons = f.calls.send[0].replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['m:all', 'm:cats']);
});

test('owner callback m:cats edits the message into the categories menu', async () => {
  const f = fakeTg(5);
  await bot.handleAdminUpdate(
    { callback_query: { id: 'q1', data: 'm:cats', from: { id: 5 }, message: { chat: { id: 5 }, message_id: 42 } } },
    deps(f.tg)
  );
  assert.equal(f.calls.edit.length, 1);
  assert.equal(f.calls.edit[0].messageId, 42);
  assert.match(f.calls.edit[0].text, /Categories/);
  assert.equal(f.calls.answer.length, 1);
});

test('owner callback m:p:<slug> edits into the page detail', async () => {
  const f = fakeTg(5);
  await bot.handleAdminUpdate(
    { callback_query: { id: 'q2', data: 'm:p:memo', from: { id: 5 }, message: { chat: { id: 5 }, message_id: 7 } } },
    deps(f.tg)
  );
  assert.match(f.calls.edit[0].text, /\/memo/);
  assert.match(f.calls.edit[0].text, /https:\/\/data\.lemzakov\.com\/memo/);
});

test('a non-owner callback is not authorized and does not edit', async () => {
  const f = fakeTg(5);
  await bot.handleAdminUpdate(
    { callback_query: { id: 'q3', data: 'm:cats', from: { id: 999 }, message: { chat: { id: 999 }, message_id: 1 } } },
    deps(f.tg)
  );
  assert.equal(f.calls.edit.length, 0);
  assert.equal(f.calls.answer[0].text, '⛔️ Not authorized');
});
