// POST /api/auth/passkey/login-verify  { email, response }
//
// Verifies the assertion from the authenticator and, on success, starts a
// ~6-month session.

const { normalizeEmail, isValidEmail } = require('../../../lib/access');
const { verifyAuthentication } = require('../../../lib/webauthn');
const { createSession, setSessionCookie } = require('../../../lib/session');
const { readJsonBody, sendJson, resolveRelyingParty } = require('../../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);

  if (!email || !isValidEmail(email) || !body.response) {
    return sendJson(res, 400, { ok: false, error: 'Email and credential response are required' });
  }

  try {
    const { rpID, origin } = resolveRelyingParty(req);
    const result = await verifyAuthentication({ email, response: body.response, rpID, origin });
    if (!result.verified) {
      return sendJson(res, 401, { ok: false, error: 'Sign-in failed', reason: result.error });
    }

    const { token } = await createSession(email);
    setSessionCookie(res, token, req);
    return sendJson(res, 200, { ok: true, email });
  } catch (error) {
    console.error('[passkey/login-verify] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Sign-in failed' });
  }
};
