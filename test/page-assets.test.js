const test = require('node:test');
const assert = require('node:assert');

const assets = require('../lib/page-assets');
const { servePageAsset, isAssetName } = require('../lib/asset-serve');

// A stand-in for lib/blob-storage with just the asset surface page-assets uses.
function fakeBlob(seed = {}) {
  const store = new Map(Object.entries(seed.files || {})); // "slug/name" -> Buffer
  return {
    store,
    enabled: seed.enabled !== false,
    blobEnabled() { return this.enabled; },
    async saveAsset(slug, name, body, contentType) {
      store.set(`${slug}/${name}`, { body, contentType });
      return true;
    },
    async readAsset(slug, name) {
      const found = store.get(`${slug}/${name}`);
      return found ? { body: found.body, contentType: found.contentType } : null;
    },
    async deleteAsset(slug, name) { return store.delete(`${slug}/${name}`); },
    async listAssets(slug) {
      return Array.from(store.keys())
        .filter((k) => k.startsWith(`${slug}/`))
        .map((k) => ({ name: k.slice(slug.length + 1), size: store.get(k).body.length, uploadedAt: '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  };
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { this.body = chunk; this.ended = true; }
  };
}

// --- Names ------------------------------------------------------------------

test('normalizeAssetName lower-cases, cleans and keeps the extension', () => {
  assert.equal(assets.normalizeAssetName('Q3 Chart.PNG'), 'q3-chart.png');
  assert.equal(assets.normalizeAssetName('a  b__c.jpeg'), 'a-b__c.jpeg');
  assert.equal(assets.normalizeAssetName('logo.SVG'), 'logo.svg');
});

test('normalizeAssetName flattens any path it is handed', () => {
  // The asset namespace is flat per page, so a path is a name with junk on it —
  // and "../" must never escape the page's own prefix.
  assert.equal(assets.normalizeAssetName('charts/../q3.png'), 'q3.png');
  assert.equal(assets.normalizeAssetName('/etc/passwd.png'), 'passwd.png');
  assert.equal(assets.normalizeAssetName('C:\\pics\\shot.png'), 'shot.png');
});

test('normalizeAssetName falls back to the content type when the name has no extension', () => {
  assert.equal(assets.normalizeAssetName('hero', 'image/webp'), 'hero.webp');
  assert.equal(assets.normalizeAssetName('hero', 'image/jpeg; charset=binary'), 'hero.jpg');
});

test('normalizeAssetName rejects anything that is not an image', () => {
  assert.throws(() => assets.normalizeAssetName('payload.html'), /Unsupported image type/);
  assert.throws(() => assets.normalizeAssetName('script.js'), /Unsupported image type/);
  assert.throws(() => assets.normalizeAssetName('notes'), /Unsupported image type/);
  assert.throws(() => assets.normalizeAssetName('---.png'), /image name is required/);
});

test('assetPath and assetUrls point at the page own URL space', () => {
  assert.equal(assets.assetPath('Memo', 'chart.png'), '/memo/chart.png');
  assert.deepEqual(assets.assetUrls('memo', 'chart.png', { PAGE_DOMAINS: 'data.example.com' }), [
    'https://data.example.com/memo/chart.png'
  ]);
});

// --- Payload decoding -------------------------------------------------------

test('decodeImagePayload accepts base64 and base64 data: URIs', () => {
  const plain = assets.decodeImagePayload({ data: PNG.toString('base64') });
  assert.deepEqual(plain.buffer, PNG);

  const uri = assets.decodeImagePayload({ data: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.deepEqual(uri.buffer, PNG);
  assert.equal(uri.contentType, 'image/png');
});

test('decodeImagePayload rejects junk and non-base64 data: URIs', () => {
  assert.throws(() => assets.decodeImagePayload({ data: '' }), /required/);
  assert.throws(() => assets.decodeImagePayload({ data: 'not base64!!' }), /must be base64/);
  assert.throws(
    () => assets.decodeImagePayload({ data: 'data:image/svg+xml,<svg/>' }),
    /Only base64 data: URIs/
  );
});

// --- Storage ----------------------------------------------------------------

test('saveImage stores the bytes and reports where to reference them', async () => {
  const blob = fakeBlob();
  const result = await assets.saveImage('Memo', 'Q3 Chart.PNG', { data: PNG.toString('base64') }, { blob });

  assert.equal(result.slug, 'memo');
  assert.equal(result.name, 'q3-chart.png');
  assert.equal(result.path, '/memo/q3-chart.png');
  assert.equal(result.size, PNG.length);
  // The served type comes from the extension, never from what the uploader said.
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(blob.store.get('memo/q3-chart.png').body, PNG);
});

test('saveImage ignores a content type that contradicts the extension', async () => {
  const blob = fakeBlob();
  const result = await assets.saveImage(
    'memo', 'chart.png', { data: PNG.toString('base64'), contentType: 'text/html' }, { blob }
  );
  assert.equal(result.contentType, 'image/png');
});

test('saveImage refuses an image over the size limit', async () => {
  const blob = fakeBlob();
  const big = Buffer.alloc(assets.MAX_IMAGE_BYTES + 1, 0x41);
  await assert.rejects(
    () => assets.saveImage('memo', 'big.png', { data: big.toString('base64') }, { blob }),
    /the limit is 4 MB/
  );
  assert.equal(blob.store.size, 0);
});

test('saveImage refuses to run without Blob rather than filling Redis', async () => {
  await assert.rejects(
    () => assets.saveImage('memo', 'c.png', { data: PNG.toString('base64') }, { blob: fakeBlob({ enabled: false }) }),
    /BLOB_READ_WRITE_TOKEN/
  );
});

test('saveImage requires a slug', async () => {
  await assert.rejects(
    () => assets.saveImage('', 'c.png', { data: PNG.toString('base64') }, { blob: fakeBlob() }),
    /slug is required/
  );
});

test('listImages returns every image with its path and URLs', async () => {
  const blob = fakeBlob();
  await assets.saveImage('memo', 'b.png', { data: PNG.toString('base64') }, { blob });
  await assets.saveImage('memo', 'a.png', { data: PNG.toString('base64') }, { blob });
  await assets.saveImage('other', 'c.png', { data: PNG.toString('base64') }, { blob });

  const images = await assets.listImages('memo', { blob });
  assert.deepEqual(images.map((i) => i.name), ['a.png', 'b.png']);
  assert.deepEqual(images.map((i) => i.path), ['/memo/a.png', '/memo/b.png']);
  assert.ok(images[0].urls.every((url) => url.endsWith('/memo/a.png')));
});

test('readImage refuses a nested path and reports a miss as null', async () => {
  const blob = fakeBlob();
  await assets.saveImage('memo', 'a.png', { data: PNG.toString('base64') }, { blob });
  assert.equal(await assets.readImage('memo', '../other/a.png', { blob }), null);
  assert.equal(await assets.readImage('memo', 'nope.png', { blob }), null);
  const found = await assets.readImage('memo', 'a.png', { blob });
  assert.deepEqual(found.body, PNG);
});

test('deleteImage removes one image; deleteAllImages clears the page', async () => {
  const blob = fakeBlob();
  await assets.saveImage('memo', 'a.png', { data: PNG.toString('base64') }, { blob });
  await assets.saveImage('memo', 'b.png', { data: PNG.toString('base64') }, { blob });

  assert.deepEqual(await assets.deleteImage('memo', 'a.png', { blob }), {
    slug: 'memo', name: 'a.png', deleted: true
  });
  assert.equal((await assets.deleteImage('memo', 'a.png', { blob })).deleted, false);

  assert.equal(await assets.deleteAllImages('memo', { blob }), 1);
  assert.equal(blob.store.size, 0);
});

// --- Serving ----------------------------------------------------------------

test('isAssetName accepts only the shape an upload produces', () => {
  assert.equal(isAssetName('chart.png'), true);
  assert.equal(isAssetName('q3_chart-2.png'), true);
  assert.equal(isAssetName('nested/chart.png'), false);
  assert.equal(isAssetName(''), false);
  // Nothing that could address anything but a name inside the page's prefix.
  assert.equal(isAssetName('..'), false);
  assert.equal(isAssetName('.'), false);
  assert.equal(isAssetName('.hidden'), false);
  assert.equal(isAssetName('a b.png'), false);
});

test('servePageAsset declines a traversal attempt before it reaches the store', async () => {
  const res = fakeRes();
  let looked = 0;
  const served = await servePageAsset({ method: 'GET' }, res, {
    slug: 'memo',
    relPath: '..%2Facl%2Fmemo.json',
    assets: { readImage: async () => { looked += 1; return null; } },
    readAcl: async () => null,
    readSession: async () => null
  });
  assert.equal(served, false);
  assert.equal(looked, 0, 'the store is never asked about a name it could not have written');
});

test('servePageAsset serves a public page image with a short cache', async () => {
  const res = fakeRes();
  const served = await servePageAsset({ method: 'GET' }, res, {
    slug: 'memo',
    relPath: 'chart.png',
    assets: { readImage: async () => ({ body: PNG, contentType: 'image/png' }) },
    readAcl: async () => null,
    readSession: async () => null
  });

  assert.equal(served, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.body, PNG);
});

test('servePageAsset sends an unauthenticated visitor to sign in for a restricted page', async () => {
  const res = fakeRes();
  await servePageAsset({ method: 'GET' }, res, {
    slug: 'deck',
    relPath: 'chart.png',
    assets: { readImage: async () => ({ body: PNG, contentType: 'image/png' }) },
    readAcl: async () => ({ protected: true, allow: ['a@x.com'] }),
    readSession: async () => null
  });

  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/api\/auth\/google\/start\?next=%2Fdeck$/);
  assert.equal(res.body, undefined, 'the bytes must not leak with the redirect');
});

test('servePageAsset sends a signed-in but unapproved visitor to request access', async () => {
  const res = fakeRes();
  await servePageAsset({ method: 'GET' }, res, {
    slug: 'deck',
    relPath: 'chart.png',
    assets: { readImage: async () => ({ body: PNG, contentType: 'image/png' }) },
    readAcl: async () => ({ protected: true, allow: ['a@x.com'] }),
    readSession: async () => ({ session: { email: 'nobody@x.com' } })
  });

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/request-access?slug=deck');
});

test('servePageAsset serves an approved visitor and never lets a cache keep it', async () => {
  const res = fakeRes();
  await servePageAsset({ method: 'GET' }, res, {
    slug: 'deck',
    relPath: 'chart.png',
    assets: { readImage: async () => ({ body: PNG, contentType: 'image/png' }) },
    readAcl: async () => ({ protected: true, allow: ['a@x.com'] }),
    readSession: async () => ({ session: { email: 'a@x.com' } })
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.deepEqual(res.body, PNG);
});

test('servePageAsset answers HEAD without a body and declines a miss', async () => {
  const head = fakeRes();
  await servePageAsset({ method: 'HEAD' }, head, {
    slug: 'memo',
    relPath: 'chart.png',
    assets: { readImage: async () => ({ body: PNG, contentType: 'image/png' }) },
    readAcl: async () => null,
    readSession: async () => null
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], String(PNG.length));
  assert.equal(head.body, undefined);

  const miss = fakeRes();
  const served = await servePageAsset({ method: 'GET' }, miss, {
    slug: 'memo',
    relPath: 'gone.png',
    assets: { readImage: async () => null },
    readAcl: async () => null,
    readSession: async () => null
  });
  assert.equal(served, false, 'a miss leaves the response for the caller to handle');
  assert.equal(miss.ended, false);
});
