// GET /api/auth/me — returns the signed-in email, if any. Used by the login UI.

const { getSessionFromRequest } = require('../../lib/session');
const { sendJson } = require('../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  try {
    const current = await getSessionFromRequest(req);
    if (!current) return sendJson(res, 200, { ok: true, authenticated: false });
    return sendJson(res, 200, { ok: true, authenticated: true, email: current.session.email });
  } catch (error) {
    return sendJson(res, 200, { ok: true, authenticated: false });
  }
};
