// Shared listing of every single-file page with its access + category.
//
// Used by the /admin dashboard (api/admin/pages.js) and the Telegram bot so
// both see the same shape:
//   { slug, protected, allow, category, store }
//
// `store` is 'blob' (written since the Blob cutover), 'redis' (part of the
// pre-cutover back catalogue, still served from Redis) or 'both' (a legacy page
// that has since been rewritten, so Blob serves it and a stale Redis copy
// lingers). It is informational only — visitors see no difference either way.

const { getRuntimeConfig } = require('./config');
const { listSlugsByStore, storeLabel } = require('./storage');
const { getAclMap } = require('./access');
const { getCategoryMap } = require('./page-meta');

// Two bulk lookups rather than two round trips per page. Rendering this list
// used to cost one Blob GET per slug for the ACL alone, which is what made
// /admin hang once every page had to be checked against Blob.
async function listPagesWithMeta(deps = {}) {
  const cfg = (deps.getRuntimeConfig || getRuntimeConfig)();
  const listSlugsByStoreImpl = deps.listSlugsByStore || listSlugsByStore;
  const storeLabelImpl = deps.storeLabel || storeLabel;
  const getAclMapImpl = deps.getAclMap || getAclMap;
  const getCategoryMapImpl = deps.getCategoryMap || getCategoryMap;

  const byStore = await listSlugsByStoreImpl(cfg.storagePrefix);
  const [acls, categories] = await Promise.all([
    getAclMapImpl(byStore.all),
    getCategoryMapImpl(byStore.all)
  ]);

  return byStore.all.map((slug) => {
    const acl = acls[slug];
    return {
      slug,
      protected: Boolean(acl && acl.protected),
      allow: (acl && acl.allow) || [],
      category: categories[slug] || '',
      store: storeLabelImpl(slug, byStore) || ''
    };
  });
}

module.exports = { listPagesWithMeta };
