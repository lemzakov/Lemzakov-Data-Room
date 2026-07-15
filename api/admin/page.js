// Admin endpoint to publish a page and/or set its access control.
//
//   GET  /api/admin/page?slug=<slug>     -> read current access record
//   POST /api/admin/page                 -> upsert page html and/or access
//
// Body for POST:
//   {
//     "slug": "investor-deck",          (required)
//     "html": "<!doctype html>...",     (optional: also publish/replace content)
//     "protected": true,                 (optional, default true when allow set)
//     "allow": ["a@x.com", "b@y.com"]   (emails permitted to view)
//   }
//
// Setting "protected": false (or allow: []) makes the page public again.
// Auth: ADMIN_TOKEN (or SYNC_SECRET) via X-Admin-Token header or ?token=.

const { getRuntimeConfig, pageUrls } = require('../../lib/config');
const { saveHtml } = require('../../lib/storage');
const { getAcl, setAcl, normalizeSlug } = require('../../lib/access');
const { getCategory, setPageCategory } = require('../../lib/page-meta');
const { isAdminAuthorized } = require('../../lib/admin');
const { readJsonBody, sendJson } = require('../../lib/http');
const telegram = require('../../lib/telegram');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (!isAdminAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const slug = normalizeSlug(req.query.slug || '');
    if (!slug) return sendJson(res, 400, { ok: false, error: 'Missing slug' });
    const [acl, category] = await Promise.all([getAcl(slug), getCategory(slug)]);
    return sendJson(res, 200, {
      ok: true,
      slug,
      protected: Boolean(acl && acl.protected),
      allow: (acl && acl.allow) || [],
      category: category || ''
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);

  if (!isAdminAuthorized(req, body)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const slug = normalizeSlug(body.slug || '');
  if (!slug) {
    return sendJson(res, 400, { ok: false, error: 'A slug is required' });
  }

  try {
    let published = false;
    if (typeof body.html === 'string' && body.html.length) {
      const { storagePrefix } = getRuntimeConfig();
      await saveHtml(storagePrefix, slug, body.html);
      published = true;
    }

    // Category is optional and orthogonal to access. `undefined` leaves it as
    // is; an empty string clears it.
    let category;
    if (body.category !== undefined) {
      const rec = await setPageCategory(slug, body.category);
      category = rec.category;
    } else {
      category = await getCategory(slug);
    }

    // Only (re)write the ACL when access is actually being set — either the
    // caller passed access fields, or new HTML was published. A category-only
    // edit must NOT silently reset a page's access.
    const hasAccessFields = body.protected !== undefined || body.allow !== undefined;
    let record;
    if (published || hasAccessFields) {
      const allow = Array.isArray(body.allow) ? body.allow : [];
      const isProtected =
        body.protected === undefined ? allow.length > 0 : Boolean(body.protected);
      record = await setAcl(slug, { protected: isProtected, allow });
    } else {
      const acl = await getAcl(slug);
      record = { protected: Boolean(acl && acl.protected), allow: (acl && acl.allow) || [] };
    }

    // Notify the owner (Telegram) whenever page content is (re)published, with
    // every public address it now resolves to. Best-effort — never blocks.
    if (published) {
      await telegram.notifyPagePublished({
        slug,
        urls: pageUrls(slug),
        protected: record.protected,
        category
      });
    }

    return sendJson(res, 200, {
      ok: true,
      slug,
      published,
      protected: record.protected,
      allow: record.allow,
      category,
      note: record.protected
        ? 'Restricted: visitors sign in with Google; approved emails get in, others can Request access (approved by you in Telegram). Sessions last ~6 months.'
        : 'Page is public.'
    });
  } catch (error) {
    console.error('[admin/page] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
