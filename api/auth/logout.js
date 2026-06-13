// POST /api/auth/logout — revoke the current session and clear the cookie.

const { getSessionFromRequest, destroySession, clearSessionCookie } = require('../../lib/session');
const { sendJson } = require('../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  try {
    const current = await getSessionFromRequest(req);
    if (current) await destroySession(current.token);
  } catch (error) {
    console.error('[auth/logout] failed', { message: error.message });
  }
  clearSessionCookie(res, req);
  return sendJson(res, 200, { ok: true });
};
