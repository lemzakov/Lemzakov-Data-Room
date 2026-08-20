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

// Every pathname under a prefix, following pagination to the end so a large
// store never silently truncates a listing.
async function listPathnames(prefix) {
  if (!blobEnabled()) return [];
  const { list } = getSdk();
  const pathnames = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: blobToken() });
    for (const blob of page.blobs || []) pathnames.push(blob.pathname);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return pathnames;
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
  slugsFromPathnames,
  projectPathsFromPathnames,
  saveHtml,
  readHtml,
  deleteHtml,
  listSlugs,
  aclPathname,
  saveAcl,
  readAcl,
  deleteAcl,
  saveProjectFile,
  readProjectFile,
  deleteProjectFile,
  listProjectPaths,
  deletePath,
  listPathnames
};
