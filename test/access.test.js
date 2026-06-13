const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowed, normalizeEmail, normalizeSlug, isValidEmail } = require('../lib/access');

test('public page (no acl) is allowed for everyone', () => {
  assert.equal(isAllowed('', null), true);
  assert.equal(isAllowed('anyone@x.com', { protected: false }), true);
});

test('protected page allows only listed emails', () => {
  const acl = { protected: true, allow: ['alice@x.com', 'bob@y.com'] };
  assert.equal(isAllowed('alice@x.com', acl), true);
  assert.equal(isAllowed('ALICE@x.com', acl), true); // normalized
  assert.equal(isAllowed('eve@z.com', acl), false);
  assert.equal(isAllowed('', acl), false);
  assert.equal(isAllowed(undefined, acl), false);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeEmail(undefined), '');
});

test('normalizeSlug trims and lowercases', () => {
  assert.equal(normalizeSlug('  Investor-Deck '), 'investor-deck');
});

test('isValidEmail rejects obvious junk', () => {
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail('no-at-sign'), false);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail(''), false);
});
