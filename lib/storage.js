const { createClient } = require('redis');

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

async function saveHtml(prefix, slug, html) {
  const client = await getRedisClient();
  await client.set(key(prefix, slug), html);
}

async function readHtml(prefix, slug) {
  const client = await getRedisClient();
  return client.get(key(prefix, slug));
}

// Lists every stored page slug under a prefix (e.g. "html"). Uses SCAN so it
// never blocks Redis, and strips the "<prefix>:" so callers get bare slugs.
async function listSlugs(prefix) {
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
