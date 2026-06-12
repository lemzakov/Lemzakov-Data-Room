// POST /api/auth/passkey/register-verify  { email, response }
//
// Verifies the attestation produced by the authenticator, stores the new
// credential, consumes the registration ticket, and starts a ~6-month session.

const { normalizeEmail, isValidEmail } = require('../../../lib/access');
const { hasRegistrationTicket, consumeRegistrationTicket } = require('../../../lib/otp');
const { verifyRegistration } = require('../../../lib/webauthn');
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

  if (!(await hasRegistrationTicket(email))) {
    return sendJson(res, 403, { ok: false, error: 'Email not verified. Request a code first.' });
  }

  try {
    const { rpID, origin } = resolveRelyingParty(req);
    const result = await verifyRegistration({ email, response: body.response, rpID, origin });
    if (!result.verified) {
      return sendJson(res, 400, { ok: false, error: 'Passkey registration failed', reason: result.error });
    }

    await consumeRegistrationTicket(email);
    const { token } = await createSession(email);
    setSessionCookie(res, token, req);

    return sendJson(res, 200, { ok: true, email });
  } catch (error) {
    console.error('[passkey/register-verify] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Registration failed' });
  }
};
