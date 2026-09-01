const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROTOCOL_VERSION,
  TOOLS,
  callTool,
  handleMessage,
  resolveConfig,
  normalizeAccess
} = require('../mcp/data-room-mcp');

const ENV = { LDR_BASE_URL: 'https://data-room.example.com', LDR_ADMIN_TOKEN: 'secret-token' };

// Records calls and returns a canned response for an injected fetch.
function mockFetch(responder) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method, headers: opts.headers, body });
    const { status = 200, json = { ok: true } } = responder({ url, opts, body }) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetch, calls };
}

test('resolveConfig trims and strips trailing slash', () => {
  const cfg = resolveConfig({ LDR_BASE_URL: 'https://x.com/ ', LDR_ADMIN_TOKEN: ' tok ' });
  assert.equal(cfg.baseUrl, 'https://x.com');
  assert.equal(cfg.token, 'tok');
});

test('normalizeAccess maps access keyword and infers protection from allow', () => {
  assert.deepEqual(normalizeAccess({ access: 'public' }), { isProtected: false, allow: [] });
  assert.deepEqual(normalizeAccess({ access: 'restricted', allow: ['a@x.com'] }), {
    isProtected: true,
    allow: ['a@x.com']
  });
  assert.deepEqual(normalizeAccess({ allow: ['a@x.com'] }), { isProtected: true, allow: ['a@x.com'] });
  assert.deepEqual(normalizeAccess({}), { isProtected: undefined, allow: [] });
});

test('initialize returns protocol version and tools capability', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { env: ENV });
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(res.result.capabilities.tools);
  assert.equal(res.result.serverInfo.name, 'lemzakov-data-room');
});

test('tools/list returns the publish and image tools', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { env: ENV });
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'delete_image', 'get_page', 'list_images', 'list_pages',
    'publish_page', 'set_page_access', 'upload_image'
  ]);
  assert.equal(TOOLS.length, 7);
});

test('publish_page forwards the page images to the admin API alongside the HTML', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true, slug: 'deck', published: true } }));
  await callTool('publish_page', {
    slug: 'deck',
    html: '<img src="chart.png">',
    images: [{ name: 'chart.png', data: 'aGk=' }, { file: '/tmp/logo.PNG' }]
  }, { fetch, env: ENV, readBinaryFile: () => Buffer.from('hi') });

  assert.equal(calls[0].url, 'https://data-room.example.com/api/admin/page');
  assert.deepEqual(calls[0].body.images, [
    { name: 'chart.png', data: 'aGk=' },
    { name: 'logo.PNG', data: Buffer.from('hi').toString('base64') }
  ]);
});

test('publish_page rejects an images entry with neither data nor a file', async () => {
  const res = await callTool('publish_page', {
    slug: 'deck', html: '<p>hi</p>', images: [{ name: 'chart.png' }]
  }, { env: ENV });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /`data`.*or.*`file`/);
});

test('upload_image posts the bytes to /api/admin/asset with the admin token', async () => {
  const { fetch, calls } = mockFetch(() => ({
    json: { ok: true, slug: 'deck', name: 'chart.png', path: '/deck/chart.png' }
  }));
  const out = await callTool('upload_image', { slug: 'deck', name: 'chart.png', data: 'aGk=' }, { fetch, env: ENV });

  assert.equal(calls[0].url, 'https://data-room.example.com/api/admin/asset');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['X-Admin-Token'], 'secret-token');
  assert.deepEqual(calls[0].body, { slug: 'deck', name: 'chart.png', data: 'aGk=' });
  assert.match(out.content[0].text, /\/deck\/chart.png/);
});

test('upload_image reads a local file and names the upload after it', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true, path: '/deck/chart.png' } }));
  await callTool('upload_image', { slug: 'deck', file: './chart.png' }, {
    fetch,
    env: ENV,
    readBinaryFile: () => Buffer.from('hi')
  });

  assert.equal(calls[0].body.data, Buffer.from('hi').toString('base64'));
  assert.equal(calls[0].body.name, './chart.png', 'the server normalizes the name');
});

test('upload_image insists on either inline data or a file', async () => {
  const res = await callTool('upload_image', { slug: 'deck' }, { env: ENV });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /`data`.*or.*`file`/);
});

test('list_images reads and delete_image removes through the admin asset API', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true, images: [] } }));
  await callTool('list_images', { slug: 'deck' }, { fetch, env: ENV });
  assert.equal(calls[0].url, 'https://data-room.example.com/api/admin/asset?slug=deck');
  assert.equal(calls[0].method, 'GET');

  await callTool('delete_image', { slug: 'deck', name: 'chart.png' }, { fetch, env: ENV });
  assert.equal(calls[1].url, 'https://data-room.example.com/api/admin/asset?slug=deck&name=chart.png');
  assert.equal(calls[1].method, 'DELETE');
});

test('notifications/initialized produces no response', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { env: ENV });
  assert.equal(res, null);
});

test('unknown method returns -32601', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'does/not/exist' }, { env: ENV });
  assert.equal(res.error.code, -32601);
});

test('publish_page posts html + access to /api/admin/page with the admin token', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true, slug: 'deck', published: true } }));
  const out = await callTool(
    'publish_page',
    { slug: 'deck', html: '<!doctype html><p>hi</p>', access: 'restricted', allow: ['a@x.com'] },
    { env: ENV, fetch }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://data-room.example.com/api/admin/page');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['X-Admin-Token'], 'secret-token');
  assert.deepEqual(calls[0].body, {
    slug: 'deck',
    html: '<!doctype html><p>hi</p>',
    protected: true,
    allow: ['a@x.com']
  });
  assert.ok(!out.isError);
  assert.match(out.content[0].text, /"published": true/);
});

test('publish_page reads htmlFile via injected readFile', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true } }));
  await callTool(
    'publish_page',
    { slug: 'memo', htmlFile: './memo.html', access: 'public' },
    { env: ENV, fetch, readFile: () => '<h1>file</h1>' }
  );
  assert.equal(calls[0].body.html, '<h1>file</h1>');
  assert.equal(calls[0].body.protected, false);
});

test('set_page_access requires a valid access value', async () => {
  const { fetch } = mockFetch(() => ({ json: { ok: true } }));
  const out = await callTool('set_page_access', { slug: 'x', access: 'bogus' }, { env: ENV, fetch });
  assert.ok(out.isError);
  assert.match(out.content[0].text, /public.*restricted/);
});

test('get_page GETs the access record', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true, slug: 'deck', protected: true, allow: [] } }));
  const out = await callTool('get_page', { slug: 'deck' }, { env: ENV, fetch });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://data-room.example.com/api/admin/page?slug=deck');
  assert.match(out.content[0].text, /"protected": true/);
});

test('list_pages GETs /api/admin/pages', async () => {
  const { fetch, calls } = mockFetch(() => ({ json: { ok: true, pages: [] } }));
  await callTool('list_pages', {}, { env: ENV, fetch });
  assert.equal(calls[0].url, 'https://data-room.example.com/api/admin/pages');
});

test('a tool surfaces API errors as isError results', async () => {
  const { fetch } = mockFetch(() => ({ status: 401, json: { ok: false, error: 'Unauthorized' } }));
  const out = await callTool('publish_page', { slug: 'deck', html: '<p>x</p>' }, { env: ENV, fetch });
  assert.ok(out.isError);
  assert.match(out.content[0].text, /Unauthorized/);
});

test('missing config produces a clear isError result', async () => {
  const out = await callTool('list_pages', {}, { env: {}, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.ok(out.isError);
  assert.match(out.content[0].text, /LDR_BASE_URL/);
});
