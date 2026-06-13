const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminAuthorized } = require('../lib/admin');
const adminUi = require('../api/admin/ui');
const adminPages = require('../api/admin/pages');

// Minimal Vercel-style response double capturing status + body.
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; }
  };
}

test('isAdminAuthorized matches the configured token from header', () => {
  const prev = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secret-token';
  try {
    assert.equal(isAdminAuthorized({ headers: { 'x-admin-token': 'secret-token' } }), true);
    assert.equal(isAdminAuthorized({ headers: { 'x-admin-token': 'nope' } }), false);
    assert.equal(isAdminAuthorized({ headers: {} }), false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = prev;
  }
});

test('admin UI serves a no-index HTML login page', async () => {
  const res = mockRes();
  await adminUi({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.match(res.body, /Data Room admin/);
  assert.match(res.body, /X-Admin-Token/);
});

test('GET /api/admin/pages requires a valid admin token', async () => {
  const prev = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secret-token';
  try {
    const res = mockRes();
    // No token presented -> 401 before any Redis access.
    await adminPages({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Unauthorized' });
  } finally {
    if (prev === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = prev;
  }
});

test('GET /api/admin/pages rejects non-GET methods', async () => {
  const res = mockRes();
  await adminPages({ method: 'POST', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 405);
});
