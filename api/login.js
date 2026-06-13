// GET /login?next=/<slug>
//
// Convenience entry point: kicks off Google sign-in, returning to `next`.

const { safeNextPath } = require('../lib/http');

module.exports = async function handler(req, res) {
  const next = safeNextPath(req.query.next);
  res.statusCode = 302;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', `/api/auth/google/start?next=${encodeURIComponent(next)}`);
  return res.end();
};
