// Admin endpoint for the images attached to a single-file page.
//
//   GET    /api/admin/asset?slug=<slug>              -> list a page's images
//   POST   /api/admin/asset                          -> upload/replace one image
//   DELETE /api/admin/asset?slug=<slug>&name=<name>  -> remove one image
//
// Two upload shapes, because the two callers want different things:
//
//   JSON   { "slug": "memo", "name": "chart.png", "data": "<base64 | data: URI>" }
//          — what an MCP client or a script that already holds the bytes sends.
//
//   Raw    POST /api/admin/asset?slug=memo&name=chart.png
//          Content-Type: image/png   + the file's bytes as the body
//          — no base64 inflation, which matters against the 4.5 MB request cap.
//
// Either way the response carries the path to reference the image by
// (/<slug>/<name>) and the full URL on every configured domain, so the caller
// can drop it straight into the page's HTML.
//
// Uploading an image does NOT touch the page's access record: an image is
// served under the page's own ACL, so a restricted page's images are restricted
// the moment the page is.
//
// Auth: ADMIN_TOKEN (or SYNC_SECRET) via X-Admin-Token header or ?token=.

const {
  saveImage, listImages, deleteImage, MAX_IMAGE_BYTES
} = require('../../lib/page-assets');
const { normalizeSlug } = require('../../lib/access');
const { isAdminAuthorized } = require('../../lib/admin');
const { readJsonBody, readRawBody, sendJson } = require('../../lib/http');

function isJsonRequest(req) {
  return /application\/json/i.test(String(req.headers['content-type'] || ''));
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (!isAdminAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const slug = normalizeSlug(req.query.slug || '');
    if (!slug) return sendJson(res, 400, { ok: false, error: 'Missing slug' });
    try {
      const images = await listImages(slug);
      return sendJson(res, 200, { ok: true, slug, images });
    } catch (error) {
      console.error('[admin/asset] list failed', { slug, message: error.message });
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'DELETE') {
    if (!isAdminAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const slug = normalizeSlug(req.query.slug || '');
    const name = String(req.query.name || '').trim().toLowerCase();
    if (!slug || !name) {
      return sendJson(res, 400, { ok: false, error: 'Both slug and name are required' });
    }
    try {
      const result = await deleteImage(slug, name);
      if (!result.deleted) {
        return sendJson(res, 404, { ok: false, error: `No image named "${name}" on "${slug}"` });
      }
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error('[admin/asset] delete failed', { slug, name, message: error.message });
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  // The raw shape carries image bytes, so the body can never hold a token —
  // it has to arrive in a header or the query string. Read it only after the
  // caller is authorized, so an unauthenticated request cannot make us buffer
  // megabytes first.
  const json = isJsonRequest(req) ? await readJsonBody(req) : null;
  if (!isAdminAuthorized(req, json || {})) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    let slug;
    let name;
    let payload;

    if (json) {
      slug = normalizeSlug(json.slug || '');
      name = json.name || json.filename || '';
      payload = { data: json.data !== undefined ? json.data : json.base64, contentType: json.contentType };
    } else {
      slug = normalizeSlug(req.query.slug || '');
      name = String(req.query.name || '');
      const contentType = String(req.headers['content-type'] || '');
      const body = await readRawBody(req);
      if (!body.length) {
        return sendJson(res, 400, { ok: false, error: 'Empty request body' });
      }
      if (body.length > MAX_IMAGE_BYTES) {
        return sendJson(res, 413, {
          ok: false,
          error: `Image is ${(body.length / 1048576).toFixed(2)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB.`
        });
      }
      payload = { data: body, contentType };
    }

    if (!slug) return sendJson(res, 400, { ok: false, error: 'A slug is required' });
    if (!name) return sendJson(res, 400, { ok: false, error: 'An image name is required' });

    const result = await saveImage(slug, name, payload);
    console.log('[admin/asset] uploaded', { slug: result.slug, name: result.name, size: result.size });
    return sendJson(res, 200, {
      ok: true,
      ...result,
      note: `Reference it from the page HTML as <img src="${result.path}">.`
    });
  } catch (error) {
    console.error('[admin/asset] upload failed', { message: error.message });
    return sendJson(res, 400, { ok: false, error: error.message });
  }
};
