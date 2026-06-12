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

const { getRuntimeConfig } = require('../../lib/config');
const { saveHtml } = require('../../lib/storage');
const { getAcl, setAcl, normalizeSlug } = require('../../lib/access');
const { isAdminAuthorized } = require('../../lib/admin');
const { readJsonBody, sendJson } = require('../../lib/http');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (!isAdminAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const slug = normalizeSlug(req.query.slug || '');
    if (!slug) return sendJson(res, 400, { ok: false, error: 'Missing slug' });
    const acl = await getAcl(slug);
    return sendJson(res, 200, {
      ok: true,
      slug,
      protected: Boolean(acl && acl.protected),
      allow: (acl && acl.allow) || []
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

    const allow = Array.isArray(body.allow) ? body.allow : [];
    const isProtected =
      body.protected === undefined ? allow.length > 0 : Boolean(body.protected);

    const record = await setAcl(slug, { protected: isProtected, allow });

    return sendJson(res, 200, {
      ok: true,
      slug,
      published,
      protected: record.protected,
      allow: record.allow,
      note: record.protected
        ? 'Allowed users verify their email (one-time code) on first visit, then register a passkey. Sessions last ~6 months.'
        : 'Page is public.'
    });
  } catch (error) {
    console.error('[admin/page] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
