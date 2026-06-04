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

  return {
    folderId: extractGoogleFolderId(folderRaw),
    googleApiKey: process.env[config.googleDrive.apiKeyEnv] || '',
    syncSecret: process.env[config.sync.secretEnv] || '',
    storagePrefix: config.storage.htmlPrefix || 'html'
  };
}

function getSyncConfig() {
  const runtime = getRuntimeConfig();
  if (!runtime.folderId) {
    throw new Error('Google Drive folder is not configured');
  }
  if (!runtime.googleApiKey) {
    throw new Error(`Missing required environment variable: ${config.googleDrive.apiKeyEnv}`);
  }
  return runtime;
}

module.exports = { config, extractGoogleFolderId, getRuntimeConfig, getSyncConfig };
