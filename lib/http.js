// Small request/response helpers shared by the auth & admin endpoints.
//
// The project uses raw Vercel Node handlers (no framework), so we parse JSON
// bodies and cookies ourselves and resolve the request origin (for OAuth
// redirect URIs) from the incoming request.

async function readJsonBody(req) {
  // Vercel often pre-parses JSON into req.body; fall back to reading the stream.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  });
  return out;
}

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(JSON.stringify(payload));
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', [...prev, cookie]);
  } else {
    res.setHeader('Set-Cookie', [prev, cookie]);
  }
}

// Resolves the hostname the browser is talking to. Behind Vercel's proxy the
// real host/proto live in x-forwarded-* headers.
function requestHost(req) {
  const fwdHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) || req.headers.host || '';
  return String(host).split(',')[0].trim();
}

function requestProto(req) {
  const fwd = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd) || '';
  if (proto) return String(proto).split(',')[0].trim();
  return requestHost(req).startsWith('localhost') ? 'http' : 'https';
}

// The absolute origin (scheme + host) the browser is talking to, used to build
// OAuth redirect URIs. Behind Vercel's proxy this comes from x-forwarded-*.
function requestOrigin(req) {
  return `${requestProto(req)}://${requestHost(req)}`;
}

// Ensures a post-login redirect target is a local path, never an absolute URL
// pointing off-site (prevents open-redirect abuse). Falls back to "/".
function safeNextPath(input) {
  const value = String(input || '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Permissive CORS for the public OAuth/MCP endpoints. The MCP discovery, token
// and JSON-RPC endpoints are called cross-origin by MCP clients (and the MCP
// Inspector), so they must answer preflight and expose the auth challenge.
// Returns true if the request was an OPTIONS preflight that has been answered.
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, mcp-protocol-version, mcp-session-id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, mcp-session-id');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

module.exports = {
  readJsonBody,
  parseCookies,
  sendJson,
  appendSetCookie,
  requestHost,
  requestProto,
  requestOrigin,
  safeNextPath,
  clientIp,
  applyCors
};
