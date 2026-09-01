// Admin endpoint to publish a page and/or set its access control.
//
//   GET    /api/admin/page?slug=<slug>   -> read current access record
//   POST   /api/admin/page               -> upsert page html and/or access
//   DELETE /api/admin/page?slug=<slug>   -> permanently remove the page
//
// Body for POST:
//   {
//     "slug": "investor-deck",          (required)
//     "html": "<!doctype html>...",     (optional: also publish/replace content)
//     "images": [                        (optional: publish the page WITH its images)
//       { "name": "chart.png", "data": "<base64 | data: URI>" }
//     ],
//     "protected": true,                 (optional, default true when allow set)
//     "allow": ["a@x.com", "b@y.com"]   (emails permitted to view)
//   }
//
// Images are stored first, then the HTML's own relative references to them are
// repointed at the paths they landed on — so a document written against
// `<img src="chart.png">` publishes correctly in ONE call, with no need to know
// the final path in advance.
//
// Setting "protected": false (or allow: []) makes the page public again.
// Auth: ADMIN_TOKEN (or SYNC_SECRET) via X-Admin-Token header or ?token=.

const { getRuntimeConfig, pageUrls } = require('../../lib/config');
const { saveHtml } = require('../../lib/storage');
const { getAcl, setAcl, resolveAccessForPublish, normalizeSlug } = require('../../lib/access');
const { getCategory, setPageCategory } = require('../../lib/page-meta');
const { attachImages, linkImagesInHtml } = require('../../lib/page-assets');
const { deletePage, pageExists } = require('../../lib/page-delete');
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

  // Deleting is the one admin action that reclaims storage rather than
  // consuming it, so it keeps working while Redis is at maxmemory: DEL and SREM
  // are not denyoom commands.
  if (req.method === 'DELETE') {
    if (!isAdminAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const slug = normalizeSlug(req.query.slug || '');
    if (!slug) return sendJson(res, 400, { ok: false, error: 'Missing slug' });

    try {
      if (!(await pageExists(slug))) {
        return sendJson(res, 404, { ok: false, error: `No page named "${slug}"` });
      }
      const result = await deletePage(slug);
      console.log('[admin/page] deleted', result);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error('[admin/page] delete failed', { slug, message: error.message });
      return sendJson(res, 500, { ok: false, error: error.message });
    }
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

  // Images go in before the HTML: if one fails, the page is not left live
  // pointing at an image that never arrived. A rejected image is almost always
  // the caller's (wrong format, too large, no data), so it answers 400 with the
  // reason rather than a bare 500.
  let uploads;
  try {
    uploads = await attachImages(slug, body.images);
  } catch (error) {
    console.error('[admin/page] image upload failed', { slug, message: error.message });
    return sendJson(res, 400, { ok: false, error: error.message });
  }

  try {

    let published = false;
    let imagesLinked = 0;
    if (typeof body.html === 'string' && body.html.length) {
      const linked = linkImagesInHtml(body.html, uploads);
      imagesLinked = linked.rewritten;
      const { storagePrefix } = getRuntimeConfig();
      await saveHtml(storagePrefix, slug, linked.html);
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
      // Publishing alone must not change who can see the page — with no access
      // fields the current record is preserved rather than reset to public.
      const wanted = await resolveAccessForPublish(slug, {
        isProtected: body.protected === undefined ? undefined : Boolean(body.protected),
        allow: Array.isArray(body.allow) ? body.allow : [],
        allowProvided: body.allow !== undefined
      });
      record = await setAcl(slug, wanted);
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
      images: uploads.map(({ name, path, urls, size, contentType }) => ({
        name, path, urls, size, contentType
      })),
      imagesLinked,
      note: record.protected
        ? 'Restricted: visitors sign in with Google; approved emails get in, others can Request access (approved by you in Telegram). Sessions last ~6 months.'
        : 'Page is public.'
    });
  } catch (error) {
    console.error('[admin/page] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
