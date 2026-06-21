const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidSlugFormat, isReservedSlug, isProjectMember,
  cleanEmailList, normalizeDomain, isValidDomain
} = require('../lib/projects');

const {
  isFolder, isGoogleNative, isSyncableFile, isHtmlPath,
  buildListUrl, buildDownloadUrl, rewriteRootRelativeLinks,
  resolveEntryPath, listFolderRecursive, runProjectSync
} = require('../lib/project-sync');

const { normalizeRelPath } = require('../lib/project-serve');
const { contentTypeFor } = require('../lib/project-storage');

// --- slug + access helpers ---------------------------------------------------

test('isValidSlugFormat accepts url-safe slugs and rejects junk', () => {
  assert.equal(isValidSlugFormat('strategy'), true);
  assert.equal(isValidSlugFormat('marketing-2025'), true);
  assert.equal(isValidSlugFormat('a'), true);
  assert.equal(isValidSlugFormat('-bad'), false);
  assert.equal(isValidSlugFormat('bad-'), false);
  assert.equal(isValidSlugFormat('Bad'), false);
  assert.equal(isValidSlugFormat('has space'), false);
  assert.equal(isValidSlugFormat('a/b'), false);
});

test('reserved slugs are rejected', () => {
  assert.equal(isReservedSlug('admin'), true);
  assert.equal(isReservedSlug('api'), true);
  assert.equal(isReservedSlug('strategy'), false);
});

test('isProjectMember honours explicit emails and allowed domain', () => {
  const project = { allowedEmails: ['alice@x.com'], allowedDomain: 'mycompany.com' };
  assert.equal(isProjectMember('alice@x.com', project), true);
  assert.equal(isProjectMember('ALICE@x.com', project), true);
  assert.equal(isProjectMember('bob@mycompany.com', project), true);
  assert.equal(isProjectMember('bob@other.com', project), false);
  assert.equal(isProjectMember('', project), false);
  assert.equal(isProjectMember('a@b.com', { allowedEmails: [], allowedDomain: '' }), false);
});

test('cleanEmailList dedupes, normalizes and drops junk', () => {
  assert.deepEqual(cleanEmailList(['A@b.com', 'a@b.com ', 'nope', '']), ['a@b.com']);
});

test('domain normalization + validation', () => {
  assert.equal(normalizeDomain('@MyCompany.com'), 'mycompany.com');
  assert.equal(isValidDomain('mycompany.com'), true);
  assert.equal(isValidDomain(''), true);
  assert.equal(isValidDomain('not a domain'), false);
});

// --- Drive classification ----------------------------------------------------

test('classifies folders, google-native docs and syncable assets', () => {
  assert.equal(isFolder('application/vnd.google-apps.folder'), true);
  assert.equal(isGoogleNative('application/vnd.google-apps.document'), true);
  assert.equal(isGoogleNative('application/vnd.google-apps.folder'), false);
  assert.equal(isSyncableFile({ name: 'page.html', mimeType: 'text/html' }), true);
  assert.equal(isSyncableFile({ name: 'logo.png', mimeType: 'image/png' }), true);
  assert.equal(isSyncableFile({ name: 'style.css', mimeType: 'text/css' }), true);
  assert.equal(isSyncableFile({ name: 'notes', mimeType: 'application/vnd.google-apps.document' }), false);
  assert.equal(isSyncableFile({ name: 'data.bin', mimeType: 'application/octet-stream' }), false);
});

test('contentTypeFor maps extensions', () => {
  assert.equal(contentTypeFor('a/b/page.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('logo.PNG'), 'image/png');
  assert.equal(contentTypeFor('unknown.xyz'), 'application/octet-stream');
});

test('isHtmlPath detects .html/.htm', () => {
  assert.equal(isHtmlPath('index.html'), true);
  assert.equal(isHtmlPath('a/b.HTM'), true);
  assert.equal(isHtmlPath('style.css'), false);
});

// --- URL builders ------------------------------------------------------------

test('service-account list URL has no api key and supports shared drives', () => {
  const url = buildListUrl('FOLDER', { mode: 'serviceAccount', accessToken: 't' });
  assert.match(url, /supportsAllDrives=true/);
  assert.match(url, /includeItemsFromAllDrives=true/);
  assert.ok(!/[?&]key=/.test(url));
  assert.match(url, /modifiedTime/);
});

test('api-key URLs append the key', () => {
  assert.match(buildListUrl('F', { apiKey: 'K' }), /[?&]key=K/);
  assert.match(buildDownloadUrl('F', { apiKey: 'K' }), /alt=media/);
  assert.match(buildDownloadUrl('F', { apiKey: 'K' }), /[?&]key=K/);
});

// --- link rewriting ----------------------------------------------------------

test('rewriteRootRelativeLinks only touches root-relative links', () => {
  const html = [
    '<a href="/about.html">a</a>',
    '<a href="./page2.html">b</a>',
    '<a href="../up.html">c</a>',
    '<img src="/img/logo.png">',
    '<a href="https://x.com/foo">d</a>',
    '<a href="//cdn.com/x">e</a>',
    '<style>.x{background:url(/bg.png)}</style>'
  ].join('\n');
  const out = rewriteRootRelativeLinks(html, 'strategy');
  assert.match(out, /href="\/strategy\/about\.html"/);
  assert.match(out, /href="\.\/page2\.html"/);     // untouched
  assert.match(out, /href="\.\.\/up\.html"/);       // untouched
  assert.match(out, /src="\/strategy\/img\/logo\.png"/);
  assert.match(out, /href="https:\/\/x\.com\/foo"/); // untouched
  assert.match(out, /href="\/\/cdn\.com\/x"/);       // untouched
  assert.match(out, /url\(\/strategy\/bg\.png\)/);
});

test('rewriteRootRelativeLinks does not double-prefix', () => {
  const out = rewriteRootRelativeLinks('<a href="/strategy/x.html">x</a>', 'strategy');
  assert.match(out, /href="\/strategy\/x\.html"/);
  assert.ok(!out.includes('/strategy/strategy/'));
});

// --- entry point resolution --------------------------------------------------

test('resolveEntryPath prefers index.html, then configured, then first html', () => {
  assert.equal(resolveEntryPath(['a.html', 'index.html', 'b.html']), 'index.html');
  assert.equal(resolveEntryPath(['a.html', 'home.html'], 'home.html'), 'home.html');
  assert.equal(resolveEntryPath(['b.html', 'a.html']), 'a.html');
  assert.equal(resolveEntryPath(['z.css', 'a.png']), 'a.png');
  assert.equal(resolveEntryPath([]), null);
});

// --- path normalization (traversal guard) ------------------------------------

test('normalizeRelPath strips slashes and blocks traversal', () => {
  assert.equal(normalizeRelPath(''), '');
  assert.equal(normalizeRelPath('/'), '');
  assert.equal(normalizeRelPath('sub/page.html'), 'sub/page.html');
  assert.equal(normalizeRelPath('/sub/page.html/'), 'sub/page.html');
  assert.equal(normalizeRelPath('a/../../etc/passwd'), null);
});

// --- recursive listing -------------------------------------------------------

function fakeDrive(tree) {
  // tree: { folderId: [ {id,name,mimeType,modifiedTime} ] }
  return async (url) => {
    if (url.includes('/drive/v3/files?q=')) {
      const m = decodeURIComponent(url).match(/'([^']+)' in parents/);
      const folderId = m ? m[1] : '';
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ files: tree[folderId] || [] }) };
    }
    // download
    const idMatch = url.match(/\/drive\/v3\/files\/([^?]+)\?alt=media/);
    const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
    return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => Buffer.from('content:' + id) };
  };
}

const TREE = {
  root: [
    { id: 'f-index', name: 'index.html', mimeType: 'text/html', modifiedTime: '2024-01-01T00:00:00Z' },
    { id: 'f-sub', name: 'sub', mimeType: 'application/vnd.google-apps.folder' },
    { id: 'f-doc', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
    { id: 'f-img', name: 'logo.png', mimeType: 'image/png', modifiedTime: '2024-01-01T00:00:00Z' }
  ],
  'f-sub': [
    { id: 'f-page', name: 'page.html', mimeType: 'text/html', modifiedTime: '2024-01-01T00:00:00Z' }
  ]
};

test('listFolderRecursive walks subfolders and reports skipped items', async () => {
  const auth = { mode: 'serviceAccount', accessToken: 't' };
  const { files, skipped } = await listFolderRecursive('root', auth, {
    fetchImpl: fakeDrive(TREE), logger: { log() {}, error() {} }
  });
  const paths = files.map((f) => f.relPath).sort();
  assert.deepEqual(paths, ['index.html', 'logo.png', 'sub/page.html']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'google-native');
});

// --- end-to-end sync (incremental) -------------------------------------------

function memoryBackend(project) {
  const files = new Map();
  const saved = [];
  const store = {
    saveProjectFile: async (slug, rel, content) => { files.set(rel, content); },
    deleteProjectFile: async (slug, rel) => { files.delete(rel); },
    listProjectPaths: async () => Array.from(files.keys()).sort()
  };
  const repo = {
    getProject: async () => project,
    saveProject: async (p) => { project = p; saved.push(p); return p; },
    appendLog: async () => {}
  };
  return { store, repo, files, get project() { return project; }, saved };
}

test('runProjectSync force downloads everything and resolves the entry', async () => {
  const backend = memoryBackend({
    slug: 'strategy', driveFolderId: 'root', entryFile: '', fileManifest: {}
  });
  const auth = { mode: 'serviceAccount', accessToken: 't' };

  const result = await runProjectSync('strategy', {
    force: true, auth, fetchImpl: fakeDrive(TREE),
    logger: { log() {}, error() {} }, store: backend.store, repo: backend.repo
  });

  assert.equal(result.downloaded, 3);
  assert.equal(result.unchanged, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.entryPath, 'index.html');
  assert.deepEqual(Array.from(backend.files.keys()).sort(), ['index.html', 'logo.png', 'sub/page.html']);
  // HTML is stored rewritten (string); asset stored as Buffer.
  assert.equal(typeof backend.files.get('index.html'), 'string');
  assert.ok(Buffer.isBuffer(backend.files.get('logo.png')));
  assert.equal(backend.project.fileCount, 3);
  assert.equal(backend.project.status, 'ok');
});

test('runProjectSync incremental skips unchanged files and re-downloads changed ones', async () => {
  // Manifest reflects a previous full sync (all modifiedTimes match TREE).
  const manifest = { 'index.html': '2024-01-01T00:00:00Z', 'logo.png': '2024-01-01T00:00:00Z', 'sub/page.html': '2024-01-01T00:00:00Z' };
  const backend = memoryBackend({ slug: 'strategy', driveFolderId: 'root', entryFile: '', fileManifest: manifest });
  const auth = { mode: 'serviceAccount', accessToken: 't' };

  const noop = { log() {}, error() {} };
  const r1 = await runProjectSync('strategy', { force: false, auth, fetchImpl: fakeDrive(TREE), logger: noop, store: backend.store, repo: backend.repo });
  assert.equal(r1.downloaded, 0);
  assert.equal(r1.unchanged, 3);

  // Bump one file's modifiedTime in Drive -> only that file re-downloads.
  const changed = JSON.parse(JSON.stringify(TREE));
  changed.root[0].modifiedTime = '2024-06-01T00:00:00Z';
  const r2 = await runProjectSync('strategy', { force: false, auth, fetchImpl: fakeDrive(changed), logger: noop, store: backend.store, repo: backend.repo });
  assert.equal(r2.downloaded, 1);
  assert.equal(r2.unchanged, 2);
});

test('runProjectSync prunes files removed from Drive', async () => {
  const manifest = { 'index.html': '2024-01-01T00:00:00Z', 'logo.png': '2024-01-01T00:00:00Z', 'sub/page.html': '2024-01-01T00:00:00Z', 'old.html': '2023-01-01T00:00:00Z' };
  const backend = memoryBackend({ slug: 'strategy', driveFolderId: 'root', entryFile: '', fileManifest: manifest });
  backend.files.set('old.html', 'stale');
  const auth = { mode: 'serviceAccount', accessToken: 't' };

  const r = await runProjectSync('strategy', {
    force: false, auth, fetchImpl: fakeDrive(TREE),
    logger: { log() {}, error() {} }, store: backend.store, repo: backend.repo
  });
  assert.equal(r.removed, 1);
  assert.ok(!backend.files.has('old.html'));
});
