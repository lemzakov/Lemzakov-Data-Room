const fs = require('fs');
const path = require('path');

const configPath = path.join(process.cwd(), 'sync.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

function extractGoogleFolderId(input) {
  if (!input) return '';
  const trimmed = input.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  try {
    const url = new URL(trimmed);
    const queryId = url.searchParams.get('id');
    if (queryId) return queryId.trim();
  } catch {}

  return trimmed;
}

function getRuntimeConfig() {
  const folderRaw =
    process.env[config.googleDrive.folderIdEnv] ||
    process.env[config.googleDrive.folderLinkEnv] ||
    '';

  const serviceAccountEnv = config.googleDrive.serviceAccountEnv;

  return {
    folderId: extractGoogleFolderId(folderRaw),
    googleApiKey: process.env[config.googleDrive.apiKeyEnv] || '',
    serviceAccountJson: (serviceAccountEnv && process.env[serviceAccountEnv]) || '',
    syncSecret: process.env[config.sync.secretEnv] || '',
    storagePrefix: config.storage.htmlPrefix || 'html'
  };
}

// The public domains a single-file page is reachable on. The Data Room is
// served from more than one hostname (e.g. data.lemzakov.com AND data.wize.ae),
// so a "page URL" is really a list. Configurable via PAGE_DOMAINS (comma/space
// separated); falls back to the two known production domains.
const DEFAULT_PAGE_DOMAINS = ['data.lemzakov.com', 'data.wize.ae'];

function getPageDomains(env = process.env) {
  const raw = String(env.PAGE_DOMAINS || '').trim();
  const list = raw
    .split(/[\s,]+/)
    .map((d) => d.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const domains = list.length ? list : DEFAULT_PAGE_DOMAINS.slice();
  return Array.from(new Set(domains));
}

// Every public URL a given slug resolves to, one per configured domain.
function pageUrls(slug, env = process.env) {
  const clean = String(slug || '').replace(/^\/+/, '').trim();
  return getPageDomains(env).map((domain) => `https://${domain}/${clean}`);
}

function getSyncConfig() {
  const runtime = getRuntimeConfig();
  if (!runtime.folderId) {
    throw new Error('Google Drive folder is not configured');
  }
  if (!runtime.googleApiKey && !runtime.serviceAccountJson) {
    throw new Error(
      `Missing Google credentials: set ${config.googleDrive.serviceAccountEnv} (recommended) or ${config.googleDrive.apiKeyEnv}`
    );
  }
  return runtime;
}

module.exports = {
  config,
  extractGoogleFolderId,
  getRuntimeConfig,
  getSyncConfig,
  getPageDomains,
  pageUrls,
  DEFAULT_PAGE_DOMAINS
};
