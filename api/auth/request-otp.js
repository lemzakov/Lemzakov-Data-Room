// POST /api/auth/request-otp  { email }
//
// Sends a one-time verification code to the email, but only if that email is on
// at least one page's allow list (otherwise registering a passkey would grant
// no access anyway, and we avoid acting as an open email relay). To prevent
// account/enumeration leaks the response is always a generic success.

const { normalizeEmail, isValidEmail, emailAllowedAnywhere } = require('../../lib/access');
const { checkRateLimit, issueCode } = require('../../lib/otp');
const { sendEmail, renderOtpEmail } = require('../../lib/email');
const { readJsonBody, sendJson } = require('../../lib/http');

const GENERIC = { ok: true, message: 'If that email has access, a code is on its way.' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);

  if (!email || !isValidEmail(email)) {
    return sendJson(res, 400, { ok: false, error: 'A valid email is required' });
  }

  try {
    if (!(await emailAllowedAnywhere(email))) {
      // Do not reveal that the email is not provisioned.
      return sendJson(res, 200, GENERIC);
    }

    const rate = await checkRateLimit(email);
    if (!rate.allowed) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Too many requests. Please wait before trying again.',
        retryAfter: rate.retryAfter
      });
    }

    const code = await issueCode(email);
    const { subject, html, text } = renderOtpEmail({ code });
    await sendEmail({ to: email, subject, html, text });

    return sendJson(res, 200, GENERIC);
  } catch (error) {
    console.error('[auth/request-otp] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Could not send code' });
  }
};
