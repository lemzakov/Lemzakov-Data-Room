// POST /api/auth/verify-otp  { email, code }
//
// Verifies the emailed code. On success a short-lived registration ticket is
// minted server-side (see lib/otp) authorizing passkey registration for this
// email. Returns whether the user already has a passkey, so the client can
// route to login vs. registration.

const { normalizeEmail, isValidEmail } = require('../../lib/access');
const { verifyCode } = require('../../lib/otp');
const { userExists } = require('../../lib/users');
const { readJsonBody, sendJson } = require('../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();

  if (!email || !isValidEmail(email) || !code) {
    return sendJson(res, 400, { ok: false, error: 'Email and code are required' });
  }

  try {
    const result = await verifyCode(email, code);
    if (!result.ok) {
      const status = result.reason === 'too_many_attempts' ? 429 : 400;
      return sendJson(res, status, { ok: false, error: 'Invalid or expired code', reason: result.reason });
    }

    return sendJson(res, 200, {
      ok: true,
      email,
      hasPasskey: await userExists(email)
    });
  } catch (error) {
    console.error('[auth/verify-otp] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Verification failed' });
  }
};
