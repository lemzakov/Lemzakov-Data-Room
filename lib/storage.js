const { createClient } = require('@vercel/kv');

function firstDefined(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function resolveRedisConfig(env = process.env) {
  const url = firstDefined([
    env.KV_REST_API_URL,
    env.UPSTASH_REDIS_REST_URL,
    env.lemzakov_REDIS_URL
  ]);
  const token = firstDefined([
    env.KV_REST_API_TOKEN,
    env.UPSTASH_REDIS_REST_TOKEN,
    env.lemzakov_REDIS_TOKEN
  ]);

  if (!url || !token) {
    throw new Error('Missing Redis REST config: set KV_REST_API_URL and KV_REST_API_TOKEN');
  }

  if (!url.startsWith('https://')) {
    throw new Error(`Invalid Redis REST URL: expected an https URL, received "${url}"`);
  }

  return { url, token };
}

let kv;
function getKvClient() {
  if (!kv) {
    kv = createClient(resolveRedisConfig());
  }
  return kv;
}

function key(prefix, slug) {
  return `${prefix}:${slug}`;
}

async function saveHtml(prefix, slug, html) {
  await getKvClient().set(key(prefix, slug), html);
}

async function readHtml(prefix, slug) {
  return getKvClient().get(key(prefix, slug));
}

module.exports = { saveHtml, readHtml, resolveRedisConfig };
