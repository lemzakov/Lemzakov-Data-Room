const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCode, hashCode } = require('../lib/otp');
const { parseCookies, resolveRelyingParty } = require('../lib/http');
const { COOKIE_NAME } = require('../lib/session');

test('generateCode returns a zero-padded 6-digit string', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('hashCode is deterministic and email-bound', () => {
  assert.equal(hashCode('123456', 'a@x.com'), hashCode('123456', 'a@x.com'));
  assert.notEqual(hashCode('123456', 'a@x.com'), hashCode('123456', 'b@x.com'));
  assert.notEqual(hashCode('123456', 'a@x.com'), hashCode('654321', 'a@x.com'));
});

test('parseCookies reads multiple cookies', () => {
  const req = { headers: { cookie: `${COOKIE_NAME}=abc123; other=zzz` } };
  const cookies = parseCookies(req);
  assert.equal(cookies[COOKIE_NAME], 'abc123');
  assert.equal(cookies.other, 'zzz');
});

test('parseCookies handles no cookie header', () => {
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('resolveRelyingParty derives rpID and origin from the request host', () => {
  const saved = { id: process.env.WEBAUTHN_RP_ID, origin: process.env.WEBAUTHN_ORIGIN };
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGIN;
  try {
    const req = { headers: { host: 'data-room.example.com', 'x-forwarded-proto': 'https' } };
    const rp = resolveRelyingParty(req);
    assert.equal(rp.rpID, 'data-room.example.com');
    assert.equal(rp.origin, 'https://data-room.example.com');
  } finally {
    if (saved.id !== undefined) process.env.WEBAUTHN_RP_ID = saved.id;
    if (saved.origin !== undefined) process.env.WEBAUTHN_ORIGIN = saved.origin;
  }
});

test('resolveRelyingParty honors env overrides', () => {
  process.env.WEBAUTHN_RP_ID = 'override.com';
  process.env.WEBAUTHN_ORIGIN = 'https://override.com';
  try {
    const rp = resolveRelyingParty({ headers: { host: 'ignored.vercel.app' } });
    assert.equal(rp.rpID, 'override.com');
    assert.equal(rp.origin, 'https://override.com');
  } finally {
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
  }
});
