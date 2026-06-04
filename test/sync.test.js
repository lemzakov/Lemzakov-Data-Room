const test = require('node:test');
const assert = require('node:assert/strict');
const { extractGoogleFolderId, getRuntimeConfig } = require('../lib/config');
const { runSync, sanitizeUrl, slugFromFilename } = require('../lib/sync');

test('extractGoogleFolderId supports folder links', () => {
  const id = extractGoogleFolderId('https://drive.google.com/drive/folders/ABC123_xyz?usp=sharing');
  assert.equal(id, 'ABC123_xyz');
});

test('extractGoogleFolderId returns raw id', () => {
  assert.equal(extractGoogleFolderId('ABC123_xyz'), 'ABC123_xyz');
});

test('slugFromFilename normalizes html filename', () => {
  assert.equal(slugFromFilename('Quarterly-Report.HTML'), 'quarterly-report');
});

test('sanitizeUrl redacts Google API key', () => {
  const sanitized = sanitizeUrl('https://www.googleapis.com/drive/v3/files?q=test&key=secret-value');
  assert.equal(sanitized, 'https://www.googleapis.com/drive/v3/files?q=test&key=%5Bredacted%5D');
});

test('getRuntimeConfig does not require API key for read routes', () => {
  delete process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-1';
  const cfg = getRuntimeConfig();
  assert.equal(cfg.folderId, 'folder-1');
  assert.equal(cfg.googleApiKey, '');
});

test('runSync throws detailed error when no HTML files are found', async () => {
  const logs = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ files: [] })
  });

  await assert.rejects(
    () =>
      runSync({
        config: {
          folderId: 'folder-1',
          googleApiKey: 'secret',
          storagePrefix: 'html'
        },
        fetchImpl,
        logger: {
          log: (...args) => logs.push(['log', ...args]),
          error: (...args) => logs.push(['error', ...args])
        }
      }),
    (error) => {
      assert.equal(error.message, 'Sync failed: uploaded 0/0 files');
      assert.deepEqual(error.details.failures, [{
        stage: 'list',
        message: 'No HTML files found in the configured Google Drive folder'
      }]);
      return true;
    }
  );

  assert.ok(logs.some((entry) => entry[1] === '[sync] Google Drive list response'));
});

test('runSync uploads HTML files and logs request flow', async () => {
  const fetchCalls = [];
  const saved = [];

  const fetchImpl = async (url) => {
    fetchCalls.push(url);

    if (url.includes('/drive/v3/files?q=')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          files: [{ id: 'file-1', name: 'Report.html' }]
        })
      };
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<h1>Report</h1>'
    };
  };

  const result = await runSync({
    config: {
      folderId: 'folder-1',
      googleApiKey: 'secret',
      storagePrefix: 'html'
    },
    fetchImpl,
    saveHtmlImpl: async (prefix, slug, html) => {
      saved.push({ prefix, slug, html });
    }
  });

  assert.deepEqual(result, {
    uploaded: ['report'],
    total: 1,
    failures: []
  });
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(saved, [{
    prefix: 'html',
    slug: 'report',
    html: '<h1>Report</h1>'
  }]);
});
