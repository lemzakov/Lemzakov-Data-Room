// GET /.well-known/oauth-protected-resource[/mcp]
//
// RFC 9728 Protected Resource Metadata. The first thing an MCP client fetches
// after it sees a 401 from the MCP endpoint: it points at the authorization
// server that guards this resource.

const { requestOrigin, sendJson, applyCors } = require('../../lib/http');
const { protectedResourceMetadata } = require('../../lib/mcp-oauth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  return sendJson(res, 200, protectedResourceMetadata(requestOrigin(req)));
};
