// POST /api/mcp/register
//
// RFC 7591 Dynamic Client Registration. Claude has no pre-shared client id, so
// it registers itself here (sending its redirect_uris) and gets back a
// client_id. Public client — no secret is issued; PKCE secures the exchange.

const { readJsonBody, sendJson, applyCors } = require('../../lib/http');
const { registerClient } = require('../../lib/mcp-oauth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const client = await registerClient(body);
    // RFC 7591: return the registered metadata with HTTP 201.
    return sendJson(res, 201, client);
  } catch (error) {
    return sendJson(res, 400, {
      error: 'invalid_client_metadata',
      error_description: error.message
    });
  }
};
