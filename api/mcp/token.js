// POST /api/mcp/token
//
// The OAuth 2.1 token endpoint. Handles two grants:
//   - authorization_code: verifies PKCE (S256) and the one-time code, then
//     issues an access token (+ refresh token).
//   - refresh_token: rotates a refresh token for a fresh access token.
//
// Accepts form-urlencoded (the OAuth default) or JSON bodies.

const { sendJson, applyCors } = require('../../lib/http');
const {
  getClient,
  consumeAuthCode,
  verifyPkceS256,
  issueTokens,
  consumeRefreshToken
} = require('../../lib/mcp-oauth');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function oauthError(res, status, error, description) {
  return sendJson(res, status, { error, error_description: description });
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return oauthError(res, 405, 'invalid_request', 'Use POST.');
  }

  const body = await readBody(req);
  const grantType = body.grant_type;

  try {
    if (grantType === 'authorization_code') {
      const { code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri } = body;
      if (!code || !codeVerifier || !clientId) {
        return oauthError(res, 400, 'invalid_request', 'code, code_verifier and client_id are required.');
      }

      const record = await consumeAuthCode(code);
      if (!record) {
        return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
      }
      if (record.client_id !== clientId) {
        return oauthError(res, 400, 'invalid_grant', 'client_id does not match the authorization code.');
      }
      if (redirectUri && record.redirect_uri !== redirectUri) {
        return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization code.');
      }
      if (!verifyPkceS256(codeVerifier, record.code_challenge)) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      }

      const tokens = await issueTokens({ clientId, scope: record.scope, sub: record.sub });
      return sendJson(res, 200, tokens);
    }

    if (grantType === 'refresh_token') {
      const { refresh_token: refreshToken, client_id: clientId } = body;
      if (!refreshToken) {
        return oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
      }
      const meta = await consumeRefreshToken(refreshToken);
      if (!meta) {
        return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired.');
      }
      if (clientId && meta.client_id !== clientId) {
        return oauthError(res, 400, 'invalid_grant', 'client_id does not match the refresh token.');
      }
      // Confirm the client still exists before re-issuing.
      if (!(await getClient(meta.client_id))) {
        return oauthError(res, 400, 'invalid_grant', 'Client is no longer registered.');
      }
      const tokens = await issueTokens({ clientId: meta.client_id, scope: meta.scope, sub: meta.sub });
      return sendJson(res, 200, tokens);
    }

    return oauthError(res, 400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
  } catch (error) {
    console.error('[mcp/token] failed', { message: error.message });
    return oauthError(res, 500, 'server_error', 'Token issuance failed.');
  }
};
