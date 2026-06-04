const { createClient } = require('@vercel/kv');

const kv = createClient({
  url: process.env.lemzakov_REDIS_URL || process.env.KV_REST_API_URL,
  token: process.env.lemzakov_REDIS_TOKEN || process.env.KV_REST_API_TOKEN,
});

function key(prefix, slug) {
  return `${prefix}:${slug}`;
}

async function saveHtml(prefix, slug, html) {
  await kv.set(key(prefix, slug), html);
}

async function readHtml(prefix, slug) {
  return kv.get(key(prefix, slug));
}

module.exports = { saveHtml, readHtml };
