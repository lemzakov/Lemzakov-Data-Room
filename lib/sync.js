const { getRuntimeConfig } = require('./config');
const { saveHtml } = require('./storage');

function slugFromFilename(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/\.html?$/i, '');
}

async function googleApiJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google API request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchFolderHtmlFiles(folderId, apiKey) {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType = 'text/html' and trashed = false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&key=${apiKey}`;
  const list = await googleApiJson(listUrl);
  return list.files || [];
}

async function fetchHtmlFile(fileId, apiKey) {
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${apiKey}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Google Drive file download failed: ${response.status}`);
  }
  return response.text();
}

async function runSync() {
  const cfg = getRuntimeConfig();
  if (!cfg.folderId) {
    throw new Error('Google Drive folder is not configured');
  }

  console.log(`Starting sync for Google Drive folder ${cfg.folderId}`);
  const files = await fetchFolderHtmlFiles(cfg.folderId, cfg.googleApiKey);
  console.log(`Found ${files.length} HTML files`);

  const uploaded = [];
  for (const file of files) {
    try {
      const html = await fetchHtmlFile(file.id, cfg.googleApiKey);
      const slug = slugFromFilename(file.name);
      if (!slug) {
        console.error(`Skipping file with empty slug: ${file.name}`);
        continue;
      }
      await saveHtml(cfg.storagePrefix, slug, html);
      uploaded.push(slug);
      console.log(`Uploaded ${file.name} as slug ${slug}`);
    } catch (error) {
      console.error(`Failed to sync file ${file.name}:`, error);
    }
  }

  console.log(`Sync complete. Uploaded ${uploaded.length} files.`);
  return { uploaded, total: files.length };
}

module.exports = { slugFromFilename, runSync };
