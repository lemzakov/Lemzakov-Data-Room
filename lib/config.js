const fs = require('fs');
const path = require('path');

const configPath = path.join(process.cwd(), 'sync.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

function extractGoogleFolderId(input) {
  if (!input) return '';
  const match = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : input.trim();
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getRuntimeConfig() {
  const folderRaw =
    process.env[config.googleDrive.folderIdEnv] ||
    process.env[config.googleDrive.folderLinkEnv] ||
    '';

  return {
    folderId: extractGoogleFolderId(folderRaw),
    googleApiKey: getRequiredEnv(config.googleDrive.apiKeyEnv),
    syncSecret: process.env[config.sync.secretEnv] || '',
    storagePrefix: config.storage.htmlPrefix || 'html'
  };
}

module.exports = { config, extractGoogleFolderId, getRuntimeConfig };
