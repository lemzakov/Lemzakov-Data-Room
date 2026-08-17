const { createClient } = require('redis');
const blobStorage = require('./blob-storage');

function firstDefined(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function resolveRedisUrl(env = process.env) {
  const url = firstDefined([
    env.REDIS_URL,
    env.lemzakov_REDIS_URL
  ]);

  if (!url) {
    throw new Error('Missing Redis config: set REDIS_URL');
  }

  if (!url.startsWith('redis://') && !url.startsWith('rediss://')) {
    throw new Error(`Invalid Redis URL: expected redis:// or rediss://, received "${url}"`);
  }

  return url;
}

let redisClientPromise;

async function getRedisClient() {
  if (!redisClientPromise) {
    const client = createClient({ url: resolveRedisUrl() });
    client.on('error', (error) => {
      console.error('Redis client error', error);
    });
    redisClientPromise = client.connect().then(() => client).catch((error) => {
      redisClientPromise = undefined;
      throw error;
    });
  }
  return redisClientPromise;
}

function key(prefix, slug) {
  return `${prefix}:${slug}`;
}

async function redisSaveHtml(prefix, slug, html) {
  const client = await getRedisClient();
  await client.set(key(prefix, slug), html);
}

async function redisReadHtml(prefix, slug) {
  const client = await getRedisClient();
  return client.get(key(prefix, slug));
}

// Lists every stored page slug under a prefix (e.g. "html"). Uses SCAN so it
// never blocks Redis, and strips the "<prefix>:" so callers get bare slugs.
async function redisListSlugs(prefix) {
  const client = await getRedisClient();
  const match = `${prefix}:*`;
  const slugs = [];
  for await (const batch of client.scanIterator({ MATCH: match, COUNT: 100 })) {
    const keys = Array.isArray(batch) ? batch : [batch];
    for (const k of keys) {
      slugs.push(String(k).slice(prefix.length + 1));
    }
  }
  return Array.from(new Set(slugs)).sort();
}

// --- Two-store page HTML (Blob for new writes, Redis for the back catalogue) -
//
// Pages published before the Blob cutover stay in Redis untouched; everything
// written from now on goes to Blob. Reads consult both, so which store a page
// lives in is invisible to visitors. /admin surfaces it via listSlugsByStore().

// New writes go to Blob. Without a BLOB_READ_WRITE_TOKEN the app keeps working
// exactly as before and writes to Redis.
async function saveHtml(prefix, slug, html, deps = {}) {
  const blob = deps.blob || blobStorage;
  if (blob.blobEnabled()) {
    await blob.saveHtml(prefix, slug, html);
    return;
  }
  await (deps.redisSaveHtml || redisSaveHtml)(prefix, slug, html);
}

// Both stores are queried concurrently, not in sequence: a legacy Redis-only
// page would otherwise pay a full Blob round-trip before its own lookup even
// started. Blob wins when a slug somehow exists in both (a pre-cutover page
// that has since been re-synced or re-published), so the freshest copy serves.
async function readHtml(prefix, slug, deps = {}) {
  const blob = deps.blob || blobStorage;
  const readRedis = deps.redisReadHtml || redisReadHtml;
  if (!blob.blobEnabled()) return readRedis(prefix, slug);

  const [fromBlob, fromRedis] = await Promise.all([
    blob.readHtml(prefix, slug),
    readRedis(prefix, slug).catch(() => null)
  ]);
  return fromBlob != null ? fromBlob : fromRedis;
}

// The union of both stores, plus which store each slug came from. One Blob
// listing and one Redis SCAN regardless of how many pages exist.
async function listSlugsByStore(prefix, deps = {}) {
  const blob = deps.blob || blobStorage;
  const listRedis = deps.redisListSlugs || redisListSlugs;
  const [blobSlugs, redisSlugs] = await Promise.all([
    blob.blobEnabled() ? blob.listSlugs(prefix) : Promise.resolve([]),
    listRedis(prefix)
  ]);
  const blobSet = new Set(blobSlugs);
  const redisSet = new Set(redisSlugs);
  const all = Array.from(new Set([...blobSlugs, ...redisSlugs])).sort();
  return { blob: blobSet, redis: redisSet, all };
}

async function listSlugs(prefix, deps = {}) {
  const { all } = await listSlugsByStore(prefix, deps);
  return all;
}

// Which store serves a slug: 'blob', 'redis', 'both', or null when unknown.
// 'both' means a pre-cutover Redis page was later rewritten to Blob; the Blob
// copy is the one that serves and the Redis copy is an inert leftover.
function storeLabel(slug, byStore) {
  const inBlob = byStore.blob.has(slug);
  const inRedis = byStore.redis.has(slug);
  if (inBlob && inRedis) return 'both';
  if (inBlob) return 'blob';
  if (inRedis) return 'redis';
  return null;
}

// Returns every Redis key matching a glob pattern (e.g. "projfile:strategy:*").
// Uses SCAN so it never blocks Redis. Callers strip their own prefix.
async function scanKeys(match) {
  const client = await getRedisClient();
  const keys = [];
  for await (const batch of client.scanIterator({ MATCH: match, COUNT: 200 })) {
    const found = Array.isArray(batch) ? batch : [batch];
    for (const k of found) keys.push(String(k));
  }
  return Array.from(new Set(keys));
}

// --- Generic key/value helpers (used by access control, auth & sessions) ---

async function kvGet(k) {
  const client = await getRedisClient();
  return client.get(k);
}

async function kvSet(k, value, ttlSeconds) {
  const client = await getRedisClient();
  if (ttlSeconds && ttlSeconds > 0) {
    await client.set(k, value, { EX: Math.floor(ttlSeconds) });
  } else {
    await client.set(k, value);
  }
}

async function kvDel(k) {
  const client = await getRedisClient();
  await client.del(k);
}

async function kvGetJson(k) {
  const raw = await kvGet(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvSetJson(k, value, ttlSeconds) {
  await kvSet(k, JSON.stringify(value), ttlSeconds);
}

async function setAdd(k, member) {
  const client = await getRedisClient();
  await client.sAdd(k, member);
}

async function setRemove(k, member) {
  const client = await getRedisClient();
  await client.sRem(k, member);
}

async function setIsMember(k, member) {
  const client = await getRedisClient();
  return Boolean(await client.sIsMember(k, member));
}

async function setMembers(k) {
  const client = await getRedisClient();
  return client.sMembers(k);
}

async function setCard(k) {
  const client = await getRedisClient();
  return client.sCard(k);
}

// --- Hash helpers (used by page analytics counters & event records) ---

async function hashIncr(k, field, by = 1) {
  const client = await getRedisClient();
  return client.hIncrBy(k, field, by);
}

// Sets a field only if it does not already exist (used for "firstSeen").
async function hashSetNx(k, field, value) {
  const client = await getRedisClient();
  return client.hSetNX(k, field, String(value));
}

async function hashSet(k, fields) {
  const client = await getRedisClient();
  return client.hSet(k, fields);
}

async function hashGetAll(k) {
  const client = await getRedisClient();
  return client.hGetAll(k);
}

// --- List helpers (used by the capped per-page recent-opens index) ---

async function listPush(k, value) {
  const client = await getRedisClient();
  return client.lPush(k, value);
}

// Keeps only the first `count` elements (0..count-1) of a list.
async function listTrim(k, count) {
  const client = await getRedisClient();
  return client.lTrim(k, 0, Math.max(0, count - 1));
}

async function listRange(k, start, stop) {
  const client = await getRedisClient();
  return client.lRange(k, start, stop);
}

async function expireKey(k, ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return;
  const client = await getRedisClient();
  await client.expire(k, Math.floor(ttlSeconds));
}

// Closes the shared Redis connection so short-lived processes (e.g. the build
// sync script) can exit instead of hanging on the open socket.
async function closeRedis() {
  if (!redisClientPromise) return;
  const pending = redisClientPromise;
  redisClientPromise = undefined;
  try {
    const client = await pending;
    await client.quit();
  } catch {}
}

module.exports = {
  saveHtml,
  readHtml,
  listSlugs,
  listSlugsByStore,
  storeLabel,
  redisSaveHtml,
  redisReadHtml,
  redisListSlugs,
  scanKeys,
  resolveRedisUrl,
  closeRedis,
  kvGet,
  kvSet,
  kvDel,
  kvGetJson,
  kvSetJson,
  setAdd,
  setRemove,
  setIsMember,
  setMembers,
  setCard,
  hashIncr,
  hashSetNx,
  hashSet,
  hashGetAll,
  listPush,
  listTrim,
  listRange,
  expireKey
};
