// Permanently removes a single-file page and everything attached to it.
//
// Backs the Delete button in /admin. Beyond the page HTML this clears the
// access record, the category, and the whole analytics footprint for the slug —
// which is usually the larger share, since a busy page accumulates up to 1000
// detail records on top of its counters.
//
// Every Redis operation here is DEL or SREM. Neither is flagged denyoom, so a
// delete still succeeds while the store is at maxmemory — which is the point:
// this is the lever that gets memory back when writes are already refused.
//
// Both stores are cleared for the HTML and the ACL. Removing only one would
// leave the fallback read serving a page that was meant to be gone. Any images
// attached to the page go too: they are served under the page's ACL, so a page
// left half-deleted would leave its images reachable with no record governing
// them.

const {
  kvDel, scanKeys, setRemove, listSlugsByStore
} = require('./storage');
const { getRuntimeConfig } = require('./config');
const blobStorage = require('./blob-storage');
const { normalizeSlug } = require('./access');
const pageAssets = require('./page-assets');

// Mirrors the key layout documented at the top of lib/analytics.js.
function analyticsKeys(slug) {
  return [
    `stat:agg:${slug}`,
    `stat:vis:${slug}`,
    `stat:by:day:${slug}`,
    `stat:by:country:${slug}`,
    `stat:by:ref:${slug}`,
    `stat:by:email:${slug}`,
    `stat:by:device:${slug}`,
    `stat:events:${slug}`
  ];
}

async function deletePage(slugInput, deps = {}) {
  const slug = normalizeSlug(slugInput);
  if (!slug) throw new Error('A slug is required to delete a page');

  const blob = deps.blob || blobStorage;
  const del = deps.kvDel || kvDel;
  const scan = deps.scanKeys || scanKeys;
  const srem = deps.setRemove || setRemove;
  const assets = deps.assets || pageAssets;
  const cfg = (deps.getRuntimeConfig || getRuntimeConfig)();
  const prefix = cfg.storagePrefix;
  const blobOn = blob.blobEnabled();

  // Per-open detail records are unbounded in key count, so they are discovered
  // rather than enumerated.
  const eventKeys = await scan(`stat:ev:${slug}:*`);

  const redisKeys = [
    `${prefix}:${slug}`,
    `acl:${slug}`,
    `pagemeta:${slug}`,
    ...analyticsKeys(slug),
    ...eventKeys
  ];

  await Promise.all(redisKeys.map((k) => del(k)));
  await srem('stat:index', slug).catch(() => {});

  let imagesDeleted = 0;
  if (blobOn) {
    const [, , removedImages] = await Promise.all([
      blob.deleteHtml(prefix, slug),
      blob.deleteAcl(slug),
      assets.deleteAllImages(slug, { blob })
    ]);
    imagesDeleted = removedImages || 0;
  }

  return {
    slug,
    redisKeysDeleted: redisKeys.length,
    analyticsEventsDeleted: eventKeys.length,
    imagesDeleted,
    blobObjectsDeleted: blobOn ? 2 + imagesDeleted : 0
  };
}

// Guards the admin endpoint: refuse to "delete" a slug that no store knows
// about, so a typo reports a 404 instead of silently reporting success.
async function pageExists(slugInput, deps = {}) {
  const slug = normalizeSlug(slugInput);
  if (!slug) return false;
  const cfg = (deps.getRuntimeConfig || getRuntimeConfig)();
  const byStore = await (deps.listSlugsByStore || listSlugsByStore)(cfg.storagePrefix);
  return byStore.all.includes(slug);
}

module.exports = { analyticsKeys, deletePage, pageExists };
