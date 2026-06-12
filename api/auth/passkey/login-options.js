// POST /api/auth/passkey/login-options  { email }
//
// Returns WebAuthn assertion options for the email's registered passkeys.
// Returning options for an unknown email would leak which emails are
// registered, so we require at least one credential and otherwise respond 404.

const { normalizeEmail, isValidEmail } = require('../../../lib/access');
const { getCredentials } = require('../../../lib/users');
const { buildAuthenticationOptions } = require('../../../lib/webauthn');
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

  try {
    const creds = await getCredentials(email);
    if (creds.length === 0) {
      return sendJson(res, 404, { ok: false, error: 'No passkey for this email' });
    }

    const { rpID } = resolveRelyingParty(req);
    const options = await buildAuthenticationOptions({ email, rpID });
    return sendJson(res, 200, { ok: true, options });
  } catch (error) {
    console.error('[passkey/login-options] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Could not start sign-in' });
  }
};
