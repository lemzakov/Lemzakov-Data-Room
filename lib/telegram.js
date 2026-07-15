// Telegram Bot API helpers for the access-request approval flow.
//
// When a signed-in visitor requests access to a restricted page, we send a
// message to the owner's chat with inline "Approve"/"Deny" buttons. The owner's
// tap arrives at /api/telegram/webhook as a callback_query.
//
// Config:
//   TELEGRAM_BOT_TOKEN        (required) bot token from @BotFather
//   TELEGRAM_ADMIN_CHAT_ID    (required) chat id to send requests to (the owner)
//   TELEGRAM_WEBHOOK_SECRET   (recommended) shared secret validating webhooks

const API_BASE = 'https://api.telegram.org';

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID);
}

function botToken() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function adminChatId() {
  return (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
}

function webhookSecret() {
  return (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

// The bot is private: it only talks to the owner. Every incoming message or
// button tap is checked against TELEGRAM_ADMIN_CHAT_ID before we act on it.
function isAdminChat(id) {
  const admin = adminChatId();
  return Boolean(admin) && String(id) === admin;
}

async function callApi(method, payload, options = {}) {
  const { fetchImpl = fetch } = options;
  const response = await fetchImpl(`${API_BASE}/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

// Inline keyboard for an access request. callback_data is kept short (Telegram
// caps it at 64 bytes) by referencing the request by id.
function approvalKeyboard(requestId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `ok:${requestId}` },
        { text: '⛔️ Deny', callback_data: `no:${requestId}` }
      ]
    ]
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function sendAccessRequest({ requestId, email, name, slug }, options = {}) {
  const lines = [
    '<b>Access request</b>',
    `Page: <code>/${escapeHtml(slug)}</code>`,
    `Name: ${escapeHtml(name) || '—'}`,
    `Email: <code>${escapeHtml(email)}</code>`
  ];
  return callApi(
    'sendMessage',
    {
      chat_id: adminChatId(),
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: approvalKeyboard(requestId)
    },
    options
  );
}

async function answerCallback(callbackQueryId, text, options = {}) {
  return callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' }, options);
}

async function editMessage({ chatId, messageId, text, replyMarkup }, options = {}) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return callApi('editMessageText', payload, options);
}

async function sendMessage({ chatId, text, replyMarkup }, options = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return callApi('sendMessage', payload, options);
}

// Fire-and-forget notification to the owner that a page was (re)published,
// listing every public address it now resolves to. Best-effort: never throws
// (a Telegram outage must not fail a publish), and no-ops when unconfigured.
async function notifyPagePublished({ slug, urls = [], protected: isProtected, category }, options = {}) {
  if (!isConfigured()) return null;
  const lines = [
    '📢 <b>Page published</b>',
    `Page: <code>/${escapeHtml(slug)}</code>`,
    `Category: ${category ? escapeHtml(category) : '—'}`,
    `Access: ${isProtected ? '🔒 Restricted' : '🌐 Public'}`,
    '',
    '<b>Addresses</b>',
    ...urls.map((u) => `• ${escapeHtml(u)}`)
  ];
  try {
    return await callApi(
      'sendMessage',
      {
        chat_id: adminChatId(),
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      },
      options
    );
  } catch (error) {
    console.error('[telegram] notifyPagePublished failed', { message: error.message });
    return null;
  }
}

function parseCallbackData(data) {
  const raw = String(data || '');
  const idx = raw.indexOf(':');
  if (idx === -1) return { action: '', requestId: '' };
  return { action: raw.slice(0, idx), requestId: raw.slice(idx + 1) };
}

module.exports = {
  isConfigured,
  webhookSecret,
  isAdminChat,
  adminChatId,
  sendAccessRequest,
  answerCallback,
  editMessage,
  sendMessage,
  notifyPagePublished,
  approvalKeyboard,
  parseCallbackData,
  escapeHtml
};
