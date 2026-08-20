const test = require('node:test');
const assert = require('node:assert');

const { analyticsKeys, deletePage, pageExists } = require('../lib/page-delete');
const { getAcl, setAcl } = require('../lib/access');

function fakeBlob(seed = {}) {
  const acls = new Map(Object.entries(seed.acls || {}));
  return {
    acls,
    deletedHtml: [],
    deletedAcl: [],
    enabled: seed.enabled !== false,
    blobEnabled() { return this.enabled; },
    async saveAcl(slug, record) { acls.set(slug, record); },
    async readAcl(slug) { return acls.has(slug) ? acls.get(slug) : null; },
    async deleteAcl(slug) { this.deletedAcl.push(slug); return acls.delete(slug); },
    async deleteHtml(prefix, slug) { this.deletedHtml.push(`${prefix}/${slug}`); return true; }
  };
}

// --- Access records ---------------------------------------------------------

test('setAcl writes the record to Blob, not Redis', async () => {
  const blob = fakeBlob();
  let redisWrites = 0;
  const record = await setAcl('memo', { protected: true, allow: ['A@x.com'] }, {
    blob,
    kvSetJson: async () => { redisWrites += 1; },
    kvDel: async () => {}
  });

  assert.equal(redisWrites, 0, 'must not write to Redis — it rejects writes when full');
  assert.deepEqual(record.allow, ['a@x.com']);
  assert.deepEqual(blob.acls.get('memo').allow, ['a@x.com']);
});

test('setAcl drops the pre-cutover Redis copy once Blob holds the record', async () => {
  const blob = fakeBlob();
  const deletedKeys = [];
  await setAcl('memo', { protected: true, allow: ['a@x.com'] }, {
    blob,
    kvSetJson: async () => {},
    kvDel: async (k) => deletedKeys.push(k)
  });
  assert.deepEqual(deletedKeys, ['acl:memo']);
});

test('setAcl still succeeds when the Redis cleanup fails', async () => {
  const blob = fakeBlob();
  const record = await setAcl('memo', { protected: true, allow: ['a@x.com'] }, {
    blob,
    kvSetJson: async () => {},
    kvDel: async () => { throw new Error('OOM command not allowed'); }
  });
  assert.equal(record.protected, true);
  assert.ok(blob.acls.has('memo'));
});

test('making a page public clears the record from BOTH stores', async () => {
  const blob = fakeBlob({ acls: { memo: { protected: true, allow: ['a@x.com'] } } });
  const deletedKeys = [];
  await setAcl('memo', { protected: false }, {
    blob,
    kvSetJson: async () => {},
    kvDel: async (k) => deletedKeys.push(k)
  });

  assert.deepEqual(deletedKeys, ['acl:memo'], 'legacy Redis record removed');
  assert.deepEqual(blob.deletedAcl, ['memo'], 'Blob record removed');
  // A record left in either store would keep the page protected via fallback.
  const after = await getAcl('memo', { blob, kvGetJson: async () => null });
  assert.equal(after, null);
});

test('getAcl falls back to a legacy Redis record and prefers Blob when both exist', async () => {
  const legacy = { protected: true, allow: ['old@x.com'] };
  const onlyRedis = await getAcl('memo', { blob: fakeBlob(), kvGetJson: async () => legacy });
  assert.deepEqual(onlyRedis.allow, ['old@x.com']);

  const both = await getAcl('memo', {
    blob: fakeBlob({ acls: { memo: { protected: true, allow: ['new@x.com'] } } }),
    kvGetJson: async () => legacy
  });
  assert.deepEqual(both.allow, ['new@x.com']);
});

test('getAcl still resolves when the Redis lookup throws', async () => {
  const acl = await getAcl('memo', {
    blob: fakeBlob({ acls: { memo: { protected: true, allow: ['a@x.com'] } } }),
    kvGetJson: async () => { throw new Error('redis down'); }
  });
  assert.deepEqual(acl.allow, ['a@x.com']);
});

// --- Page deletion ----------------------------------------------------------

test('analyticsKeys covers every fixed stat key documented in analytics.js', () => {
  const keys = analyticsKeys('memo');
  for (const suffix of ['agg', 'vis', 'by:day', 'by:country', 'by:ref', 'by:email', 'by:device', 'events']) {
    assert.ok(keys.includes(`stat:${suffix}:memo`), `missing stat:${suffix}:memo`);
  }
});

test('deletePage clears content, access, category and analytics from both stores', async () => {
  const blob = fakeBlob();
  const deleted = [];
  const sremmed = [];

  const result = await deletePage('memo', {
    blob,
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    scanKeys: async (pattern) => {
      assert.equal(pattern, 'stat:ev:memo:*');
      return ['stat:ev:memo:a', 'stat:ev:memo:b'];
    },
    kvDel: async (k) => deleted.push(k),
    setRemove: async (k, m) => sremmed.push([k, m])
  });

  assert.ok(deleted.includes('html:memo'), 'page HTML');
  assert.ok(deleted.includes('acl:memo'), 'access record');
  assert.ok(deleted.includes('pagemeta:memo'), 'category');
  assert.ok(deleted.includes('stat:agg:memo'), 'aggregate counters');
  assert.ok(deleted.includes('stat:ev:memo:a') && deleted.includes('stat:ev:memo:b'), 'detail records');
  assert.deepEqual(sremmed, [['stat:index', 'memo']]);
  assert.deepEqual(blob.deletedHtml, ['html/memo']);
  assert.deepEqual(blob.deletedAcl, ['memo']);
  assert.equal(result.analyticsEventsDeleted, 2);
});

test('deletePage normalizes the slug and rejects an empty one', async () => {
  const deleted = [];
  await deletePage('  MEMO  ', {
    blob: fakeBlob(),
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    scanKeys: async () => [],
    kvDel: async (k) => deleted.push(k),
    setRemove: async () => {}
  });
  assert.ok(deleted.includes('html:memo'));

  await assert.rejects(() => deletePage('   ', { blob: fakeBlob() }), /slug is required/);
});

test('pageExists sees slugs in either store', async () => {
  const deps = {
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    listSlugsByStore: async () => ({
      blob: new Set(['new']), redis: new Set(['old']), all: ['new', 'old']
    })
  };
  assert.equal(await pageExists('old', deps), true);
  assert.equal(await pageExists('new', deps), true);
  assert.equal(await pageExists('ghost', deps), false);
});
