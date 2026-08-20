const test = require('node:test');
const assert = require('node:assert');

const {
  classifyKey, report, drainHtml, drainProjectFiles, purgeAnalyticsEvents
} = require('../lib/redis-drain');

// Minimal stand-in for the redis client surface the drain touches.
function fakeClient(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    deleted: [],
    async get(k) { const v = store.get(k); return v === undefined ? null : v; },
    async del(k) {
      const keys = Array.isArray(k) ? k : [k];
      for (const key of keys) { this.deleted.push(key); store.delete(key); }
      return keys.length;
    },
    async memoryUsage(k) { const v = store.get(k); return v === undefined ? 0 : Buffer.byteLength(String(v)); },
    scanIterator({ MATCH }) {
      const re = new RegExp('^' + String(MATCH).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const keys = [...store.keys()].filter((k) => re.test(k));
      return (async function* () { yield keys; })();
    }
  };
}

function fakeBlob(opts = {}) {
  const html = new Map();
  const files = new Map();
  return {
    html,
    files,
    blobEnabled: () => true,
    async saveHtml(prefix, slug, body) {
      if (opts.corruptHtml) { html.set(`${prefix}/${slug}`, 'TRUNCATED'); return; }
      if (opts.failHtml) throw new Error('blob upload failed');
      html.set(`${prefix}/${slug}`, body);
    },
    async readHtml(prefix, slug) { const v = html.get(`${prefix}/${slug}`); return v === undefined ? null : v; },
    async saveProjectFile(slug, relPath, body, contentType) { files.set(`${slug}/${relPath}`, { body, contentType }); },
    async readProjectFile(slug, relPath) { return files.get(`${slug}/${relPath}`) || null; }
  };
}

test('classifyKey buckets every key class the store holds', () => {
  assert.equal(classifyKey('html:memo'), 'html');
  assert.equal(classifyKey('projfile:strategy:a/b.png'), 'projfile');
  assert.equal(classifyKey('stat:ev:memo:abc'), 'analytics-events');
  assert.equal(classifyKey('stat:agg:memo'), 'analytics-agg');
  assert.equal(classifyKey('session:tok'), 'sessions');
  assert.equal(classifyKey('acl:memo'), 'acl');
  assert.equal(classifyKey('projects:index'), 'projects');
  assert.equal(classifyKey('oauthstate:n'), 'ephemeral');
});

test('report totals bytes per class without deleting anything', async () => {
  const client = fakeClient({ 'html:a': 'x'.repeat(100), 'acl:a': '{}', 'stat:ev:a:1': 'y'.repeat(50) });
  const r = await report(client);
  assert.equal(r.totalKeys, 3);
  assert.equal(r.classes.html.bytes, 100);
  assert.equal(r.classes['analytics-events'].bytes, 50);
  assert.deepEqual(client.deleted, []);
});

test('a dry run reports what it would move and deletes nothing', async () => {
  const client = fakeClient({ 'html:memo': '<p>hi</p>' });
  const blob = fakeBlob();
  const r = await drainHtml({ client, blob, dryRun: true });
  assert.equal(r.moved, 1);
  assert.deepEqual(client.deleted, []);
  assert.equal(blob.html.size, 0);
  assert.equal(client.store.get('html:memo'), '<p>hi</p>');
});

test('drainHtml copies to Blob and only then deletes the Redis key', async () => {
  const client = fakeClient({ 'html:memo': '<p>hi</p>', 'html:other': '<p>yo</p>' });
  const blob = fakeBlob();
  const r = await drainHtml({ client, blob, dryRun: false });
  assert.equal(r.moved, 2);
  assert.equal(r.failed, 0);
  assert.equal(blob.html.get('html/memo'), '<p>hi</p>');
  assert.deepEqual(client.deleted.sort(), ['html:memo', 'html:other']);
  assert.equal(client.store.size, 0);
});

test('a Blob copy that does not verify leaves the Redis key untouched', async () => {
  const client = fakeClient({ 'html:memo': '<p>original</p>' });
  const r = await drainHtml({ client, blob: fakeBlob({ corruptHtml: true }), dryRun: false });
  assert.equal(r.moved, 0);
  assert.equal(r.failed, 1);
  assert.deepEqual(client.deleted, []);
  assert.equal(client.store.get('html:memo'), '<p>original</p>');
});

test('a Blob upload that throws aborts before any delete', async () => {
  const client = fakeClient({ 'html:memo': '<p>original</p>' });
  await assert.rejects(
    () => drainHtml({ client, blob: fakeBlob({ failHtml: true }), dryRun: false }),
    /blob upload failed/
  );
  assert.deepEqual(client.deleted, []);
  assert.equal(client.store.get('html:memo'), '<p>original</p>');
});

test('drainProjectFiles decodes the base64 envelope and preserves nested paths', async () => {
  const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const client = fakeClient({
    'projfile:strategy:assets/logo.png': JSON.stringify({ contentType: 'image/png', b64: body.toString('base64') })
  });
  const blob = fakeBlob();
  const r = await drainProjectFiles({ client, blob, dryRun: false });

  assert.equal(r.moved, 1);
  const stored = blob.files.get('strategy/assets/logo.png');
  assert.ok(stored.body.equals(body), 'bytes survive the base64 round-trip');
  assert.equal(stored.contentType, 'image/png');
  assert.deepEqual(client.deleted, ['projfile:strategy:assets/logo.png']);
});

test('drainProjectFiles skips a malformed envelope rather than deleting it', async () => {
  const client = fakeClient({ 'projfile:p:broken.html': 'not json' });
  const r = await drainProjectFiles({ client, blob: fakeBlob(), dryRun: false });
  assert.equal(r.moved, 0);
  assert.equal(r.missing, 1);
  assert.deepEqual(client.deleted, []);
});

test('purgeAnalyticsEvents drops detail records and spares the aggregates', async () => {
  const client = fakeClient({
    'stat:ev:memo:1': 'a', 'stat:ev:memo:2': 'b',
    'stat:agg:memo': 'keep', 'stat:by:day:memo': 'keep', 'html:memo': 'keep'
  });
  const r = await purgeAnalyticsEvents({ client, dryRun: false });
  assert.equal(r.deleted, 2);
  assert.deepEqual(client.deleted.sort(), ['stat:ev:memo:1', 'stat:ev:memo:2']);
  assert.equal(client.store.get('stat:agg:memo'), 'keep');
  assert.equal(client.store.get('html:memo'), 'keep');
});
