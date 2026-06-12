// Authorization for admin/publishing endpoints.
//
// The publish/ACL API is protected by a bearer token. We use ADMIN_TOKEN, and
// fall back to the existing SYNC_SECRET so a single shared secret can guard both
// sync and publishing if desired. Comparison is constant-time.

const crypto = require('crypto');

function adminToken() {
  return (process.env.ADMIN_TOKEN || process.env.SYNC_SECRET || '').trim();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function presentedToken(req, body = {}) {
  return (
    req.headers['x-admin-token'] ||
    req.headers['x-sync-secret'] ||
    req.query?.token ||
    req.query?.secret ||
    body?.token ||
    body?.secret ||
    ''
  );
}

function isAdminAuthorized(req, body = {}) {
  const expected = adminToken();
  if (!expected) {
    // No token configured: refuse rather than run wide open.
    return false;
  }
  return safeEqual(presentedToken(req, body), expected);
}

module.exports = { isAdminAuthorized, adminToken };
