// Opaque, server-side sessions with a 6-month lifetime.
//
// On successful Google sign-in we mint a random token, store the session at
// `session:<token>` in Redis with a matching TTL, and set it as an httpOnly,
// Secure, SameSite=Lax cookie. The cookie holds no user data — only the random
// token — so it cannot be tampered with, and sessions can be revoked by
// deleting the Redis key.

const crypto = require('crypto');
const { kvGetJson, kvSetJson, kvDel } = require('./storage');
const { appendSetCookie, parseCookies, requestHost } = require('./http');

const COOKIE_NAME = 'ldr_session';
const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60; // ~6 months

function sessionKey(token) {
  return `session:${token}`;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createSession(email, extra = {}) {
  const token = newToken();
  const now = Date.now();
  const session = {
    email,
    name: extra.name || '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString()
  };
  await kvSetJson(sessionKey(token), session, SESSION_TTL_SECONDS);
  return { token, session };
}

async function getSession(token) {
  if (!token) return null;
  return kvGetJson(sessionKey(token));
}

async function destroySession(token) {
  if (!token) return;
  await kvDel(sessionKey(token));
}

// Reads the session referenced by the request's cookie, if any.
async function getSessionFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const session = await getSession(token);
  return session ? { token, session } : null;
}

function serializeCookie(token, { req, maxAge = SESSION_TTL_SECONDS } = {}) {
  const secure = !(req && requestHost(req).startsWith('localhost'));
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(res, token, req) {
  appendSetCookie(res, serializeCookie(token, { req }));
}

function clearSessionCookie(res, req) {
  appendSetCookie(res, serializeCookie('', { req, maxAge: 0 }));
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSession,
  getSession,
  destroySession,
  getSessionFromRequest,
  setSessionCookie,
  clearSessionCookie
};
