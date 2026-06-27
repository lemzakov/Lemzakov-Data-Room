// GET/POST /api/mcp/authorize
//
// The OAuth 2.1 authorization endpoint (Authorization Code + PKCE).
//
//   GET  -> render a minimal login form. The human proves they own the Data
//           Room by entering the ADMIN_TOKEN. All OAuth params ride along as
//           hidden fields (no server-side "pending request" state needed).
//   POST -> verify the admin token + PKCE params, mint a single-use auth code,
//           and 302 back to the client's registered redirect_uri with the code.
//
// Only a redirect_uri that the client registered (via DCR) is ever used as a
// redirect target, so this cannot be turned into an open redirect.

const { requestOrigin, applyCors } = require('../../lib/http');
const {
  getClient,
  verifyAdminSecret,
  issueAuthCode,
  DEFAULT_SCOPE
} = require('../../lib/mcp-oauth');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Reads the form-urlencoded body of a POST.
async function readFormBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// Pulls the OAuth params out of either the query (GET) or the body (POST).
function readParams(src) {
  return {
    response_type: src.response_type || '',
    client_id: src.client_id || '',
    redirect_uri: src.redirect_uri || '',
    code_challenge: src.code_challenge || '',
    code_challenge_method: src.code_challenge_method || '',
    state: src.state || '',
    scope: src.scope || DEFAULT_SCOPE,
    resource: src.resource || ''
  };
}

function htmlPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0d12; color: #e8eaf0; }
  .card { width: min(92vw, 420px); background: #151821; border: 1px solid #262b38;
          border-radius: 14px; padding: 28px 26px; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size: 1.15rem; margin: 0 0 6px; }
  p { color: #9aa3b2; font-size: .9rem; line-height: 1.45; margin: 0 0 18px; }
  label { display: block; font-size: .8rem; color: #c4cad6; margin: 0 0 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 11px 12px;
          border-radius: 9px; border: 1px solid #2d3342; background: #0e1117;
          color: #e8eaf0; font-size: 1rem; }
  button { margin-top: 16px; width: 100%; padding: 11px 12px; border: 0;
          border-radius: 9px; background: #3b82f6; color: #fff; font-size: 1rem;
          font-weight: 600; cursor: pointer; }
  button:hover { background: #2f6fe0; }
  .err { color: #ff8089; font-size: .85rem; margin: 0 0 14px; }
  .who { color: #6b7280; font-size: .78rem; margin-top: 16px; word-break: break-all; }
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
}

function renderLoginForm(params, origin, errorMessage) {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'code_challenge',
    'code_challenge_method', 'state', 'scope', 'resource']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}" />`)
    .join('\n      ');

  return htmlPage('Connect to the Data Room', `
    <h1>Connect to the Data&nbsp;Room</h1>
    <p>An app wants to publish HTML pages on your behalf. Enter your Data Room
       <strong>admin token</strong> to authorize it.</p>
    ${errorMessage ? `<p class="err">${escapeHtml(errorMessage)}</p>` : ''}
    <form method="POST" action="/api/mcp/authorize">
      ${hidden}
      <label for="admin_token">Admin token</label>
      <input id="admin_token" name="admin_token" type="password" autocomplete="current-password"
             autofocus required placeholder="ADMIN_TOKEN" />
      <button type="submit">Authorize</button>
    </form>
    <div class="who">Requesting client: ${escapeHtml(params.client_id || 'unknown')}</div>`);
}

function renderError(message) {
  return htmlPage('Authorization error', `
    <h1>Cannot authorize</h1>
    <p class="err">${escapeHtml(message)}</p>
    <p>Close this window and try connecting again.</p>`);
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.end(html);
}

// Validates client + redirect_uri. Returns { client } or { error }.
async function validateClient(params) {
  const client = await getClient(params.client_id);
  if (!client) return { error: 'Unknown client_id. Re-register and try again.' };
  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(params.redirect_uri)) {
    return { error: 'redirect_uri does not match a registered URI for this client.' };
  }
  return { client };
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  const origin = requestOrigin(req);

  if (req.method === 'GET') {
    const params = readParams(req.query || {});
    const { error } = await validateClient(params);
    if (error) return sendHtml(res, 400, renderError(error));
    return sendHtml(res, 200, renderLoginForm(params, origin));
  }

  if (req.method !== 'POST') {
    return sendHtml(res, 405, renderError('Method not allowed'));
  }

  const body = await readFormBody(req);
  const params = readParams(body);

  // These params are validated before we trust the redirect target.
  const { client, error } = await validateClient(params);
  if (error) return sendHtml(res, 400, renderError(error));

  if (params.response_type !== 'code') {
    return sendHtml(res, 400, renderError('Unsupported response_type (only "code").'));
  }
  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    return sendHtml(res, 400, renderError('PKCE with code_challenge_method=S256 is required.'));
  }

  // Authenticate the human via the admin token.
  if (!verifyAdminSecret(body.admin_token)) {
    return sendHtml(res, 401, renderLoginForm(params, origin, 'Incorrect admin token. Try again.'));
  }

  const code = await issueAuthCode({
    clientId: client.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    scope: params.scope,
    resource: params.resource,
    sub: 'owner'
  });

  const location = new URL(params.redirect_uri);
  location.searchParams.set('code', code);
  if (params.state) location.searchParams.set('state', params.state);

  res.statusCode = 302;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', location.toString());
  return res.end();
};
