// Mirrored project file tree, stored in Redis.
//
// Each file synced from a project's Drive folder is stored at
//   projfile:<slug>:<relPath>
// as a small JSON envelope: { contentType, b64 } where b64 is the file bytes
// base64-encoded (uniform handling of text and binary assets). The <relPath>
// mirrors the Drive folder structure EXACTLY (forward slashes, no leading
// slash) so relative cross-links between HTML files resolve unchanged.

const { kvGetJson, kvSetJson, kvDel, scanKeys } = require('./storage');

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
// HTML). contentType is resolved from the extension unless provided.
async function saveProjectFile(slug, relPath, content, contentType) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf-8');
  await kvSetJson(fileKey(slug, relPath), {
    contentType: contentType || contentTypeFor(relPath),
    b64: buffer.toString('base64')
  });
}

// Reads one file back as { contentType, body: Buffer } or null if missing.
async function readProjectFile(slug, relPath) {
  const record = await kvGetJson(fileKey(slug, relPath));
  if (!record || typeof record.b64 !== 'string') return null;
  return {
    contentType: record.contentType || contentTypeFor(relPath),
    body: Buffer.from(record.b64, 'base64')
  };
}

async function deleteProjectFile(slug, relPath) {
  await kvDel(fileKey(slug, relPath));
}

// Lists every stored relative path for a project (bare, prefix stripped).
async function listProjectPaths(slug) {
  const prefix = `${FILE_PREFIX}:${slug}:`;
  const keys = await scanKeys(`${prefix}*`);
  return keys.map((k) => k.slice(prefix.length)).sort();
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
  deleteProjectFile,
  listProjectPaths,
  deleteAllProjectFiles
};
