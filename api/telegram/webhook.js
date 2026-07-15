// POST /api/telegram/webhook
//
// Receives Telegram updates and routes them:
//   1. Bot menu — text commands (/start, /list, /categories) and "m:" callback
//      taps drive the private admin console (lib/telegram-bot.js). Owner-only.
//   2. Access approvals — Approve/Deny taps on an access request add the
//      requester's email to the page's allow list; they get in on their next
//      visit (already Google-signed-in). Also owner-only.
//
// Security: Telegram includes the secret configured via setWebhook in the
// `X-Telegram-Bot-Api-Secret-Token` header — we require it to match. On top of
// that, every action is gated on TELEGRAM_ADMIN_CHAT_ID (isAdminChat).
//
// Register the webhook once:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/api/telegram/webhook&secret_token=<SECRET>

const { readJsonBody, sendJson } = require('../../lib/http');
const { addAllowedEmail } = require('../../lib/access');
const { getRequest, resolveRequest } = require('../../lib/requests');
const { listPagesWithMeta } = require('../../lib/pages');
const { pageUrls } = require('../../lib/config');
const telegram = require('../../lib/telegram');
const bot = require('../../lib/telegram-bot');

// Telegram client surface the bot menu needs, wired to the real API. The
// isAdminChat guard makes the bot private (owner-only).
const botTelegram = {
  sendMessage: (args) => telegram.sendMessage(args),
  editMessage: (args) => telegram.editMessage(args),
  answerCallback: (id, text) => telegram.answerCallback(id, text),
  isAdminChat: (id) => telegram.isAdminChat(id)
};

function authorized(req) {
  const expected = telegram.webhookSecret();
  if (!expected) return true; // no secret configured: accept (not recommended)
  return req.headers['x-telegram-bot-api-secret-token'] === expected;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const update = await readJsonBody(req);

  // Menu navigation (commands + "m:" callbacks) is handled by the bot module.
  // It is owner-only (enforced inside handleAdminUpdate via isAdminChat).
  if (bot.isBotUpdate(update)) {
    try {
      await bot.handleAdminUpdate(update, {
        tg: botTelegram,
        loadPages: () => listPagesWithMeta(),
        pageUrls: (slug) => pageUrls(slug)
      });
    } catch (error) {
      console.error('[telegram/webhook] bot menu failed', { message: error.message });
    }
    return sendJson(res, 200, { ok: true });
  }

  const cb = update && update.callback_query;

  // Always 200 to Telegram so it doesn't retry; act only on button taps.
  if (!cb || !cb.data) {
    return sendJson(res, 200, { ok: true });
  }

  const { action, requestId } = telegram.parseCallbackData(cb.data);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  const fromId = cb.from && cb.from.id;

  // Approvals are owner-only. The request message is only ever sent to the
  // owner's chat, but guard the tap explicitly so nobody else can approve.
  if (!telegram.isAdminChat(fromId) && !telegram.isAdminChat(chatId)) {
    try { await telegram.answerCallback(cb.id, '⛔️ Not authorized'); } catch {}
    return sendJson(res, 200, { ok: true });
  }

  try {
    const record = await getRequest(requestId);

    if (!record) {
      await telegram.answerCallback(cb.id, 'This request has expired.');
      return sendJson(res, 200, { ok: true });
    }

    if (record.status !== 'pending') {
      await telegram.answerCallback(cb.id, `Already ${record.status}.`);
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'ok') {
      await addAllowedEmail(record.slug, record.email);
      await resolveRequest(requestId, 'approved');
      await telegram.answerCallback(cb.id, 'Approved');
      if (chatId && messageId) {
        await telegram.editMessage({
          chatId,
          messageId,
          text: `✅ <b>Approved</b>\nPage: <code>/${telegram.escapeHtml(record.slug)}</code>\nEmail: <code>${telegram.escapeHtml(record.email)}</code>`
        });
      }
    } else if (action === 'no') {
      await resolveRequest(requestId, 'denied');
      await telegram.answerCallback(cb.id, 'Denied');
      if (chatId && messageId) {
        await telegram.editMessage({
          chatId,
          messageId,
          text: `⛔️ <b>Denied</b>\nPage: <code>/${telegram.escapeHtml(record.slug)}</code>\nEmail: <code>${telegram.escapeHtml(record.email)}</code>`
        });
      }
    } else {
      await telegram.answerCallback(cb.id, '');
    }
  } catch (error) {
    console.error('[telegram/webhook] failed', { message: error.message });
    try { await telegram.answerCallback(cb.id, 'Something went wrong.'); } catch {}
  }

  return sendJson(res, 200, { ok: true });
};
