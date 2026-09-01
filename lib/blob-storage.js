// Vercel Blob backend for page HTML and mirrored project files.
//
// Blob is the store for everything written from now on. Redis stays the store
// for everything written before the cutover — nothing is migrated, and both are
// read on every request (see lib/storage.js and lib/project-storage.js for the
// Blob-first / Redis-fallback wrappers).
//
// The store is PRIVATE: objects have no public URL and are only reachable
// through `get()` with the read-write token. Every byte therefore still leaves
// the app through our own handlers, so the Google sign-in + allow-list checks
// in api/html.js and lib/project-serve.js remain the only way in. Making this
// store public would hand out permanent unauthenticated URLs and silently
// bypass all page-level access control.
//
// Layout inside the store:
//   <prefix>/<slug>.html          single-file pages  (prefix is "html")
//   asset/<slug>/<name>           images attached to a single-file page
//   projfile/<slug>/<relPath>     mirrored project file trees
//
// Every entry point is guarded: with no BLOB_READ_WRITE_TOKEN configured the
// module reports itself disabled and each call becomes a no-op, so local dev
// and tests fall back to the Redis path instead of failing.

const ACCESS = 'private';

// Resolved lazily so tests (and local runs) can set the token after require.
function blobToken(env = process.env) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  return typeof token === 'string' && token.trim() ? token.trim() : '';
}

function blobEnabled(env = process.env) {
  return Boolean(blobToken(env));
}

// `@vercel/blob` is only pulled in when a token exists, so a deployment without
// the integration never pays the require cost.
let sdk;
function getSdk() {
  if (!sdk) sdk = require('@vercel/blob');
  return sdk;
}

function htmlPathname(prefix, slug) {
  return `${prefix}/${slug}.html`;
}

function projectFilePathname(slug, relPath) {
  return `projfile/${slug}/${relPath}`;
}

function assetPathname(slug, name) {
  return `asset/${slug}/${name}`;
}

// Web ReadableStream -> Buffer.
async function bufferStream(stream) {
  if (!stream) return Buffer.alloc(0);
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// A miss is `null` in current SDKs but older ones threw BlobNotFoundError;
// treat both as "not here" so the caller falls through to Redis.
function isNotFound(error) {
  const name = error && error.name;
  const message = String((error && error.message) || '');
  return name === 'BlobNotFoundError' || /not\s*found/i.test(message);
}

async function readPath(pathname) {
  if (!blobEnabled()) return null;
  try {
    const result = await getSdk().get(pathname, {
      access: ACCESS,
      token: blobToken()
    });
    if (!result) return null;
    return {
      body: await bufferStream(result.stream),
      contentType: (result.blob && result.blob.contentType) || ''
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// `allowOverwrite` is required: re-syncing a Drive folder or re-publishing a
// page writes the same pathname again, and the SDK rejects that by default.
// `addRandomSuffix: false` keeps pathnames derivable from the slug alone.
async function writePath(pathname, body, contentType) {
  if (!blobEnabled()) return false;
  await getSdk().put(pathname, body, {
    access: ACCESS,
    token: blobToken(),
    contentType: contentType || undefined,
    allowOverwrite: true,
    addRandomSuffix: false
  });
  return true;
}

async function deletePath(pathname) {
  if (!blobEnabled()) return false;
  try {
    await getSdk().del(pathname, { token: blobToken() });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// Every object under a prefix with its size and upload time, following
// pagination to the end so a large store never silently truncates a listing.
async function listEntries(prefix) {
  if (!blobEnabled()) return [];
  const { list } = getSdk();
  const entries = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: blobToken() });
    for (const blob of page.blobs || []) {
      entries.push({
        pathname: blob.pathname,
        size: Number(blob.size) || 0,
        uploadedAt: blob.uploadedAt ? new Date(blob.uploadedAt).toISOString() : ''
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return entries;
}

// Just the pathnames, for callers that do not care about size.
async function listPathnames(prefix) {
  return (await listEntries(prefix)).map((entry) => entry.pathname);
}

// --- Page HTML --------------------------------------------------------------

async function saveHtml(prefix, slug, html) {
  return writePath(htmlPathname(prefix, slug), html, 'text/html; charset=utf-8');
}

async function readHtml(prefix, slug) {
  const result = await readPath(htmlPathname(prefix, slug));
  return result ? result.body.toString('utf-8') : null;
}

// Pure: "html/memo.html" -> "memo". Anything that is not a flat <slug>.html
// under the prefix is ignored, so a stray nested object can never masquerade as
// a page slug.
function slugsFromPathnames(prefix, pathnames) {
  const head = `${prefix}/`;
  const slugs = (pathnames || [])
    .filter((p) => typeof p === 'string' && p.startsWith(head))
    .map((p) => p.slice(head.length))
    .filter((name) => name.endsWith('.html'))
    .map((name) => name.slice(0, -'.html'.length))
    .filter((slug) => slug && !slug.includes('/'));
  return Array.from(new Set(slugs)).sort();
}

async function listSlugs(prefix) {
  return slugsFromPathnames(prefix, await listPathnames(`${prefix}/`));
}

async function deleteHtml(prefix, slug) {
  return deletePath(htmlPathname(prefix, slug));
}

// --- Access records ---------------------------------------------------------
//
// ACLs are tiny, but Redis rejects every write once it is at maxmemory, which
// takes access management down exactly when it is needed. Keeping them here
// means restricting or opening a page keeps working regardless of Redis.

function aclPathname(slug) {
  return `acl/${slug}.json`;
}

async function saveAcl(slug, record) {
  return writePath(aclPathname(slug), JSON.stringify(record), 'application/json; charset=utf-8');
}

async function readAcl(slug) {
  const result = await readPath(aclPathname(slug));
  if (!result) return null;
  try {
    return JSON.parse(result.body.toString('utf-8'));
  } catch {
    return null;
  }
}

async function deleteAcl(slug) {
  return deletePath(aclPathname(slug));
}

// Pure: "acl/memo.json" -> "memo".
function aclSlugsFromPathnames(pathnames) {
  const slugs = (pathnames || [])
    .filter((p) => typeof p === 'string' && p.startsWith('acl/') && p.endsWith('.json'))
    .map((p) => p.slice('acl/'.length, -'.json'.length))
    .filter((slug) => slug && !slug.includes('/'));
  return Array.from(new Set(slugs)).sort();
}

// Every slug that has a Blob access record, in ONE request. Callers rendering a
// list use this to decide which slugs are worth a per-slug GET, instead of
// firing a request per page and eating a 404 for every legacy ACL.
async function listAclSlugs() {
  return aclSlugsFromPathnames(await listPathnames('acl/'));
}

// --- Page assets (images attached to a single-file page) --------------------
//
// Kept in their own `asset/<slug>/` namespace rather than under the page's own
// prefix so a listing of pages can never mistake an image for a page, and so
// deleting a page can drop every one of its images with a single prefix
// listing. Like everything else in this store they are PRIVATE: the bytes only
// leave through lib/asset-serve.js, which re-checks the page's ACL per request.

async function saveAsset(slug, name, body, contentType) {
  return writePath(assetPathname(slug, name), body, contentType);
}

async function readAsset(slug, name) {
  return readPath(assetPathname(slug, name));
}

async function deleteAsset(slug, name) {
  return deletePath(assetPathname(slug, name));
}

// Pure: entries under "asset/memo/" -> [{ name: 'chart.png', size, uploadedAt }].
// Anything nested deeper than a flat name is ignored, mirroring the flat
// namespace the upload API enforces.
function assetsFromEntries(slug, entries) {
  const head = `asset/${slug}/`;
  const byName = new Map();
  for (const entry of entries || []) {
    const pathname = entry && entry.pathname;
    if (typeof pathname !== 'string' || !pathname.startsWith(head)) continue;
    const name = pathname.slice(head.length);
    if (!name || name.includes('/')) continue;
    byName.set(name, { name, size: entry.size || 0, uploadedAt: entry.uploadedAt || '' });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function listAssets(slug) {
  return assetsFromEntries(slug, await listEntries(`asset/${slug}/`));
}

// --- Project files ----------------------------------------------------------

async function saveProjectFile(slug, relPath, body, contentType) {
  return writePath(projectFilePathname(slug, relPath), body, contentType);
}

async function readProjectFile(slug, relPath) {
  return readPath(projectFilePathname(slug, relPath));
}

async function deleteProjectFile(slug, relPath) {
  return deletePath(projectFilePathname(slug, relPath));
}

// Pure: "projfile/strategy/assets/a.png" -> "assets/a.png".
function projectPathsFromPathnames(slug, pathnames) {
  const head = `projfile/${slug}/`;
  const paths = (pathnames || [])
    .filter((p) => typeof p === 'string' && p.startsWith(head))
    .map((p) => p.slice(head.length))
    .filter(Boolean);
  return Array.from(new Set(paths)).sort();
}

async function listProjectPaths(slug) {
  return projectPathsFromPathnames(slug, await listPathnames(`projfile/${slug}/`));
}

module.exports = {
  ACCESS,
  blobEnabled,
  blobToken,
  htmlPathname,
  projectFilePathname,
  assetPathname,
  slugsFromPathnames,
  projectPathsFromPathnames,
  saveHtml,
  readHtml,
  deleteHtml,
  listSlugs,
  aclPathname,
  aclSlugsFromPathnames,
  listAclSlugs,
  saveAcl,
  readAcl,
  deleteAcl,
  saveAsset,
  readAsset,
  deleteAsset,
  listAssets,
  assetsFromEntries,
  saveProjectFile,
  readProjectFile,
  deleteProjectFile,
  listProjectPaths,
  deletePath,
  listPathnames,
  listEntries
};
