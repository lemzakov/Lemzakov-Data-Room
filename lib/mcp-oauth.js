// OAuth 2.1 authorization for the REMOTE MCP server.
//
// Claude (mobile/desktop/web "custom connectors") speaks the MCP authorization
// spec: it discovers metadata, dynamically registers a client, runs an
// Authorization-Code + PKCE flow, and then calls the MCP endpoint with a Bearer
// token. This module implements the server side of that flow with ZERO new
// dependencies — Node's `crypto` plus the existing Redis KV helpers.
//
// How the human is authenticated at the authorize step: they enter the Data
// Room **admin token** (the same `ADMIN_TOKEN` / `SYNC_SECRET` that already
// guards `/admin` and the publish API). That keeps publishing limited to the
// owner with zero extra configuration. PKCE protects the code exchange; the
// admin token never leaves the server's possession beyond that one form post.
//
// Storage layout (Redis):
//   mcp:client:<client_id>   -> { client_id, redirect_uris[], client_name, ... }  (DCR)
//   mcp:code:<code>          -> { client_id, redirect_uri, code_challenge, ... }   (~10 min)
//   mcp:token:<token>        -> { client_id, scope, sub, createdAt }               (access)
//   mcp:refresh:<token>      -> { client_id, scope, sub, createdAt }               (refresh)

const crypto = require('crypto');
const { adminToken } = require('./admin');
const {
  kvGetJson,
  kvSetJson,
  kvDel
} = require('./storage');

const CLIENT_TTL_SECONDS = 180 * 24 * 60 * 60; // ~6 months
const CODE_TTL_SECONDS = 10 * 60; // authorization codes are short-lived
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60; // ~6 months

const DEFAULT_SCOPE = 'mcp';

// --- crypto helpers --------------------------------------------------------

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Constant-time string comparison that never throws on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// True when the presented secret matches the configured admin token.
function verifyAdminSecret(presented) {
  const expected = adminToken();
  if (!expected) return false; // nothing configured -> refuse, never run open
  return safeEqual(String(presented || ''), expected);
}

// PKCE: verify that S256(code_verifier) === code_challenge (RFC 7636). We only
// support S256 (plain is disallowed by the MCP spec).
function verifyPkceS256(codeVerifier, codeChallenge) {
  if (!codeVerifier || !codeChallenge) return false;
  const hash = crypto.createHash('sha256').update(String(codeVerifier)).digest('base64url');
  return safeEqual(hash, String(codeChallenge));
}

// --- metadata documents ----------------------------------------------------

// RFC 9728 — Protected Resource Metadata. Tells the client which authorization
// server guards this MCP resource.
function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [DEFAULT_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: `${origin}/`
  };
}

// RFC 8414 — Authorization Server Metadata. Advertises the endpoints and the
// PKCE/DCR support Claude needs to drive the flow.
function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/authorize`,
    token_endpoint: `${origin}/api/mcp/token`,
    registration_endpoint: `${origin}/api/mcp/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [DEFAULT_SCOPE]
  };
}

// --- dynamic client registration (RFC 7591) --------------------------------

function clientKey(id) {
  return `mcp:client:${id}`;
}

function isValidRedirectUri(uri) {
  try {
    const u = new URL(uri);
    // Allow https anywhere; http only for loopback (native clients / inspector).
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Registers a public client. Returns the stored record (incl. generated id).
async function registerClient(metadata = {}, deps = {}) {
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((u) => typeof u === 'string' && u.length)
    : [];
  if (!redirectUris.length) {
    throw new Error('redirect_uris is required and must contain at least one URI');
  }
  for (const uri of redirectUris) {
    if (!isValidRedirectUri(uri)) {
      throw new Error(`Invalid redirect_uri: ${uri}`);
    }
  }

  const record = {
    client_id: `mcp-${randomToken(16)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    client_name: String(metadata.client_name || 'MCP Client').slice(0, 200),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: typeof metadata.scope === 'string' ? metadata.scope : DEFAULT_SCOPE
  };

  await (deps.kvSetJson || kvSetJson)(clientKey(record.client_id), record, CLIENT_TTL_SECONDS);
  return record;
}

async function getClient(clientId, deps = {}) {
  if (!clientId) return null;
  return (deps.kvGetJson || kvGetJson)(clientKey(clientId));
}

// --- authorization codes ---------------------------------------------------

function codeKey(code) {
  return `mcp:code:${code}`;
}

// Mints a one-time authorization code bound to the client, redirect URI and
// PKCE challenge. Called once the human has proven the admin secret.
async function issueAuthCode(
  { clientId, redirectUri, codeChallenge, scope, resource, sub },
  deps = {}
) {
  const code = randomToken(32);
  const record = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    scope: scope || DEFAULT_SCOPE,
    resource: resource || '',
    sub: sub || 'owner',
    createdAt: Date.now()
  };
  await (deps.kvSetJson || kvSetJson)(codeKey(code), record, CODE_TTL_SECONDS);
  return code;
}

// Consumes (single-use) an authorization code: returns the record and deletes
// it so a code can never be replayed.
async function consumeAuthCode(code, deps = {}) {
  if (!code) return null;
  const record = await (deps.kvGetJson || kvGetJson)(codeKey(code));
  if (!record) return null;
  await (deps.kvDel || kvDel)(codeKey(code));
  return record;
}

// --- access & refresh tokens ----------------------------------------------

function tokenKey(token) {
  return `mcp:token:${token}`;
}

function refreshKey(token) {
  return `mcp:refresh:${token}`;
}

// Issues a fresh access (+ refresh) token pair and returns an OAuth token
// response body.
async function issueTokens({ clientId, scope, sub }, deps = {}) {
  const setJson = deps.kvSetJson || kvSetJson;
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const meta = { client_id: clientId, scope: scope || DEFAULT_SCOPE, sub: sub || 'owner', createdAt: Date.now() };

  await setJson(tokenKey(accessToken), meta, ACCESS_TOKEN_TTL_SECONDS);
  await setJson(refreshKey(refreshToken), meta, REFRESH_TOKEN_TTL_SECONDS);

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: meta.scope
  };
}

// Validates a bearer access token. Returns its metadata or null.
async function verifyAccessToken(token, deps = {}) {
  if (!token) return null;
  return (deps.kvGetJson || kvGetJson)(tokenKey(token));
}

// Exchanges a refresh token for a new token pair (rotating the refresh token).
async function consumeRefreshToken(token, deps = {}) {
  if (!token) return null;
  const getJson = deps.kvGetJson || kvGetJson;
  const del = deps.kvDel || kvDel;
  const meta = await getJson(refreshKey(token));
  if (!meta) return null;
  await del(refreshKey(token)); // rotate
  return meta;
}

// Reads the bearer token from an Authorization header.
function bearerFromHeader(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

module.exports = {
  DEFAULT_SCOPE,
  ACCESS_TOKEN_TTL_SECONDS,
  CODE_TTL_SECONDS,
  randomToken,
  safeEqual,
  verifyAdminSecret,
  verifyPkceS256,
  protectedResourceMetadata,
  authorizationServerMetadata,
  isValidRedirectUri,
  registerClient,
  getClient,
  issueAuthCode,
  consumeAuthCode,
  issueTokens,
  verifyAccessToken,
  consumeRefreshToken,
  bearerFromHeader
};
