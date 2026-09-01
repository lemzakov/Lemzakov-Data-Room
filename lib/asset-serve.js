// Serves an image attached to a single-file page, at /<slug>/<name>.
//
// Reached from api/project.js, which checks for a project first and falls back
// here when the slug is an ordinary page. That reuses the existing
// /([^/]+)/(.*) route, so an image needs no route of its own and the page's own
// URL space stays the one namespace to reason about.
//
// The Blob store is private, so these bytes have no public URL of their own and
// every request comes through here. Access is re-derived from the PAGE's ACL on
// each request — there is no per-image access record to drift out of sync:
//
//   public page      -> anyone with the link, briefly cacheable
//   restricted page  -> Google sign-in + allow list, never cached
//
// An unauthorized request is redirected exactly the way the page itself is, so
// opening an image URL directly walks the visitor through sign-in; inside an
// <img> the redirect simply yields a broken image, which is the correct outcome
// for someone who cannot see the page either.

const pageAssets = require('./page-assets');
const { isValidAssetName } = pageAssets;
const { getAcl, isAllowed } = require('./access');
const { getSessionFromRequest } = require('./session');

// Public images are cacheable, but only briefly: re-uploading under the same
// name is the supported way to update an image, and a long TTL would leave
// stale bytes in front of the new ones.
const PUBLIC_CACHE = 'public, max-age=300';

// True when the path could name an image in a page's flat asset namespace —
// which means the exact shape an upload produces, nothing looser.
function isAssetName(relPath) {
  return isValidAssetName(String(relPath || ''));
}

// Returns true when it has answered the request, false when the path names no
// image on this page — the caller then decides what a miss means.
async function servePageAsset(req, res, options = {}) {
  const {
    slug,
    relPath,
    assets = pageAssets,
    readAcl = getAcl,
    readSession = getSessionFromRequest
  } = options;
  // A percent-encoded name is decoded first; if decoding reveals a slash the
  // path is not a flat asset name and this declines it, as it would any other
  // nested path.
  let name = String(relPath || '').trim().toLowerCase();
  try { name = decodeURIComponent(name); } catch {}
  if (!isAssetName(name)) return false;

  const image = await assets.readImage(slug, name);
  if (!image) return false;

  // Access mirrors the page, resolved after the lookup so a miss costs nothing.
  const acl = await readAcl(slug);
  if (acl && acl.protected) {
    const current = await readSession(req);
    const email = current && current.session && current.session.email;
    if (!isAllowed(email, acl)) {
      res.statusCode = 302;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Location',
        email
          ? `/request-access?slug=${encodeURIComponent(slug)}`
          : `/api/auth/google/start?next=${encodeURIComponent('/' + slug)}`
      );
      res.end();
      return true;
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Content-Length', String(image.body.length));
  // The stored type is derived from the extension, never sniffed from the
  // bytes; tell the browser not to sniff either.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    acl && acl.protected ? 'private, no-store' : PUBLIC_CACHE
  );
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(image.body);
  return true;
}

module.exports = { PUBLIC_CACHE, isAssetName, servePageAsset };
