const { getSyncConfig } = require('./config');
const { saveHtml } = require('./storage');

class SyncError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SyncError';
    this.details = details;
  }
}

function slugFromFilename(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/\.html?$/i, '');
}

function sanitizeUrl(input) {
  const url = new URL(input);
  if (url.searchParams.has('key')) {
    url.searchParams.set('key', '[redacted]');
  }
  return url.toString();
}

// Turns a raw Google Drive HTTP error into an actionable, human-readable hint
// so the most common "simple folder" misconfigurations are obvious in logs and
// in the /api/sync and /api/diagnose responses.
function classifyDriveError(status, body = '') {
  const text = String(body || '').toLowerCase();

  if (status === 403 && (text.includes('referer') || text.includes('api_key_http_referrer_blocked'))) {
    return 'API key is restricted by HTTP referrer. Vercel server-side (cron/build) requests send no referer, so Google blocks them. In Google Cloud Console > APIs & Services > Credentials, set this key\'s "Application restrictions" to "None" (or IP addresses), not "HTTP referrers".';
  }
  if (status === 403 && (text.includes('has not been used in project') || text.includes('accessnotconfigured') || text.includes('it is disabled'))) {
    return 'The Google Drive API is not enabled for this API key\'s project. Enable it in Google Cloud Console > APIs & Services > Library > Google Drive API.';
  }
  if (status === 403 && text.includes('ip') && text.includes('blocked')) {
    return 'API key is restricted by IP address and the Vercel egress IP is not allowlisted. Use "None" or add Vercel\'s IPs.';
  }
  if (status === 400 && (text.includes('api key not valid') || text.includes('api_key_invalid'))) {
    return 'GOOGLE_API_KEY is invalid. Re-check the value copied into the Vercel environment variable.';
  }
  if (status === 404) {
    return 'Folder not found. Re-check GOOGLE_DRIVE_FOLDER_ID / GOOGLE_DRIVE_FOLDER_LINK.';
  }
  return null;
}

async function fetchGoogleResponse(url, options = {}) {
  const {
    fetchImpl = fetch,
    logger = console,
    label = 'Google API'
  } = options;
  const safeUrl = sanitizeUrl(url);

  logger.log(`[sync] ${label} request`, { url: safeUrl });

  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    logger.error(`[sync] ${label} network error`, {
      url: safeUrl,
      message: error.message
    });
    throw new SyncError(`${label} request failed`, {
      url: safeUrl,
      message: error.message
    });
  }

  logger.log(`[sync] ${label} response`, {
    url: safeUrl,
    status: response.status,
    statusText: response.statusText
  });

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 500);
    const hint = classifyDriveError(response.status, body);
    const details = {
      url: safeUrl,
      status: response.status,
      statusText: response.statusText,
      body,
      hint
    };
    logger.error(`[sync] ${label} failed`, details);
    const suffix = hint ? ` — ${hint}` : '';
    throw new SyncError(`${label} request failed: ${response.status} ${response.statusText}${suffix}`, details);
  }

  return response;
}

async function googleApiJson(url, options) {
  const response = await fetchGoogleResponse(url, { ...options, label: 'Google Drive list' });
  return response.json();
}

function isHtmlFile(file) {
  if (!file) return false;
  if ((file.mimeType || '').toLowerCase() === 'text/html') return true;
  return /\.html?$/i.test(file.name || '');
}

// supportsAllDrives + includeItemsFromAllDrives are required for folders that
// live in a Shared Drive (Team Drive); without them Drive silently returns an
// empty list. They are harmless for ordinary "My Drive" folders.
function buildListUrl(folderId, apiKey) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  return `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${apiKey}`;
}

async function fetchFolderFiles(folderId, apiKey, options) {
  const list = await googleApiJson(buildListUrl(folderId, apiKey), options);
  return list.files || [];
}

async function fetchHtmlFile(fileId, apiKey, options) {
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&key=${apiKey}`;
  const response = await fetchGoogleResponse(fileUrl, {
    ...options,
    label: `Google Drive download ${fileId}`
  });
  return response.text();
}

function buildSyncFailure(result) {
  return new SyncError(`Sync failed: uploaded ${result.uploaded.length}/${result.total} files`, result);
}

function publicSyncDetails(error) {
  if (!(error instanceof SyncError) || !error.details) {
    return null;
  }

  const { uploaded = [], total = 0, failures = [] } = error.details;
  return {
    uploaded,
    total,
    failures: failures.map((failure) => ({
      stage: failure.stage,
      fileId: failure.fileId,
      fileName: failure.fileName,
      slug: failure.slug,
      message: failure.message,
      details: failure.details ? {
        url: failure.details.url,
        status: failure.details.status,
        statusText: failure.details.statusText,
        body: failure.details.body,
        hint: failure.details.hint || null
      } : null
    }))
  };
}

// Read-only health check for the Google Drive "simple folder" integration.
// Never throws and never exposes the API key (the key is redacted from URLs and
// only its length is reported). Returns a structured report that pinpoints the
// exact failure mode (config missing, key blocked, API disabled, folder not
// public/empty, no HTML files, or OK).
async function diagnose(options = {}) {
  const {
    fetchImpl = fetch,
    logger = console
  } = options;

  const report = { config: {}, list: null, summary: '', hint: null, ok: false };

  let config;
  try {
    config = options.config || getSyncConfig();
  } catch (error) {
    report.config = { ok: false, message: error.message };
    report.summary = 'Configuration error';
    report.hint = 'Set GOOGLE_DRIVE_FOLDER_ID (or GOOGLE_DRIVE_FOLDER_LINK) and GOOGLE_API_KEY in the Vercel project environment variables, then redeploy.';
    return report;
  }

  report.config = {
    ok: true,
    folderId: config.folderId,
    apiKeyPresent: Boolean(config.googleApiKey),
    apiKeyLength: (config.googleApiKey || '').length
  };

  const listUrl = buildListUrl(config.folderId, config.googleApiKey);
  const safeUrl = sanitizeUrl(listUrl);
  logger.log('[diagnose] Google Drive list request', { url: safeUrl });

  let response;
  try {
    response = await fetchImpl(listUrl);
  } catch (error) {
    report.list = { ok: false, networkError: error.message, url: safeUrl };
    report.summary = 'Network error reaching the Google Drive API';
    report.hint = 'Vercel could not reach googleapis.com. Check outbound network / firewall settings.';
    return report;
  }

  const status = response.status;
  let bodyText = '';
  try { bodyText = await response.text(); } catch {}

  if (!response.ok) {
    report.list = {
      ok: false,
      status,
      statusText: response.statusText,
      body: bodyText.slice(0, 800),
      url: safeUrl
    };
    report.summary = `Google Drive list failed with HTTP ${status}`;
    report.hint = classifyDriveError(status, bodyText) || 'Inspect the body above for the Google error reason.';
    return report;
  }

  let data = {};
  try { data = JSON.parse(bodyText); } catch {}
  const files = data.files || [];
  const htmlFiles = files.filter(isHtmlFile);

  report.list = {
    ok: true,
    status,
    totalItems: files.length,
    htmlItems: htmlFiles.length,
    files: files.map((file) => ({ name: file.name, mimeType: file.mimeType })),
    url: safeUrl
  };

  if (files.length === 0) {
    report.summary = 'Drive API reachable, but the folder returned 0 items';
    report.hint = 'An API key can only see publicly shared content. Share the folder AND its files as "Anyone with the link can view", double-check the folder ID, and note that Shared Drive folders behave differently from "My Drive".';
  } else if (htmlFiles.length === 0) {
    report.summary = `Folder has ${files.length} item(s) but none are HTML`;
    report.hint = 'Only files with mimeType text/html or a .html/.htm filename are synced. Google Docs are not HTML files — export them to .html and place them in the folder.';
  } else {
    report.ok = true;
    report.summary = `OK: ${htmlFiles.length} HTML file(s) visible and ready to sync`;
    report.hint = null;
  }

  return report;
}

async function runSync(options = {}) {
  const {
    fetchImpl = fetch,
    saveHtmlImpl = saveHtml,
    logger = console,
    config = getSyncConfig()
  } = options;

  logger.log('[sync] Starting sync', {
    folderId: config.folderId,
    storagePrefix: config.storagePrefix
  });

  const files = await fetchFolderFiles(config.folderId, config.googleApiKey, { fetchImpl, logger });
  const htmlFiles = files.filter(isHtmlFile);
  logger.log('[sync] Google Drive list completed', {
    total: files.length,
    htmlTotal: htmlFiles.length,
    files: files.map((file) => ({ name: file.name, mimeType: file.mimeType }))
  });

  const uploaded = [];
  const failures = [];

  if (htmlFiles.length === 0) {
    failures.push({
      stage: 'list',
      message: 'No HTML files found in the configured Google Drive folder'
    });
  }

  for (const file of htmlFiles) {
    const slug = slugFromFilename(file.name);
    const context = {
      fileId: file.id,
      fileName: file.name,
      slug
    };

    if (!slug) {
      const failure = {
        ...context,
        stage: 'slug',
        message: 'Skipping file with empty slug'
      };
      failures.push(failure);
      logger.error('[sync] Invalid HTML filename', failure);
      continue;
    }

    try {
      const html = await fetchHtmlFile(file.id, config.googleApiKey, { fetchImpl, logger });
      await saveHtmlImpl(config.storagePrefix, slug, html);
      uploaded.push(slug);
      logger.log('[sync] Uploaded HTML file', {
        ...context,
        bytes: Buffer.byteLength(html)
      });
    } catch (error) {
      const failure = {
        ...context,
        stage: 'upload',
        message: error.message,
        details: error.details || null
      };
      failures.push(failure);
      logger.error('[sync] Failed to sync file', failure);
    }
  }

  const result = { uploaded, total: htmlFiles.length, failures };

  if (failures.length > 0 || uploaded.length !== htmlFiles.length) {
    logger.error('[sync] Sync failed', result);
    throw buildSyncFailure(result);
  }

  logger.log('[sync] Sync complete', result);
  return result;
}

module.exports = {
  SyncError,
  classifyDriveError,
  diagnose,
  fetchGoogleResponse,
  publicSyncDetails,
  runSync,
  sanitizeUrl,
  slugFromFilename,
  isHtmlFile
};
