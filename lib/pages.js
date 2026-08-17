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
const { getAcl } = require('./access');
const { getCategory } = require('./page-meta');

async function listPagesWithMeta(deps = {}) {
  const cfg = (deps.getRuntimeConfig || getRuntimeConfig)();
  const listSlugsByStoreImpl = deps.listSlugsByStore || listSlugsByStore;
  const storeLabelImpl = deps.storeLabel || storeLabel;
  const getAclImpl = deps.getAcl || getAcl;
  const getCategoryImpl = deps.getCategory || getCategory;

  const byStore = await listSlugsByStoreImpl(cfg.storagePrefix);
  return Promise.all(
    byStore.all.map(async (slug) => {
      const [acl, category] = await Promise.all([
        getAclImpl(slug),
        getCategoryImpl(slug)
      ]);
      return {
        slug,
        protected: Boolean(acl && acl.protected),
        allow: (acl && acl.allow) || [],
        category: category || '',
        store: storeLabelImpl(slug, byStore) || ''
      };
    })
  );
}

module.exports = { listPagesWithMeta };
