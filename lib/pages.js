// Shared listing of every single-file page with its access + category.
//
// Used by the /admin dashboard (api/admin/pages.js) and the Telegram bot so
// both see the same shape:
//   { slug, protected, allow, category }

const { getRuntimeConfig } = require('./config');
const { listSlugs } = require('./storage');
const { getAcl } = require('./access');
const { getCategory } = require('./page-meta');

async function listPagesWithMeta(deps = {}) {
  const cfg = (deps.getRuntimeConfig || getRuntimeConfig)();
  const listSlugsImpl = deps.listSlugs || listSlugs;
  const getAclImpl = deps.getAcl || getAcl;
  const getCategoryImpl = deps.getCategory || getCategory;

  const slugs = await listSlugsImpl(cfg.storagePrefix);
  return Promise.all(
    slugs.map(async (slug) => {
      const [acl, category] = await Promise.all([
        getAclImpl(slug),
        getCategoryImpl(slug)
      ]);
      return {
        slug,
        protected: Boolean(acl && acl.protected),
        allow: (acl && acl.allow) || [],
        category: category || ''
      };
    })
  );
}

module.exports = { listPagesWithMeta };
