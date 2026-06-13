// POST /api/telegram/webhook
//
// Receives Telegram updates. We only act on callback_query updates from the
// Approve/Deny buttons. Approving adds the requester's email to the page's allow
// list; the requester gets in on their next visit (already Google-signed-in).
//
// Security: Telegram includes the secret configured via setWebhook in the
// `X-Telegram-Bot-Api-Secret-Token` header — we require it to match.
//
// Register the webhook once:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/api/telegram/webhook&secret_token=<SECRET>

const { readJsonBody, sendJson } = require('../../lib/http');
const { addAllowedEmail } = require('../../lib/access');
const { getRequest, resolveRequest } = require('../../lib/requests');
const telegram = require('../../lib/telegram');

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
  const cb = update && update.callback_query;

  // Always 200 to Telegram so it doesn't retry; act only on button taps.
  if (!cb || !cb.data) {
    return sendJson(res, 200, { ok: true });
  }

  const { action, requestId } = telegram.parseCallbackData(cb.data);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;

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
