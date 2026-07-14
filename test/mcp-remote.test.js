const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const core = require('../lib/mcp-core');
const oauth = require('../lib/mcp-oauth');

// --- In-memory KV double matching the storage helper signatures. -----------
function memKv() {
  const store = new Map();
  return {
    store,
    kvSetJson: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
    kvGetJson: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    kvDel: async (k) => { store.delete(k); }
  };
}

// ===========================================================================
// mcp-core (in-process tool dispatch)
// ===========================================================================

test('initialize negotiates the client protocol version when supported', async () => {
  const res = await core.handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(res.result.protocolVersion, '2025-03-26');
  assert.ok(res.result.capabilities.tools);
});

test('initialize falls back to the default protocol for unknown versions', async () => {
  const res = await core.handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(res.result.protocolVersion, core.DEFAULT_PROTOCOL_VERSION);
});

test('tools/list exposes the four publish tools with html required', async () => {
  const res = await core.handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_page', 'list_pages', 'publish_page', 'set_page_access']);
  const publish = res.result.tools.find((t) => t.name === 'publish_page');
  assert.deepEqual(publish.inputSchema.required.sort(), ['html', 'slug']);
});

test('notifications produce no response', async () => {
  const res = await core.handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
});

test('unknown method returns -32601', async () => {
  const res = await core.handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'nope' });
  assert.equal(res.error.code, -32601);
});

test('publish_page saves html and writes the ACL (restricted via allow)', async () => {
  const saved = [];
  const acls = [];
  const deps = {
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    saveHtml: async (prefix, slug, html) => saved.push({ prefix, slug, html }),
    setAcl: async (slug, opts) => { acls.push({ slug, ...opts }); return { protected: opts.protected, allow: opts.allow }; },
    getCategory: async () => '',
    notifyPagePublished: async () => {}
  };
  const res = await core.callTool('publish_page', { slug: 'Deck', html: '<p>hi</p>', allow: ['a@x.com'] }, deps);
  assert.ok(!res.isError);
  assert.deepEqual(saved, [{ prefix: 'html', slug: 'deck', html: '<p>hi</p>' }]);
  assert.deepEqual(acls, [{ slug: 'deck', protected: true, allow: ['a@x.com'] }]);
  assert.match(res.content[0].text, /"published": true/);
});

test('publish_page defaults to public when no access given', async () => {
  const deps = {
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    saveHtml: async () => {},
    setAcl: async (slug, opts) => ({ protected: opts.protected, allow: opts.allow }),
    getCategory: async () => '',
    notifyPagePublished: async () => {}
  };
  const res = await core.callTool('publish_page', { slug: 'memo', html: '<h1>x</h1>' }, deps);
  assert.match(res.content[0].text, /"protected": false/);
});

test('publish_page requires html', async () => {
  const res = await core.callTool('publish_page', { slug: 'memo' }, { getRuntimeConfig: () => ({ storagePrefix: 'html' }) });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /html is required/);
});

test('set_page_access flips access without touching html', async () => {
  let captured;
  const deps = { setAcl: async (slug, opts) => { captured = { slug, ...opts }; return { protected: opts.protected, allow: opts.allow }; } };
  const res = await core.callTool('set_page_access', { slug: 'deck', access: 'restricted', allow: ['b@y.com'] }, deps);
  assert.ok(!res.isError);
  assert.deepEqual(captured, { slug: 'deck', protected: true, allow: ['b@y.com'] });
});

test('set_page_access rejects a bogus access value', async () => {
  const res = await core.callTool('set_page_access', { slug: 'deck', access: 'bogus' }, {});
  assert.ok(res.isError);
  assert.match(res.content[0].text, /public.*restricted/);
});

test('list_pages aggregates slugs with their ACL state and category', async () => {
  const deps = {
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    listSlugs: async () => ['a', 'b'],
    getAcl: async (slug) => (slug === 'a' ? { protected: true, allow: ['x@y.com'] } : null),
    getCategory: async (slug) => (slug === 'a' ? 'Investors' : '')
  };
  const res = await core.callTool('list_pages', {}, deps);
  const parsed = JSON.parse(res.content[0].text);
  assert.deepEqual(parsed.pages, [
    { slug: 'a', protected: true, allow: ['x@y.com'], category: 'Investors' },
    { slug: 'b', protected: false, allow: [], category: '' }
  ]);
});

test('publish_page stores a category and notifies with page addresses', async () => {
  const saved = [];
  const cats = [];
  let notified = null;
  const deps = {
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    saveHtml: async () => { saved.push(true); },
    setAcl: async (slug, opts) => ({ protected: opts.protected, allow: opts.allow }),
    setPageCategory: async (slug, category) => { cats.push({ slug, category }); return { category }; },
    getCategory: async () => '',
    pageUrls: (slug) => [`https://data.lemzakov.com/${slug}`, `https://data.wize.ae/${slug}`],
    notifyPagePublished: async (payload) => { notified = payload; }
  };
  const res = await core.callTool('publish_page', { slug: 'Deck', html: '<p>hi</p>', category: 'Investors' }, deps);
  assert.ok(!res.isError);
  assert.deepEqual(cats, [{ slug: 'deck', category: 'Investors' }]);
  assert.equal(notified.slug, 'deck');
  assert.equal(notified.category, 'Investors');
  assert.deepEqual(notified.urls, ['https://data.lemzakov.com/deck', 'https://data.wize.ae/deck']);
  assert.match(res.content[0].text, /"category": "Investors"/);
});

// ===========================================================================
// mcp-oauth (PKCE, metadata, stores)
// ===========================================================================

test('verifyPkceS256 accepts a matching verifier and rejects others', () => {
  const verifier = oauth.randomToken(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(oauth.verifyPkceS256(verifier, challenge), true);
  assert.equal(oauth.verifyPkceS256('wrong', challenge), false);
  assert.equal(oauth.verifyPkceS256(verifier, ''), false);
});

test('verifyAdminSecret is constant-time-correct against ADMIN_TOKEN', () => {
  const prev = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'sekret';
  try {
    assert.equal(oauth.verifyAdminSecret('sekret'), true);
    assert.equal(oauth.verifyAdminSecret('nope'), false);
    assert.equal(oauth.verifyAdminSecret(''), false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = prev;
  }
});

test('protected-resource metadata points at the issuer origin', () => {
  const meta = oauth.protectedResourceMetadata('https://example.com');
  assert.equal(meta.resource, 'https://example.com/mcp');
  assert.deepEqual(meta.authorization_servers, ['https://example.com']);
});

test('authorization-server metadata advertises PKCE + DCR endpoints', () => {
  const meta = oauth.authorizationServerMetadata('https://example.com');
  assert.equal(meta.issuer, 'https://example.com');
  assert.equal(meta.authorization_endpoint, 'https://example.com/api/mcp/authorize');
  assert.equal(meta.token_endpoint, 'https://example.com/api/mcp/token');
  assert.equal(meta.registration_endpoint, 'https://example.com/api/mcp/register');
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.ok(meta.grant_types_supported.includes('authorization_code'));
});

test('isValidRedirectUri allows https + loopback http, rejects others', () => {
  assert.equal(oauth.isValidRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(oauth.isValidRedirectUri('http://127.0.0.1:8000/cb'), true);
  assert.equal(oauth.isValidRedirectUri('http://evil.com/cb'), false);
  assert.equal(oauth.isValidRedirectUri('not-a-url'), false);
});

test('registerClient validates and persists redirect_uris', async () => {
  const kv = memKv();
  await assert.rejects(() => oauth.registerClient({}, kv), /redirect_uris/);
  await assert.rejects(() => oauth.registerClient({ redirect_uris: ['http://evil.com/cb'] }, kv), /Invalid redirect_uri/);

  const client = await oauth.registerClient({ redirect_uris: ['https://claude.ai/cb'], client_name: 'Claude' }, kv);
  assert.match(client.client_id, /^mcp-/);
  assert.equal(client.token_endpoint_auth_method, 'none');
  const fetched = await oauth.getClient(client.client_id, kv);
  assert.deepEqual(fetched.redirect_uris, ['https://claude.ai/cb']);
});

test('auth code is single-use and bound to the PKCE challenge', async () => {
  const kv = memKv();
  const verifier = oauth.randomToken(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = await oauth.issueAuthCode(
    { clientId: 'c1', redirectUri: 'https://claude.ai/cb', codeChallenge: challenge, scope: 'mcp', sub: 'owner' },
    kv
  );
  const record = await oauth.consumeAuthCode(code, kv);
  assert.equal(record.client_id, 'c1');
  assert.equal(oauth.verifyPkceS256(verifier, record.code_challenge), true);
  // Second consume returns null (one-time use).
  assert.equal(await oauth.consumeAuthCode(code, kv), null);
});

test('issueTokens yields a verifiable access token + rotatable refresh token', async () => {
  const kv = memKv();
  const tokens = await oauth.issueTokens({ clientId: 'c1', scope: 'mcp', sub: 'owner' }, kv);
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);

  const meta = await oauth.verifyAccessToken(tokens.access_token, kv);
  assert.equal(meta.client_id, 'c1');
  assert.equal(await oauth.verifyAccessToken('bogus', kv), null);

  const refreshed = await oauth.consumeRefreshToken(tokens.refresh_token, kv);
  assert.equal(refreshed.client_id, 'c1');
  // Refresh token rotates: second use fails.
  assert.equal(await oauth.consumeRefreshToken(tokens.refresh_token, kv), null);
});

test('bearerFromHeader extracts the token case-insensitively', () => {
  assert.equal(oauth.bearerFromHeader({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(oauth.bearerFromHeader({ headers: { authorization: 'bearer xyz' } }), 'xyz');
  assert.equal(oauth.bearerFromHeader({ headers: {} }), '');
});
