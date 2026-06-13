// GET /api/auth/google/callback?code=...&state=...
//
// Completes Google sign-in: validates the state nonce, exchanges the code for
// the user's verified identity, starts a ~6-month session, and redirects to the
// originally-requested page. Access enforcement happens there (api/html.js):
// an authenticated-but-unapproved visitor is bounced to /request-access.

const { isConfigured, exchangeCode } = require('../../../lib/google-oauth');
const { requestOrigin, safeNextPath } = require('../../../lib/http');
const { kvGet, kvDel } = require('../../../lib/storage');
const { createSession, setSessionCookie } = require('../../../lib/session');

function fail(res, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(400).send(message);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }
  if (!isConfigured()) {
    return res.status(500).send('Google sign-in is not configured');
  }

  if (req.query.error) {
    return fail(res, `Google sign-in was cancelled (${req.query.error}).`);
  }

  const code = (req.query.code || '').toString();
  const state = (req.query.state || '').toString();
  if (!code || !state) {
    return fail(res, 'Missing code or state.');
  }

  try {
    const stateKey = `oauthstate:${state}`;
    const storedNext = await kvGet(stateKey);
    if (storedNext === null || storedNext === undefined) {
      return fail(res, 'Sign-in link expired or invalid. Please try again.');
    }
    await kvDel(stateKey);
    const next = safeNextPath(storedNext);

    const identity = await exchangeCode({ code, origin: requestOrigin(req) });

    if (!identity.emailVerified) {
      return fail(res, 'Your Google account email is not verified.');
    }

    const { token } = await createSession(identity.email, { name: identity.name });
    setSessionCookie(res, token, req);

    res.statusCode = 302;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', next);
    return res.end();
  } catch (error) {
    console.error('[auth/google/callback] failed', { message: error.message });
    return fail(res, 'Sign-in failed. Please try again.');
  }
};
