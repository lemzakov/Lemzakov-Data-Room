// POST /mcp  (and /api/mcp)
//
// The remote MCP server endpoint (Streamable HTTP transport). Bearer-token
// protected: a valid OAuth access token (issued by /api/mcp/token) is required.
// Unauthenticated requests get a 401 with a WWW-Authenticate header that points
// MCP clients at the protected-resource metadata, kicking off the OAuth flow.
//
// The tools themselves (publish_page, set_page_access, get_page, list_pages)
// live in lib/mcp-core.js and run in-process against Redis.

const { requestOrigin, readJsonBody, applyCors } = require('../../lib/http');
const { verifyAccessToken, bearerFromHeader } = require('../../lib/mcp-oauth');
const { handleMcpMessage } = require('../../lib/mcp-core');

function challenge(res, origin, status, message) {
  res.statusCode = status;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`
  );
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify({ error: 'unauthorized', error_description: message }));
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  const origin = requestOrigin(req);

  // --- Authenticate every request via the OAuth bearer token. -------------
  const token = bearerFromHeader(req);
  if (!token) {
    return challenge(res, origin, 401, 'Missing bearer token.');
  }
  const tokenMeta = await verifyAccessToken(token);
  if (!tokenMeta) {
    return challenge(res, origin, 401, 'Invalid or expired bearer token.');
  }

  // Streamable HTTP: messages are sent via POST. We do not offer an SSE stream,
  // so a GET (stream open) is answered with 405 once authenticated.
  if (req.method === 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'method_not_allowed', error_description: 'Use POST for JSON-RPC.' }));
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.end();
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  // Support JSON-RPC batches as well as single messages.
  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  for (const msg of messages) {
    const response = await handleMcpMessage(msg);
    if (response) responses.push(response);
  }

  // Notifications-only requests get a 202 with no body.
  if (responses.length === 0) {
    res.statusCode = 202;
    return res.end();
  }

  res.statusCode = 200;
  const out = Array.isArray(payload) ? responses : responses[0];
  return res.end(JSON.stringify(out));
};
