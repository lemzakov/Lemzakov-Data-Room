// User + passkey credential storage.
//
// A user is keyed by their (verified) email at `user:<email>`:
//
//   {
//     email,
//     createdAt,
//     credentials: [
//       { id, publicKey, counter, transports, createdAt, lastUsedAt }
//     ]
//   }
//
// `id` is the credential ID (base64url string) and `publicKey` is the COSE
// public key (base64url-encoded bytes) returned by @simplewebauthn/server.

const { kvGetJson, kvSetJson } = require('./storage');
const { normalizeEmail } = require('./access');

function userKey(email) {
  return `user:${email}`;
}

async function getUser(email) {
  return kvGetJson(userKey(normalizeEmail(email)));
}

async function userExists(email) {
  const user = await getUser(email);
  return Boolean(user && Array.isArray(user.credentials) && user.credentials.length);
}

async function saveUser(user) {
  await kvSetJson(userKey(normalizeEmail(user.email)), user);
}

// Adds a freshly-registered passkey to the user (creating the user if needed).
async function addCredential(email, credential) {
  const normalized = normalizeEmail(email);
  const existing = (await getUser(normalized)) || {
    email: normalized,
    createdAt: new Date().toISOString(),
    credentials: []
  };
  // Replace any credential with the same id (idempotent re-registration).
  existing.credentials = existing.credentials.filter((c) => c.id !== credential.id);
  existing.credentials.push({
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter || 0,
    transports: credential.transports || [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  });
  await saveUser(existing);
  return existing;
}

async function getCredentials(email) {
  const user = await getUser(email);
  return user && Array.isArray(user.credentials) ? user.credentials : [];
}

async function findCredential(email, credentialId) {
  const creds = await getCredentials(email);
  return creds.find((c) => c.id === credentialId) || null;
}

// Persists the rolling signature counter after a successful authentication.
async function updateCredentialCounter(email, credentialId, newCounter) {
  const user = await getUser(email);
  if (!user) return;
  const cred = user.credentials.find((c) => c.id === credentialId);
  if (!cred) return;
  cred.counter = newCounter;
  cred.lastUsedAt = new Date().toISOString();
  await saveUser(user);
}

module.exports = {
  getUser,
  userExists,
  saveUser,
  addCredential,
  getCredentials,
  findCredential,
  updateCredentialCounter
};
