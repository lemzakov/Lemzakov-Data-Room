// Mirrored project file tree, stored in Vercel Blob (new) and Redis (legacy).
//
// Files synced before the Blob cutover live in Redis at
//   projfile:<slug>:<relPath>
// as a JSON envelope { contentType, b64 } — the bytes base64-encoded, which
// costs ~33% extra on a RAM-priced store. Everything synced from now on goes to
// Blob at projfile/<slug>/<relPath> as raw bytes instead. Nothing is migrated:
// reads consult both stores, so a project part-way through a resync serves a
// mix without the visitor noticing.
//
// Either way the <relPath> mirrors the Drive folder structure EXACTLY (forward
// slashes, no leading slash) so relative cross-links between HTML files resolve
// unchanged, and every byte is still served through lib/project-serve.js behind
// Google sign-in + project membership — the Blob store is private and has no
// publicly reachable URL.

const { kvGetJson, kvSetJson, kvDel, scanKeys } = require('./storage');
const blobStorage = require('./blob-storage');

const FILE_PREFIX = 'projfile';

function fileKey(slug, relPath) {
  return `${FILE_PREFIX}:${slug}:${relPath}`;
}

// Maps a path's extension to a Content-Type. Covers the static assets a static
// site bundle uses (html/css/js, images, fonts, json). Unknown types fall back
// to application/octet-stream.
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav'
};

function extensionOf(relPath) {
  const name = String(relPath || '').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function contentTypeFor(relPath, fallback) {
  const ext = extensionOf(relPath);
  return CONTENT_TYPES[ext] || fallback || 'application/octet-stream';
}

// Stores one file. `content` may be a Buffer (assets) or a string (rewritten
// HTML). contentType is resolved from the extension unless provided. New writes
// go to Blob as raw bytes; without a Blob token this falls back to the legacy
// base64-in-Redis envelope so local dev keeps working.
async function saveProjectFile(slug, relPath, content, contentType, deps = {}) {
  const blob = deps.blob || blobStorage;
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8');
  const resolvedType = contentType || contentTypeFor(relPath);

  if (blob.blobEnabled()) {
    await blob.saveProjectFile(slug, relPath, buffer, resolvedType);
    return;
  }
  await kvSetJson(fileKey(slug, relPath), {
    contentType: resolvedType,
    b64: buffer.toString('base64')
  });
}

async function readRedisProjectFile(slug, relPath) {
  const record = await kvGetJson(fileKey(slug, relPath));
  if (!record || typeof record.b64 !== 'string') return null;
  return {
    contentType: record.contentType || contentTypeFor(relPath),
    body: Buffer.from(record.b64, 'base64')
  };
}

// Reads one file back as { contentType, body: Buffer } or null if missing.
// Queries both stores concurrently so a legacy Redis-only asset does not pay a
// Blob round-trip first; Blob wins when a path exists in both.
async function readProjectFile(slug, relPath, deps = {}) {
  const blob = deps.blob || blobStorage;
  const readRedis = deps.readRedisProjectFile || readRedisProjectFile;
  if (!blob.blobEnabled()) return readRedis(slug, relPath);

  const [fromBlob, fromRedis] = await Promise.all([
    blob.readProjectFile(slug, relPath),
    readRedis(slug, relPath).catch(() => null)
  ]);
  if (!fromBlob) return fromRedis;
  return {
    contentType: fromBlob.contentType || contentTypeFor(relPath),
    body: fromBlob.body
  };
}

// Removes a path from BOTH stores — a file deleted upstream in Drive must stop
// serving regardless of which store it happened to land in.
async function deleteProjectFile(slug, relPath, deps = {}) {
  const blob = deps.blob || blobStorage;
  const del = deps.kvDel || kvDel;
  await Promise.all([
    del(fileKey(slug, relPath)),
    blob.blobEnabled() ? blob.deleteProjectFile(slug, relPath) : Promise.resolve(false)
  ]);
}

// Lists every stored relative path for a project (bare, prefix stripped),
// unioned across both stores.
async function listProjectPaths(slug, deps = {}) {
  const blob = deps.blob || blobStorage;
  const prefix = `${FILE_PREFIX}:${slug}:`;
  const [redisKeys, blobPaths] = await Promise.all([
    scanKeys(`${prefix}*`),
    blob.blobEnabled() ? blob.listProjectPaths(slug) : Promise.resolve([])
  ]);
  const redisPaths = redisKeys.map((k) => k.slice(prefix.length));
  return Array.from(new Set([...blobPaths, ...redisPaths])).sort();
}

// Removes every stored file for a project (used on delete / before a full
// resync prune). Returns the number of files removed.
async function deleteAllProjectFiles(slug) {
  const paths = await listProjectPaths(slug);
  await Promise.all(paths.map((relPath) => deleteProjectFile(slug, relPath)));
  return paths.length;
}

module.exports = {
  FILE_PREFIX,
  CONTENT_TYPES,
  extensionOf,
  contentTypeFor,
  saveProjectFile,
  readProjectFile,
  readRedisProjectFile,
  deleteProjectFile,
  listProjectPaths,
  deleteAllProjectFiles
};
