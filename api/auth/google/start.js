// GET /api/auth/google/start?next=/<slug>
//
// Begins Google sign-in: stores a one-time state nonce (CSRF protection) mapped
// to the post-login destination, then redirects to Google's consent screen.

const crypto = require('crypto');
const { isConfigured, buildAuthUrl } = require('../../../lib/google-oauth');
const { requestOrigin, safeNextPath } = require('../../../lib/http');
const { kvSet } = require('../../../lib/storage');

const STATE_TTL_SECONDS = 10 * 60;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }
  if (!isConfigured()) {
    return res.status(500).send('Google sign-in is not configured');
  }

  try {
    const next = safeNextPath(req.query.next);
    const nonce = crypto.randomBytes(24).toString('base64url');
    await kvSet(`oauthstate:${nonce}`, next, STATE_TTL_SECONDS);

    const url = buildAuthUrl({ origin: requestOrigin(req), state: nonce });

    res.statusCode = 302;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', url);
    return res.end();
  } catch (error) {
    console.error('[auth/google/start] failed', { message: error.message });
    return res.status(500).send('Could not start Google sign-in');
  }
};
