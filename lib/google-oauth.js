// Standard Google OAuth 2.0 / OpenID Connect sign-in.
//
// Flow:
//   1. start    -> redirect the browser to Google's consent screen.
//   2. callback -> exchange the returned `code` for tokens at Google's token
//      endpoint (server-to-server, over TLS) and read the `id_token`.
//
// Because the id_token is received directly from Google's token endpoint over
// HTTPS (not via the browser), Google's docs allow trusting it without a
// separate JWKS signature check. We still validate issuer + audience + expiry.
//
// Config:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   (required)
//   GOOGLE_OAUTH_REDIRECT_URI                            (optional override)

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function isConfigured() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function clientId() {
  return (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
}

function clientSecret() {
  return (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
}

// The redirect URI must exactly match one registered in the Google Cloud
// console. Derive it from the request origin unless explicitly overridden.
function redirectUri(origin) {
  const override = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (override) return override;
  return `${origin}/api/auth/google/callback`;
}

function buildAuthUrl({ origin, state }) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function decodeJwtPayload(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const json = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(json);
}

// Exchanges an authorization code for the user's verified identity.
// Returns { email, emailVerified, name, sub }.
async function exchangeCode({ code, origin }, options = {}) {
  const { fetchImpl = fetch } = options;

  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(origin),
    grant_type: 'authorization_code'
  }).toString();

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Google token response was not valid JSON');
  }
  if (!data.id_token) {
    throw new Error('Google token response did not include an id_token');
  }

  const claims = decodeJwtPayload(data.id_token);

  if (!VALID_ISSUERS.has(claims.iss)) {
    throw new Error('id_token has an unexpected issuer');
  }
  if (claims.aud !== clientId()) {
    throw new Error('id_token audience does not match this client');
  }
  if (claims.exp && Date.now() / 1000 > claims.exp) {
    throw new Error('id_token has expired');
  }
  if (!claims.email) {
    throw new Error('id_token did not include an email');
  }

  return {
    email: String(claims.email).toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name || claims.given_name || '',
    sub: claims.sub || ''
  };
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  redirectUri,
  exchangeCode,
  decodeJwtPayload,
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT
};
