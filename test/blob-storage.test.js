const test = require('node:test');
const assert = require('node:assert');

const blob = require('../lib/blob-storage');
const { listSlugsByStore, storeLabel, saveHtml, readHtml } = require('../lib/storage');
const projectStorage = require('../lib/project-storage');
const { listPagesWithMeta } = require('../lib/pages');

// A stand-in for lib/blob-storage backed by a plain Map, so the two-store
// wrappers can be exercised without a Blob token or network.
function fakeBlob(seed = {}) {
  const html = new Map(Object.entries(seed.html || {}));
  const files = new Map(Object.entries(seed.files || {}));
  return {
    enabled: seed.enabled !== false,
    calls: { savedHtml: [], savedFiles: [], deletedFiles: [] },
    blobEnabled() { return this.enabled; },
    async saveHtml(prefix, slug, body) {
      this.calls.savedHtml.push({ prefix, slug, body });
      html.set(`${prefix}/${slug}`, body);
    },
    async readHtml(prefix, slug) {
      const v = html.get(`${prefix}/${slug}`);
      return v === undefined ? null : v;
    },
    async listSlugs(prefix) {
      return [...html.keys()]
        .filter((k) => k.startsWith(`${prefix}/`))
        .map((k) => k.slice(prefix.length + 1))
        .sort();
    },
    async saveProjectFile(slug, relPath, body, contentType) {
      this.calls.savedFiles.push({ slug, relPath, contentType });
      files.set(`${slug}/${relPath}`, { body, contentType });
    },
    async readProjectFile(slug, relPath) {
      return files.get(`${slug}/${relPath}`) || null;
    },
    async deleteProjectFile(slug, relPath) {
      this.calls.deletedFiles.push(`${slug}/${relPath}`);
      return files.delete(`${slug}/${relPath}`);
    },
    async listProjectPaths(slug) {
      return [...files.keys()]
        .filter((k) => k.startsWith(`${slug}/`))
        .map((k) => k.slice(slug.length + 1))
        .sort();
    }
  };
}

// --- Pure pathname helpers --------------------------------------------------

test('htmlPathname and projectFilePathname are stable and derivable from the slug', () => {
  assert.equal(blob.htmlPathname('html', 'memo'), 'html/memo.html');
  assert.equal(blob.projectFilePathname('strategy', 'assets/a.png'), 'projfile/strategy/assets/a.png');
});

test('slugsFromPathnames keeps flat <slug>.html and ignores everything else', () => {
  const slugs = blob.slugsFromPathnames('html', [
    'html/memo.html',
    'html/board-update.html',
    'html/nested/deep.html', // nested -> not a page slug
    'html/notes.txt',        // wrong extension
    'projfile/x/index.html', // different prefix
    'html/memo.html'         // duplicate
  ]);
  assert.deepEqual(slugs, ['board-update', 'memo']);
});

test('projectPathsFromPathnames strips the project prefix and preserves nesting', () => {
  const paths = blob.projectPathsFromPathnames('strategy', [
    'projfile/strategy/index.html',
    'projfile/strategy/assets/logo.png',
    'projfile/other/index.html'
  ]);
  assert.deepEqual(paths, ['assets/logo.png', 'index.html']);
});

test('blobEnabled follows BLOB_READ_WRITE_TOKEN', () => {
  assert.equal(blob.blobEnabled({}), false);
  assert.equal(blob.blobEnabled({ BLOB_READ_WRITE_TOKEN: '   ' }), false);
  assert.equal(blob.blobEnabled({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }), true);
});

test('every blob entry point is inert without a token', async () => {
  const noToken = { BLOB_READ_WRITE_TOKEN: '' };
  const original = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    assert.equal(blob.blobEnabled(noToken), false);
    assert.equal(await blob.readHtml('html', 'memo'), null);
    assert.deepEqual(await blob.listSlugs('html'), []);
    assert.equal(await blob.readProjectFile('p', 'a.html'), null);
    assert.deepEqual(await blob.listProjectPaths('p'), []);
    assert.equal(await blob.saveHtml('html', 'memo', '<p>x</p>'), false);
  } finally {
    if (original !== undefined) process.env.BLOB_READ_WRITE_TOKEN = original;
  }
});

// --- Page HTML: Blob-first writes, Redis fallback reads ---------------------

test('saveHtml writes to Blob when it is configured and never touches Redis', async () => {
  const b = fakeBlob();
  let redisWrites = 0;
  await saveHtml('html', 'memo', '<p>new</p>', {
    blob: b,
    redisSaveHtml: async () => { redisWrites += 1; }
  });
  assert.equal(redisWrites, 0);
  assert.deepEqual(b.calls.savedHtml, [{ prefix: 'html', slug: 'memo', body: '<p>new</p>' }]);
});

test('saveHtml falls back to Redis when Blob is not configured', async () => {
  const b = fakeBlob({ enabled: false });
  const writes = [];
  await saveHtml('html', 'memo', '<p>x</p>', {
    blob: b,
    redisSaveHtml: async (prefix, slug, html) => writes.push({ prefix, slug, html })
  });
  assert.deepEqual(writes, [{ prefix: 'html', slug: 'memo', html: '<p>x</p>' }]);
  assert.deepEqual(b.calls.savedHtml, []);
});

test('readHtml serves a legacy Redis-only page unchanged', async () => {
  const html = await readHtml('html', 'old-memo', {
    blob: fakeBlob(),
    redisReadHtml: async () => '<p>legacy</p>'
  });
  assert.equal(html, '<p>legacy</p>');
});

test('readHtml prefers Blob when a slug exists in both stores', async () => {
  const html = await readHtml('html', 'memo', {
    blob: fakeBlob({ html: { 'html/memo': '<p>fresh</p>' } }),
    redisReadHtml: async () => '<p>stale</p>'
  });
  assert.equal(html, '<p>fresh</p>');
});

test('readHtml returns null when neither store has the slug', async () => {
  const html = await readHtml('html', 'ghost', {
    blob: fakeBlob(),
    redisReadHtml: async () => null
  });
  assert.equal(html, null);
});

test('readHtml still serves from Blob when the Redis lookup fails', async () => {
  const html = await readHtml('html', 'memo', {
    blob: fakeBlob({ html: { 'html/memo': '<p>fresh</p>' } }),
    redisReadHtml: async () => { throw new Error('redis down'); }
  });
  assert.equal(html, '<p>fresh</p>');
});

// --- Listing + store attribution -------------------------------------------

test('listSlugsByStore unions both stores and labels each slug', async () => {
  const byStore = await listSlugsByStore('html', {
    blob: fakeBlob({ html: { 'html/new-page': 'x', 'html/rewritten': 'x' } }),
    redisListSlugs: async () => ['legacy-page', 'rewritten']
  });

  assert.deepEqual(byStore.all, ['legacy-page', 'new-page', 'rewritten']);
  assert.equal(storeLabel('new-page', byStore), 'blob');
  assert.equal(storeLabel('legacy-page', byStore), 'redis');
  assert.equal(storeLabel('rewritten', byStore), 'both');
  assert.equal(storeLabel('missing', byStore), null);
});

test('listSlugsByStore reports every page as redis when Blob is off', async () => {
  const byStore = await listSlugsByStore('html', {
    blob: fakeBlob({ enabled: false }),
    redisListSlugs: async () => ['a', 'b']
  });
  assert.deepEqual(byStore.all, ['a', 'b']);
  assert.equal(storeLabel('a', byStore), 'redis');
});

test('listPagesWithMeta exposes the store alongside access and category', async () => {
  const pages = await listPagesWithMeta({
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    listSlugsByStore: async () => ({
      blob: new Set(['new-page']),
      redis: new Set(['legacy-page']),
      all: ['legacy-page', 'new-page']
    }),
    storeLabel,
    getAcl: async (slug) => (slug === 'legacy-page' ? { protected: true, allow: ['a@x.com'] } : null),
    getCategory: async () => 'Reports'
  });

  assert.deepEqual(pages, [
    { slug: 'legacy-page', protected: true, allow: ['a@x.com'], category: 'Reports', store: 'redis' },
    { slug: 'new-page', protected: false, allow: [], category: 'Reports', store: 'blob' }
  ]);
});

// --- Project files ----------------------------------------------------------

test('saveProjectFile writes raw bytes to Blob rather than base64 to Redis', async () => {
  const b = fakeBlob();
  await projectStorage.saveProjectFile('strategy', 'assets/logo.png', Buffer.from([1, 2, 3]), null, { blob: b });
  assert.deepEqual(b.calls.savedFiles, [
    { slug: 'strategy', relPath: 'assets/logo.png', contentType: 'image/png' }
  ]);
});

test('readProjectFile prefers Blob and falls back to a legacy Redis asset', async () => {
  const b = fakeBlob({ files: { 'strategy/index.html': { body: Buffer.from('<p>fresh</p>'), contentType: 'text/html' } } });
  const legacy = async () => ({ contentType: 'text/html; charset=utf-8', body: Buffer.from('<p>legacy</p>') });

  const fresh = await projectStorage.readProjectFile('strategy', 'index.html', {
    blob: b,
    readRedisProjectFile: legacy
  });
  assert.equal(fresh.body.toString(), '<p>fresh</p>');

  // A path Blob does not hold falls through to the pre-cutover Redis copy.
  const old = await projectStorage.readProjectFile('strategy', 'chapter-2.html', {
    blob: b,
    readRedisProjectFile: legacy
  });
  assert.equal(old.body.toString(), '<p>legacy</p>');
});

test('readProjectFile returns null when neither store holds the path', async () => {
  const file = await projectStorage.readProjectFile('strategy', 'ghost.png', {
    blob: fakeBlob(),
    readRedisProjectFile: async () => null
  });
  assert.equal(file, null);
});

test('deleteProjectFile clears the path from both stores', async () => {
  const b = fakeBlob({ files: { 'strategy/gone.html': { body: Buffer.from('x'), contentType: 'text/html' } } });
  const redisDeletes = [];
  await projectStorage.deleteProjectFile('strategy', 'gone.html', {
    blob: b,
    kvDel: async (k) => redisDeletes.push(k)
  });
  assert.deepEqual(b.calls.deletedFiles, ['strategy/gone.html']);
  assert.deepEqual(redisDeletes, ['projfile:strategy:gone.html']);
});

test('readProjectFile fills in a content type when Blob did not record one', async () => {
  const b = fakeBlob({ files: { 'p/a.css': { body: Buffer.from('body{}'), contentType: '' } } });
  const file = await projectStorage.readProjectFile('p', 'a.css', { blob: b });
  assert.equal(file.contentType, 'text/css; charset=utf-8');
});
