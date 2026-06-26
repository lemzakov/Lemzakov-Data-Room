// Recursive, incremental Google Drive → Redis sync for project portals.
//
// Authenticates with the SAME service account used by the single-file sync
// (lib/google-auth.js). The project's Drive folder is PRIVATE: it must be
// shared with the service account's client_email — no public sharing. We walk
// the folder tree, mirror every .html file and static asset under
// `projfile:<slug>:<relPath>` (structure preserved so cross-links resolve), and
// only re-download files whose Drive modifiedTime changed since the last sync
// (a "force" option ignores the manifest for a full resync).

const { config } = require('./config');
const { parseServiceAccount, getAccessToken } = require('./google-auth');
const projectStorage = require('./project-storage');
const projects = require('./projects');
const { contentTypeFor, extensionOf } = projectStorage;

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

class ProjectSyncError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProjectSyncError';
    this.details = details;
  }
}

function isFolder(mimeType) {
  return mimeType === FOLDER_MIME;
}

// Google-native docs (Docs/Sheets/Slides/Forms/...) have no real bytes to serve
// via alt=media, so they are skipped. Folders are handled separately.
function isGoogleNative(mimeType) {
  return typeof mimeType === 'string'
    && mimeType.startsWith('application/vnd.google-apps.')
    && mimeType !== FOLDER_MIME;
}

// A file is syncable if it is a real .html page or a known static asset (by
// extension). This excludes Google-native types and arbitrary unknown blobs,
// matching "only take real .html and static assets like images/css/js".
function isSyncableFile(file) {
  if (!file || isFolder(file.mimeType) || isGoogleNative(file.mimeType)) return false;
  if ((file.mimeType || '').toLowerCase() === 'text/html') return true;
  const ext = extensionOf(file.name);
  return Boolean(ext) && Object.prototype.hasOwnProperty.call(projectStorage.CONTENT_TYPES, ext);
}

function isHtmlPath(relPath) {
  return /\.html?$/i.test(relPath || '');
}

function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

// Resolves auth for project sync. Service account is strongly preferred (and
// required for private folders); an API key only works for public content.
async function resolveProjectAuth(options = {}) {
  if (options.auth) return options.auth;
  const serviceAccountJson = process.env[config.googleDrive.serviceAccountEnv] || '';
  const apiKey = process.env[config.googleDrive.apiKeyEnv] || '';
  if (serviceAccountJson) {
    const creds = parseServiceAccount(serviceAccountJson);
    const accessToken = await getAccessToken(creds, options);
    return { mode: 'serviceAccount', accessToken, clientEmail: creds.clientEmail };
  }
  if (apiKey) return { mode: 'apiKey', apiKey };
  throw new ProjectSyncError(
    `Missing Google credentials: set ${config.googleDrive.serviceAccountEnv} (recommended) or ${config.googleDrive.apiKeyEnv}`
  );
}

function authHeaders(auth) {
  return auth && auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {};
}

function buildListUrl(folderId, auth, pageToken) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,parents)');
  let url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000`
    + '&supportsAllDrives=true&includeItemsFromAllDrives=true';
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
  if (auth && auth.apiKey) url += `&key=${auth.apiKey}`;
  return url;
}

function buildDownloadUrl(fileId, auth) {
  let url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  if (auth && auth.apiKey) url += `&key=${auth.apiKey}`;
  return url;
}

// Lists the immediate children of one folder, following pagination.
async function listFolderChildren(folderId, auth, options = {}) {
  const { fetchImpl = fetch } = options;
  const files = [];
  let pageToken;
  do {
    const response = await fetchImpl(buildListUrl(folderId, auth, pageToken), { headers: authHeaders(auth) });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 400);
      throw new ProjectSyncError(`Drive list failed: ${response.status} ${response.statusText}`, {
        folderId, status: response.status, body
      });
    }
    const data = await response.json();
    for (const f of data.files || []) files.push(f);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// Walks the folder tree depth-first, returning syncable files with their
// mirrored relPath, plus a list of skipped entries (with reasons) for logging.
async function listFolderRecursive(folderId, auth, options = {}) {
  const { logger = console, basePath = '', maxDepth = 25, _depth = 0 } = options;
  const out = { files: [], skipped: [] };
  if (_depth > maxDepth) {
    logger.log('[project-sync] max recursion depth reached', { folderId, basePath });
    return out;
  }

  const children = await listFolderChildren(folderId, auth, options);
  for (const child of children) {
    const relPath = joinPath(basePath, child.name);
    if (isFolder(child.mimeType)) {
      const nested = await listFolderRecursive(child.id, auth, { ...options, basePath: relPath, _depth: _depth + 1 });
      out.files.push(...nested.files);
      out.skipped.push(...nested.skipped);
    } else if (isSyncableFile(child)) {
      out.files.push({
        id: child.id,
        name: child.name,
        mimeType: child.mimeType,
        modifiedTime: child.modifiedTime || '',
        relPath
      });
    } else {
      out.skipped.push({ relPath, mimeType: child.mimeType, reason: isGoogleNative(child.mimeType) ? 'google-native' : 'unsupported-type' });
    }
  }
  return out;
}

async function downloadFile(fileId, auth, options = {}) {
  const { fetchImpl = fetch } = options;
  const response = await fetchImpl(buildDownloadUrl(fileId, auth), { headers: authHeaders(auth) });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300);
    throw new ProjectSyncError(`Drive download failed for ${fileId}: ${response.status} ${response.statusText}`, {
      fileId, status: response.status, body
    });
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

// Rewrites ONLY root-relative links (`/foo`, not `//host` or `/slug/...`) so a
// page served at `/<slug>/...` still resolves them under its own prefix.
// Relative links (`./x`, `../x`, `x`) are left untouched because the mirrored
// folder structure already makes them resolve correctly.
function rewriteRootRelativeLinks(html, slug) {
  const prefix = `/${slug}`;
  const alreadyPrefixed = new RegExp(`^${prefix}(/|$)`);

  const fixValue = (value) => {
    if (!value.startsWith('/') || value.startsWith('//')) return null; // not root-relative
    if (alreadyPrefixed.test(value)) return null; // already namespaced
    return prefix + value;
  };

  // href="/...", src="/...", action="/...", poster="/..." (single or double quoted)
  let out = String(html).replace(
    /\b(href|src|action|poster)\s*=\s*(["'])(\/[^"']*)\2/gi,
    (match, attr, quote, value) => {
      const fixed = fixValue(value);
      return fixed ? `${attr}=${quote}${fixed}${quote}` : match;
    }
  );

  // CSS url(/...) inside <style> or style="" attributes.
  out = out.replace(
    /url\(\s*(["']?)(\/[^"')]*)\1\s*\)/gi,
    (match, quote, value) => {
      const fixed = fixValue(value);
      return fixed ? `url(${quote}${fixed}${quote})` : match;
    }
  );

  return out;
}

// Entry point order: index.html at the root, else the configured entryFile (if
// it exists), else the first .html alphabetically, else the first file.
function resolveEntryPath(paths, entryFile) {
  const list = (paths || []).slice().sort();
  if (list.includes('index.html')) return 'index.html';
  const configured = String(entryFile || '').trim().replace(/^\/+/, '');
  if (configured && list.includes(configured)) return configured;
  const html = list.filter(isHtmlPath);
  if (html.length) return html[0];
  return list[0] || null;
}

// Orchestrates a single project's sync. Dependencies are injectable so the flow
// is unit-testable without Redis or live Drive.
async function runProjectSync(slug, options = {}) {
  const {
    force = false,
    logger = console,
    fetchImpl = fetch,
    rewriteLinks = true,
    store = projectStorage,
    repo = projects
  } = options;

  const project = await repo.getProject(slug);
  if (!project) throw new ProjectSyncError(`Project "${slug}" not found`);

  const log = async (level, message, extra) => {
    logger[level === 'error' ? 'error' : 'log'](`[project-sync:${slug}] ${message}`, extra || '');
    await repo.appendLog(slug, level, message, extra);
  };

  await log('info', force ? 'Starting full resync' : 'Starting incremental sync', { folderId: project.driveFolderId });

  let result;
  try {
    const auth = await resolveProjectAuth({ ...options, fetchImpl, logger });
    const { files, skipped } = await listFolderRecursive(project.driveFolderId, auth, { fetchImpl, logger });

    if (skipped.length) {
      await log('info', `Skipped ${skipped.length} non-syncable item(s)`, skipped.slice(0, 25));
    }

    const oldManifest = project.fileManifest || {};
    const newManifest = {};
    const seen = new Set();
    let downloaded = 0;
    let unchanged = 0;
    const failures = [];

    for (const file of files) {
      seen.add(file.relPath);
      newManifest[file.relPath] = file.modifiedTime;

      const isUnchanged = !force && oldManifest[file.relPath] === file.modifiedTime && file.modifiedTime;
      if (isUnchanged) {
        unchanged += 1;
        continue;
      }

      try {
        const buffer = await downloadFile(file.id, auth, { fetchImpl });
        if (isHtmlPath(file.relPath)) {
          const html = buffer.toString('utf-8');
          const body = rewriteLinks ? rewriteRootRelativeLinks(html, slug) : html;
          await store.saveProjectFile(slug, file.relPath, body, 'text/html; charset=utf-8');
        } else {
          await store.saveProjectFile(slug, file.relPath, buffer, contentTypeFor(file.relPath, file.mimeType));
        }
        downloaded += 1;
      } catch (error) {
        failures.push({ relPath: file.relPath, message: error.message });
        // Keep the previous modifiedTime so a retry re-downloads it next run.
        if (oldManifest[file.relPath]) newManifest[file.relPath] = oldManifest[file.relPath];
        else delete newManifest[file.relPath];
        await log('error', `Failed to sync ${file.relPath}`, { message: error.message });
      }
    }

    // Prune files that disappeared from Drive (or are now in the manifest only
    // because of the force/skip paths above and no longer present).
    const removed = [];
    for (const relPath of Object.keys(oldManifest)) {
      if (!seen.has(relPath)) {
        await store.deleteProjectFile(slug, relPath);
        removed.push(relPath);
      }
    }
    if (force) {
      // On a full resync, also drop any orphan stored files not in the manifest.
      const stored = await store.listProjectPaths(slug);
      for (const relPath of stored) {
        if (!seen.has(relPath)) {
          await store.deleteProjectFile(slug, relPath);
          if (!removed.includes(relPath)) removed.push(relPath);
        }
      }
    }

    const manifestPaths = Object.keys(newManifest);
    const entryPath = resolveEntryPath(manifestPaths, project.entryFile);

    result = {
      slug,
      total: files.length,
      downloaded,
      unchanged,
      removed: removed.length,
      skipped: skipped.length,
      failures,
      entryPath
    };

    const status = failures.length ? 'error' : 'ok';
    await repo.saveProject({
      ...project,
      fileManifest: newManifest,
      fileCount: manifestPaths.length,
      entryPath,
      lastSyncedAt: new Date().toISOString(),
      status,
      lastError: failures.length ? `${failures.length} file(s) failed; see logs` : null
    });

    await log(status === 'ok' ? 'info' : 'error',
      `Sync complete: ${downloaded} downloaded, ${unchanged} unchanged, ${removed.length} removed, ${failures.length} failed`,
      { entryPath });

    if (failures.length) {
      throw new ProjectSyncError(`Sync finished with ${failures.length} failure(s)`, result);
    }
    return result;
  } catch (error) {
    if (!(error instanceof ProjectSyncError) || !error.details || !error.details.failures) {
      // Hard failure (auth/list/etc.) — record status and rethrow.
      const fresh = await repo.getProject(slug);
      if (fresh) {
        await repo.saveProject({
          ...fresh,
          status: 'error',
          lastError: error.message,
          lastSyncedAt: fresh.lastSyncedAt || null
        });
      }
      await log('error', `Sync failed: ${error.message}`);
    }
    throw error;
  }
}

// Syncs every project incrementally (used by the cron). Never throws: collects
// per-project results so one bad project can't stop the rest.
async function runAllProjectsSync(options = {}) {
  const { force = false } = options;
  const slugs = await projects.listProjectSlugs();
  const results = [];
  for (const slug of slugs) {
    try {
      const r = await runProjectSync(slug, { ...options, force });
      results.push({ slug, ok: true, ...r });
    } catch (error) {
      results.push({ slug, ok: false, error: error.message });
    }
  }
  return { count: slugs.length, results };
}

module.exports = {
  ProjectSyncError,
  FOLDER_MIME,
  isFolder,
  isGoogleNative,
  isSyncableFile,
  isHtmlPath,
  resolveProjectAuth,
  buildListUrl,
  buildDownloadUrl,
  listFolderChildren,
  listFolderRecursive,
  downloadFile,
  rewriteRootRelativeLinks,
  resolveEntryPath,
  runProjectSync,
  runAllProjectsSync
};
