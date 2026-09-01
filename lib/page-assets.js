// Images attached to a single-file page.
//
// A published page is one self-contained HTML document. Anything it wants to
// show had to be inlined as a data: URI, which bloats the document and is
// impossible to update without republishing the whole thing. Page assets fix
// that: upload the image once, reference it from the HTML by a stable path, and
// republish the page as often as you like without touching the image.
//
//   stored at   asset/<slug>/<name>        (Vercel Blob, private)
//   served at   /<slug>/<name>             (lib/asset-serve.js)
//
// The serving path is the SAME single-segment-plus-path route projects already
// use, so no new route is needed: api/project.js looks for a project first and
// falls back to a page asset when the slug is an ordinary page.
//
// Access is NOT stored per image. Every read re-checks the page's own ACL, so
// an image is exactly as visible as the page it belongs to — restricting the
// page restricts its images in the same instant, with no second list to keep in
// sync.
//
// Blob is the only store. Image bytes in Redis would mean base64 (a third
// larger) sitting in a RAM-priced store that has already been driven to
// maxmemory once; with no Blob token configured, uploads are refused with a
// clear message rather than quietly filling Redis.

const blobStorage = require('./blob-storage');
const { normalizeSlug } = require('./access');
const { getPageDomains } = require('./config');

// Images only. The value is the Content-Type the asset is served with, derived
// from the extension rather than trusted from the uploader.
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp'
};

// Reverse lookup so an upload that supplies a Content-Type but a name without
// an extension still lands on a sensible filename.
const EXTENSION_FOR_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/bmp': 'bmp'
};

// Vercel caps a serverless request body at 4.5 MB, and a base64 JSON upload
// inflates by a third — so 4 MB of raw bytes is the most that can arrive by any
// route. Kept explicit so the error says "too large" instead of the platform
// dropping the request with no explanation.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_STEM_LENGTH = 80;

function extensionOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot === -1 ? '' : String(name).slice(dot + 1).toLowerCase();
}

function extensionForContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXTENSION_FOR_TYPE[type] || '';
}

// Turns whatever the caller passed into a flat, URL-safe filename, or throws.
//
// Any directory component is dropped rather than rejected: an upload named
// "./charts/../q3.png" is a path, not a name, and the store is deliberately one
// flat namespace per page — so it becomes "q3.png". `contentType` is only
// consulted to supply a missing extension.
function normalizeAssetName(input, contentType) {
  const raw = String(input == null ? '' : input).trim();
  const base = raw.split(/[\\/]/).pop().toLowerCase();

  let ext = extensionOf(base);
  let stem = ext ? base.slice(0, -(ext.length + 1)) : base;
  if (!IMAGE_TYPES[ext]) {
    // No usable extension on the name — fall back to the declared type.
    const fromType = extensionForContentType(contentType);
    if (!fromType) {
      throw new Error(
        `Unsupported image type${ext ? ` ".${ext}"` : ''}. Allowed: ${Object.keys(IMAGE_TYPES).join(', ')}.`
      );
    }
    if (ext) stem = base; // ".foo" was part of the name, not an extension
    ext = fromType;
  }

  stem = stem
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, MAX_STEM_LENGTH)
    .replace(/[-._]+$/, '');

  if (!stem) throw new Error('An image name is required.');
  return `${stem}.${ext}`;
}

function contentTypeFor(name) {
  return IMAGE_TYPES[extensionOf(name)] || 'application/octet-stream';
}

// Whether a name is one this module could have written: the flat, cleaned shape
// normalizeAssetName produces. Read and delete paths check it so a request can
// only ever address a name inside the page's own prefix — "..", a slash, or any
// character the writer would have stripped is refused outright rather than
// handed to the store to interpret.
function isValidAssetName(name) {
  const value = String(name || '');
  if (value === '.' || value === '..') return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

// The path a page's HTML references: <img src="/<slug>/<name>">. Absolute
// because the page itself is served from /<slug> (no trailing slash), where a
// relative "chart.png" would resolve to /chart.png.
function assetPath(slug, name) {
  return `/${normalizeSlug(slug)}/${name}`;
}

// Every public address the image resolves to, one per configured page domain —
// same shape as pageUrls() for pages.
function assetUrls(slug, name, env = process.env) {
  const path = assetPath(slug, name);
  return getPageDomains(env).map((domain) => `https://${domain}${path}`);
}

// Decodes an inline upload: a base64 string, a full `data:` URI, or raw bytes
// already in a Buffer. Returns { buffer, contentType } with the type taken from
// a data: URI when the caller did not state one.
function decodeImagePayload({ data, contentType } = {}) {
  if (Buffer.isBuffer(data)) return { buffer: data, contentType: contentType || '' };
  const raw = String(data == null ? '' : data).trim();
  if (!raw) throw new Error('Image data is required.');

  let base64 = raw;
  let type = contentType || '';
  const dataUri = raw.match(/^data:([^;,]+)(;[^,]*)?,(.*)$/s);
  if (dataUri) {
    if (!/;base64/i.test(dataUri[2] || '')) {
      throw new Error('Only base64 data: URIs are supported.');
    }
    type = type || dataUri[1];
    base64 = dataUri[3];
  }

  // Both base64 alphabets are accepted (Buffer decodes either), so a caller
  // that hands over base64url is not rejected for a cosmetic difference.
  base64 = base64.replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64)) {
    throw new Error('Image data must be base64 (or a base64 data: URI).');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Image data decoded to zero bytes.');
  return { buffer, contentType: type };
}

function assertWritable(blob) {
  if (!blob.blobEnabled()) {
    throw new Error(
      'Image uploads require Vercel Blob: set BLOB_READ_WRITE_TOKEN. ' +
      'Images are never stored in Redis.'
    );
  }
}

// Stores one image against a page and returns where it now lives. The page
// itself does not have to exist yet — assets are commonly uploaded first so the
// HTML can be written with the final paths already in it.
async function saveImage(slugInput, nameInput, payload, deps = {}) {
  const blob = deps.blob || blobStorage;
  const slug = normalizeSlug(slugInput);
  if (!slug) throw new Error('A slug is required to upload an image.');
  assertWritable(blob);

  const { buffer, contentType } = Buffer.isBuffer(payload)
    ? { buffer: payload, contentType: '' }
    : decodeImagePayload(payload);

  const name = normalizeAssetName(nameInput, contentType || (payload && payload.contentType));
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${(buffer.length / 1048576).toFixed(2)} MB; the limit is ` +
      `${MAX_IMAGE_BYTES / 1048576} MB. Resize it before uploading.`
    );
  }

  const resolvedType = contentTypeFor(name);
  await blob.saveAsset(slug, name, buffer, resolvedType);
  return {
    slug,
    name,
    size: buffer.length,
    contentType: resolvedType,
    path: assetPath(slug, name),
    urls: assetUrls(slug, name)
  };
}

// Reads one image back as { body: Buffer, contentType } or null when missing.
async function readImage(slugInput, nameInput, deps = {}) {
  const blob = deps.blob || blobStorage;
  const slug = normalizeSlug(slugInput);
  const name = String(nameInput || '').trim().toLowerCase();
  if (!slug || !isValidAssetName(name) || !blob.blobEnabled()) return null;

  const found = await blob.readAsset(slug, name);
  if (!found) return null;
  return { body: found.body, contentType: found.contentType || contentTypeFor(name) };
}

// Every image attached to a page, each with the path and URLs to reference it
// by. One Blob listing, no per-image round trip.
async function listImages(slugInput, deps = {}) {
  const blob = deps.blob || blobStorage;
  const slug = normalizeSlug(slugInput);
  if (!slug || !blob.blobEnabled()) return [];
  const assets = await blob.listAssets(slug);
  return assets.map((asset) => ({
    name: asset.name,
    size: asset.size,
    uploadedAt: asset.uploadedAt,
    contentType: contentTypeFor(asset.name),
    path: assetPath(slug, asset.name),
    urls: assetUrls(slug, asset.name)
  }));
}

async function deleteImage(slugInput, nameInput, deps = {}) {
  const blob = deps.blob || blobStorage;
  const slug = normalizeSlug(slugInput);
  const name = String(nameInput || '').trim().toLowerCase();
  if (!slug || !isValidAssetName(name)) {
    throw new Error('A slug and a valid image name are required.');
  }
  if (!blob.blobEnabled()) return { slug, name, deleted: false };
  const deleted = await blob.deleteAsset(slug, name);
  return { slug, name, deleted: Boolean(deleted) };
}

// Drops every image attached to a page. Called when the page itself is deleted,
// so a removed page never leaves its images reachable.
// --- Publishing a page together with its images -----------------------------
//
// Uploading first and publishing second is two calls and one ordering trap: the
// HTML has to be written with paths that do not exist yet, and a caller that
// forgets the upload publishes a page full of broken images. `attachImages` +
// `linkImagesInHtml` let one publish carry both, with the document's own
// references repointed at wherever each image actually landed.

// Uploads every image in one go and reports where each landed, keeping the name
// the caller used so the HTML rewrite below can find its references.
async function attachImages(slugInput, images, deps = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return [];
  const slug = normalizeSlug(slugInput);

  const uploads = [];
  for (const image of list) {
    if (!image || typeof image !== 'object') {
      throw new Error('Each image must be an object with a name and data.');
    }
    // Sequential rather than parallel: an error then names the image that
    // failed, and a page rarely carries enough images for it to matter.
    const saved = await saveImage(slug, image.name, {
      data: image.data,
      contentType: image.contentType
    }, deps);
    uploads.push({ ...saved, original: String(image.name == null ? '' : image.name) });
  }
  return uploads;
}

// Everything before the last slash is dropped, so "images/chart.png" and
// "./Chart.PNG" both key on "chart.png".
function referenceKey(value) {
  return String(value == null ? '' : value).trim().split('/').pop().toLowerCase();
}

// A value that already addresses something specific — an absolute URL, a
// site-absolute path, a data: URI — is left exactly as the author wrote it.
// Only a plain relative reference is a candidate for rewriting.
function isRewritableReference(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.startsWith('/') || raw.startsWith('#')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(raw);
}

// Attribute values and CSS url() references that can name an image.
const REFERENCE_PATTERNS = [
  /\b(?:src|href|poster|content)\s*=\s*"([^"]*)"/gi,
  /\b(?:src|href|poster|content)\s*=\s*'([^']*)'/gi,
  /url\(\s*"([^"]*)"\s*\)/gi,
  /url\(\s*'([^']*)'\s*\)/gi,
  /url\(\s*([^)'"\s]+)\s*\)/gi
];

// Repoints a document's relative image references at the paths the uploads
// actually got. Matching is by file name, so HTML written against "chart.png"
// keeps working after the store renames it to "q3-chart.png". Already-correct
// paths start with "/" and are skipped, which makes this idempotent: publishing
// the same document twice rewrites nothing the second time.
function linkImagesInHtml(html, uploads) {
  const source = typeof html === 'string' ? html : '';
  const list = Array.isArray(uploads) ? uploads : [];
  if (!source || !list.length) return { html: source, rewritten: 0 };

  const pathByName = new Map();
  for (const upload of list) {
    for (const candidate of [upload.original, upload.name]) {
      const key = referenceKey(candidate);
      if (key) pathByName.set(key, upload.path);
    }
  }

  let rewritten = 0;
  let out = source;
  for (const pattern of REFERENCE_PATTERNS) {
    out = out.replace(pattern, (match, value) => {
      if (!isRewritableReference(value)) return match;
      const target = pathByName.get(referenceKey(value));
      if (!target || target === value) return match;
      rewritten += 1;
      return match.replace(value, target);
    });
  }
  return { html: out, rewritten };
}

async function deleteAllImages(slugInput, deps = {}) {
  const blob = deps.blob || blobStorage;
  const slug = normalizeSlug(slugInput);
  if (!slug || !blob.blobEnabled()) return 0;
  const assets = await blob.listAssets(slug);
  await Promise.all(assets.map((asset) => blob.deleteAsset(slug, asset.name)));
  return assets.length;
}

module.exports = {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  extensionOf,
  extensionForContentType,
  normalizeAssetName,
  isValidAssetName,
  contentTypeFor,
  assetPath,
  assetUrls,
  decodeImagePayload,
  saveImage,
  attachImages,
  referenceKey,
  isRewritableReference,
  linkImagesInHtml,
  readImage,
  listImages,
  deleteImage,
  deleteAllImages
};
