const { kv } = require('@vercel/kv');

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
