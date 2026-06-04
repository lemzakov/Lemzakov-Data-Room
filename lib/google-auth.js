const crypto = require('crypto');

// Service-account authentication for the Google Drive API.
//
// Unlike an API key (which can only see publicly-shared content and cannot
// reliably enumerate a folder's children), a service account can list and read
// any folder that has been shared with its email address. The folder owner
// shares the Drive folder with the service account's client_email as "Viewer";
// no public sharing required.
//
// We mint a short-lived OAuth access token with the standard JWT-bearer grant
// (RFC 7523) using only Node's crypto, so no extra dependency is needed.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// Accepts either raw service-account JSON or base64-encoded JSON (base64 is
// safer in Vercel env vars, which mangle multi-line PEM private keys).
function parseServiceAccount(raw) {
  if (!raw || !String(raw).trim()) return null;
  let text = String(raw).trim();

  if (!text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf-8').trim();
      if (decoded.startsWith('{')) text = decoded;
    } catch {}
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON)');
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key');
  }

  return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(creds, now = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: creds.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${claim}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(creds.privateKey)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signingInput}.${signature}`;
}

async function fetchAccessToken(creds, options = {}) {
  const { fetchImpl = fetch } = options;
  const assertion = signJwt(creds);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  }).toString();

  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`Service account token request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Service account token response was not valid JSON');
  }
  if (!data.access_token) {
    throw new Error('Service account token response did not include an access_token');
  }
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 3600 };
}

// Cache the token across warm serverless invocations to avoid re-minting it on
// every request (tokens are valid for ~1h; we refresh 60s early).
let cache = { key: null, token: null, exp: 0 };

async function getAccessToken(creds, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!options.forceRefresh && cache.key === creds.clientEmail && cache.token && cache.exp - 60 > now) {
    return cache.token;
  }
  const { accessToken, expiresIn } = await fetchAccessToken(creds, options);
  cache = { key: creds.clientEmail, token: accessToken, exp: now + expiresIn };
  return accessToken;
}

function resetTokenCache() {
  cache = { key: null, token: null, exp: 0 };
}

module.exports = {
  parseServiceAccount,
  signJwt,
  fetchAccessToken,
  getAccessToken,
  resetTokenCache,
  SCOPE,
  TOKEN_URL
};
