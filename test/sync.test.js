const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { extractGoogleFolderId, getRuntimeConfig } = require('../lib/config');
const { runSync, sanitizeUrl, slugFromFilename, classifyDriveError, diagnose } = require('../lib/sync');
const { parseServiceAccount, signJwt, getAccessToken, resetTokenCache } = require('../lib/google-auth');

function makeServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return {
    client_email: 'sync@example.iam.gserviceaccount.com',
    private_key: privateKey,
    type: 'service_account'
  };
}

test('extractGoogleFolderId supports folder links', () => {
  const id = extractGoogleFolderId('https://drive.google.com/drive/folders/ABC123_xyz?usp=sharing');
  assert.equal(id, 'ABC123_xyz');
});

test('extractGoogleFolderId returns raw id', () => {
  assert.equal(extractGoogleFolderId('ABC123_xyz'), 'ABC123_xyz');
});

test('extractGoogleFolderId supports open?id links', () => {
  const id = extractGoogleFolderId('https://drive.google.com/open?id=ABC123_xyz&usp=drive_fs');
  assert.equal(id, 'ABC123_xyz');
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
          files: [{ id: 'file-1', name: 'Report.html', mimeType: 'text/html' }]
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

test('classifyDriveError detects HTTP referrer restriction', () => {
  const hint = classifyDriveError(403, 'Requests from referer <empty> are blocked.');
  assert.match(hint, /HTTP referrer/);
});

test('classifyDriveError detects disabled Drive API', () => {
  const hint = classifyDriveError(403, 'Google Drive API has not been used in project 123 before or it is disabled.');
  assert.match(hint, /not enabled/);
});

test('fetchFolderFiles requests Shared Drive support and surfaces the error hint', async () => {
  let requestedUrl = '';
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Requests from referer <empty> are blocked.'
    };
  };

  await assert.rejects(
    () =>
      runSync({
        config: { folderId: 'folder-1', googleApiKey: 'secret', storagePrefix: 'html' },
        fetchImpl,
        logger: { log() {}, error() {} }
      }),
    (error) => {
      assert.match(error.message, /HTTP referrer/);
      assert.equal(error.details.status, 403);
      return true;
    }
  );

  assert.match(requestedUrl, /supportsAllDrives=true/);
  assert.match(requestedUrl, /includeItemsFromAllDrives=true/);
});

test('diagnose reports an actionable hint when the folder is empty', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ files: [] })
  });

  const report = await diagnose({
    config: { folderId: 'folder-1', googleApiKey: 'secret', storagePrefix: 'html' },
    fetchImpl,
    logger: { log() {}, error() {} }
  });

  assert.equal(report.ok, false);
  assert.equal(report.list.totalItems, 0);
  assert.match(report.hint, /publicly shared/);
});

test('diagnose reports OK and never leaks the API key', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ files: [{ id: 'f1', name: 'Deal.html', mimeType: 'text/html' }] })
  });

  const report = await diagnose({
    config: { folderId: 'folder-1', googleApiKey: 'super-secret-key', storagePrefix: 'html' },
    fetchImpl,
    logger: { log() {}, error() {} }
  });

  assert.equal(report.ok, true);
  assert.equal(report.list.htmlItems, 1);
  assert.equal(report.config.apiKeyPresent, true);
  assert.ok(!JSON.stringify(report).includes('super-secret-key'));
});

test('parseServiceAccount accepts raw and base64 JSON', () => {
  const sa = makeServiceAccount();
  const raw = JSON.stringify(sa);
  assert.equal(parseServiceAccount(raw).clientEmail, sa.client_email);

  const b64 = Buffer.from(raw, 'utf-8').toString('base64');
  assert.equal(parseServiceAccount(b64).clientEmail, sa.client_email);

  assert.equal(parseServiceAccount(''), null);
  assert.throws(() => parseServiceAccount('not-json'), /not valid JSON/);
});

test('signJwt produces a verifiable RS256 assertion', () => {
  const sa = makeServiceAccount();
  const creds = parseServiceAccount(JSON.stringify(sa));
  const jwt = signJwt(creds, 1000);
  const [header, claim, signature] = jwt.split('.');

  const publicKey = crypto.createPublicKey(creds.privateKey);
  const valid = crypto
    .createVerify('RSA-SHA256')
    .update(`${header}.${claim}`)
    .verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.equal(valid, true);

  const payload = JSON.parse(Buffer.from(claim, 'base64').toString('utf-8'));
  assert.equal(payload.iss, sa.client_email);
  assert.equal(payload.exp, 1000 + 3600);
});

test('getAccessToken caches the token across calls', async () => {
  resetTokenCache();
  const creds = parseServiceAccount(JSON.stringify(makeServiceAccount()));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }) };
  };

  assert.equal(await getAccessToken(creds, { fetchImpl }), 'tok-123');
  assert.equal(await getAccessToken(creds, { fetchImpl }), 'tok-123');
  assert.equal(calls, 1);
  resetTokenCache();
});

test('runSync uses a service account bearer token, not an API key', async () => {
  resetTokenCache();
  const sa = makeServiceAccount();
  const requests = [];
  const saved = [];

  const fetchImpl = async (url, init) => {
    requests.push({ url, init });

    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }) };
    }
    if (url.includes('/drive/v3/files?q=')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ files: [{ id: 'f1', name: 'Deal.html', mimeType: 'text/html' }] })
      };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<h1>Deal</h1>' };
  };

  const result = await runSync({
    config: { folderId: 'folder-1', serviceAccountJson: JSON.stringify(sa), storagePrefix: 'html' },
    fetchImpl,
    saveHtmlImpl: async (prefix, slug, html) => saved.push({ prefix, slug, html }),
    logger: { log() {}, error() {} }
  });

  assert.deepEqual(result.uploaded, ['deal']);
  assert.deepEqual(saved, [{ prefix: 'html', slug: 'deal', html: '<h1>Deal</h1>' }]);

  const driveCalls = requests.filter((r) => r.url.includes('/drive/v3/files'));
  assert.ok(driveCalls.length >= 2);
  for (const call of driveCalls) {
    assert.ok(!/[?&]key=/.test(call.url), 'service account requests must not append an API key');
    assert.equal(call.init.headers.Authorization, 'Bearer sa-token');
  }
  resetTokenCache();
});

test('diagnose reports service-account mode and a share-with-email hint when empty', async () => {
  resetTokenCache();
  const sa = makeServiceAccount();
  const fetchImpl = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sa-token', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ files: [] }) };
  };

  const report = await diagnose({
    config: { folderId: 'folder-1', serviceAccountJson: JSON.stringify(sa), storagePrefix: 'html' },
    fetchImpl,
    logger: { log() {}, error() {} }
  });

  assert.equal(report.config.authMode, 'serviceAccount');
  assert.equal(report.config.serviceAccountEmail, sa.client_email);
  assert.match(report.hint, /Share the Drive folder with the service account email/);
  assert.match(report.hint, new RegExp(sa.client_email));
  resetTokenCache();
});

test('runSync lists all Drive files but syncs only HTML files', async () => {
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
          files: [
            { id: 'file-1', name: 'Notes.txt', mimeType: 'text/plain' },
            { id: 'file-2', name: 'Offer.html', mimeType: 'application/octet-stream' }
          ]
        })
      };
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<h1>Offer</h1>'
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
    uploaded: ['offer'],
    total: 1,
    failures: []
  });
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(saved, [{
    prefix: 'html',
    slug: 'offer',
    html: '<h1>Offer</h1>'
  }]);
});
