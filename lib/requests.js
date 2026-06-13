// Pending access requests.
//
// A request is created when a signed-in visitor asks for access to a restricted
// page, and resolved when the owner taps Approve/Deny in Telegram. Stored at
// `req:<id>` with a generous TTL so stale requests self-clean.

const crypto = require('crypto');
const { kvGetJson, kvSetJson } = require('./storage');

const REQUEST_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function requestKey(id) {
  return `req:${id}`;
}

function newId() {
  return crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
}

async function createRequest({ email, name, slug }) {
  const id = newId();
  const record = {
    id,
    email,
    name: name || '',
    slug,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  await kvSetJson(requestKey(id), record, REQUEST_TTL_SECONDS);
  return record;
}

async function getRequest(id) {
  return kvGetJson(requestKey(id));
}

async function resolveRequest(id, status) {
  const record = await getRequest(id);
  if (!record) return null;
  record.status = status;
  record.resolvedAt = new Date().toISOString();
  await kvSetJson(requestKey(id), record, REQUEST_TTL_SECONDS);
  return record;
}

module.exports = { createRequest, getRequest, resolveRequest, REQUEST_TTL_SECONDS };
