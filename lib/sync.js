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
    const details = {
      url: safeUrl,
      status: response.status,
      statusText: response.statusText,
      body
    };
    logger.error(`[sync] ${label} failed`, details);
    throw new SyncError(`${label} request failed: ${response.status} ${response.statusText}`, details);
  }

  return response;
}

async function googleApiJson(url, options) {
  const response = await fetchGoogleResponse(url, { ...options, label: 'Google Drive list' });
  return response.json();
}

async function fetchFolderHtmlFiles(folderId, apiKey, options) {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType = 'text/html' and trashed = false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&key=${apiKey}`;
  const list = await googleApiJson(listUrl, options);
  return list.files || [];
}

async function fetchHtmlFile(fileId, apiKey, options) {
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${apiKey}`;
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
        body: failure.details.body
      } : null
    }))
  };
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

  const files = await fetchFolderHtmlFiles(config.folderId, config.googleApiKey, { fetchImpl, logger });
  logger.log('[sync] Google Drive list completed', {
    total: files.length,
    names: files.map((file) => file.name)
  });

  const uploaded = [];
  const failures = [];

  if (files.length === 0) {
    failures.push({
      stage: 'list',
      message: 'No HTML files found in the configured Google Drive folder'
    });
  }

  for (const file of files) {
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

  const result = { uploaded, total: files.length, failures };

  if (failures.length > 0 || uploaded.length !== files.length) {
    logger.error('[sync] Sync failed', result);
    throw buildSyncFailure(result);
  }

  logger.log('[sync] Sync complete', result);
  return result;
}

module.exports = {
  SyncError,
  fetchGoogleResponse,
  publicSyncDetails,
  runSync,
  sanitizeUrl,
  slugFromFilename
};
