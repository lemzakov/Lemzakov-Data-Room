// GET /.well-known/oauth-authorization-server[/mcp]
// GET /.well-known/openid-configuration  (alias — some clients probe this)
//
// RFC 8414 Authorization Server Metadata: advertises the authorize/token/
// registration endpoints plus PKCE (S256) and dynamic client registration,
// which is everything Claude needs to drive the connector OAuth flow.

const { requestOrigin, sendJson, applyCors } = require('../../lib/http');
const { authorizationServerMetadata } = require('../../lib/mcp-oauth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  return sendJson(res, 200, authorizationServerMetadata(requestOrigin(req)));
};
