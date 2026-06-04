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

module.exports = { saveHtml, readHtml, resolveRedisUrl, closeRedis };
