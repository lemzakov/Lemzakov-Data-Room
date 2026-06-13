const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCookies, requestOrigin, safeNextPath } = require('../lib/http');
const { COOKIE_NAME } = require('../lib/session');
const oauth = require('../lib/google-oauth');
const telegram = require('../lib/telegram');

test('parseCookies reads multiple cookies', () => {
  const req = { headers: { cookie: `${COOKIE_NAME}=abc123; other=zzz` } };
  const cookies = parseCookies(req);
  assert.equal(cookies[COOKIE_NAME], 'abc123');
  assert.equal(cookies.other, 'zzz');
});

test('parseCookies handles no cookie header', () => {
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('safeNextPath only allows local paths', () => {
  assert.equal(safeNextPath('/investor-deck'), '/investor-deck');
  assert.equal(safeNextPath('https://evil.com'), '/');
  assert.equal(safeNextPath('//evil.com'), '/');
  assert.equal(safeNextPath(''), '/');
  assert.equal(safeNextPath(undefined), '/');
});

test('requestOrigin derives origin from the request host', () => {
  const req = { headers: { host: 'data-room.example.com', 'x-forwarded-proto': 'https' } };
  assert.equal(requestOrigin(req), 'https://data-room.example.com');
});

test('google-oauth buildAuthUrl includes required params', () => {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-123.apps.googleusercontent.com';
  try {
    const url = new URL(oauth.buildAuthUrl({ origin: 'https://x.com', state: 'nonce1' }));
    assert.equal(url.searchParams.get('client_id'), 'client-123.apps.googleusercontent.com');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://x.com/api/auth/google/callback');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.match(url.searchParams.get('scope'), /openid/);
    assert.equal(url.searchParams.get('state'), 'nonce1');
  } finally {
    if (id === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = id;
  }
});

test('google-oauth redirectUri honors override', () => {
  const saved = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://custom.com/cb';
  try {
    assert.equal(oauth.redirectUri('https://ignored.com'), 'https://custom.com/cb');
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    else process.env.GOOGLE_OAUTH_REDIRECT_URI = saved;
  }
});

test('google-oauth decodeJwtPayload reads claims', () => {
  const payload = { email: 'a@x.com', email_verified: true, name: 'A', aud: 'c', iss: 'accounts.google.com' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
  const claims = oauth.decodeJwtPayload(token);
  assert.equal(claims.email, 'a@x.com');
  assert.equal(claims.email_verified, true);
});

test('telegram parseCallbackData splits action and id', () => {
  assert.deepEqual(telegram.parseCallbackData('ok:abc123'), { action: 'ok', requestId: 'abc123' });
  assert.deepEqual(telegram.parseCallbackData('no:xyz'), { action: 'no', requestId: 'xyz' });
  assert.deepEqual(telegram.parseCallbackData('garbage'), { action: '', requestId: '' });
});

test('telegram approvalKeyboard has approve and deny buttons', () => {
  const kb = telegram.approvalKeyboard('req1');
  const row = kb.inline_keyboard[0];
  assert.equal(row[0].callback_data, 'ok:req1');
  assert.equal(row[1].callback_data, 'no:req1');
});

test('telegram escapeHtml neutralizes markup', () => {
  assert.equal(telegram.escapeHtml('<b>&'), '&lt;b&gt;&amp;');
});
