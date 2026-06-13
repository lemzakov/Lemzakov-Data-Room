// Admin endpoint to list every stored page and its current access state.
//
//   GET /api/admin/pages   -> { ok, pages: [{ slug, protected, allow }] }
//
// Auth: ADMIN_TOKEN (or SYNC_SECRET) via X-Admin-Token header or ?token=.
// Backs the /admin dashboard, which renders the list and lets you flip a page
// between public and restricted (via POST /api/admin/page).

const { getRuntimeConfig } = require('../../lib/config');
const { listSlugs } = require('../../lib/storage');
const { getAcl } = require('../../lib/access');
const { isAdminAuthorized } = require('../../lib/admin');
const { sendJson } = require('../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  if (!isAdminAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const { storagePrefix } = getRuntimeConfig();
    const slugs = await listSlugs(storagePrefix);

    const pages = await Promise.all(
      slugs.map(async (slug) => {
        const acl = await getAcl(slug);
        return {
          slug,
          protected: Boolean(acl && acl.protected),
          allow: (acl && acl.allow) || []
        };
      })
    );

    return sendJson(res, 200, { ok: true, pages });
  } catch (error) {
    console.error('[admin/pages] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
