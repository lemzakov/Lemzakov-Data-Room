// POST /api/auth/passkey/register-options  { email }
//
// Returns WebAuthn credential-creation options. Requires a valid registration
// ticket (i.e. the email was just verified via OTP), so a passkey can only be
// bound to an email whose ownership was proven.

const { normalizeEmail, isValidEmail } = require('../../../lib/access');
const { hasRegistrationTicket } = require('../../../lib/otp');
const { buildRegistrationOptions } = require('../../../lib/webauthn');
const { readJsonBody, sendJson, resolveRelyingParty } = require('../../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  const email = normalizeEmail(body.email);

  if (!email || !isValidEmail(email)) {
    return sendJson(res, 400, { ok: false, error: 'A valid email is required' });
  }

  if (!(await hasRegistrationTicket(email))) {
    return sendJson(res, 403, { ok: false, error: 'Email not verified. Request a code first.' });
  }

  try {
    const { rpID, rpName } = resolveRelyingParty(req);
    const options = await buildRegistrationOptions({ email, rpID, rpName });
    return sendJson(res, 200, { ok: true, options });
  } catch (error) {
    console.error('[passkey/register-options] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Could not start registration' });
  }
};
