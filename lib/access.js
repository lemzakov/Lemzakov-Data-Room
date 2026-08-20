// Per-page access control.
//
// Each page is identified by its slug. An access record lives at `acl:<slug>`:
//
//   { protected: true, allow: ["a@x.com", "b@y.com"], updatedAt: <iso> }
//
// A page with NO record (or `protected: false`) is PUBLIC — this keeps the
// existing Drive-synced pages working unchanged (protection is opt-in).
//
// `allow` is a list of normalized email addresses approved to view the page.
// A signed-in user (Google OAuth) may view a protected page only if their
// verified email is on that list. New people are added via the Telegram
// access-request approval flow (see lib/telegram.js / api/telegram/webhook.js).

// Access records live in Blob, with Redis read as a fallback for pages whose
// ACL predates the cutover. Blob is the write target because Redis rejects
// every write once it reaches maxmemory — which would otherwise make it
// impossible to restrict a page precisely when the store is under pressure.

const { kvGetJson, kvSetJson, kvDel } = require('./storage');
const blobStorage = require('./blob-storage');

const ACL_PREFIX = 'acl';

function normalizeEmail(input) {
  return String(input || '').trim().toLowerCase();
}

function normalizeSlug(input) {
  return String(input || '').trim().toLowerCase();
}

function isValidEmail(email) {
  // Deliberately permissive but enough to reject obvious junk.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function aclKey(slug) {
  return `${ACL_PREFIX}:${slug}`;
}

// Pure helper: given an ACL record (or null) and an email, decide visibility.
function isAllowed(email, acl) {
  if (!acl || !acl.protected) return true; // public page
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return Array.isArray(acl.allow) && acl.allow.includes(normalized);
}

// Both stores are read concurrently and Blob wins, so a page whose ACL was
// written before the cutover keeps its protection without a migration.
async function getAcl(slug, deps = {}) {
  const blob = deps.blob || blobStorage;
  const normalized = normalizeSlug(slug);
  const readRedis = deps.kvGetJson || kvGetJson;
  if (!blob.blobEnabled()) return readRedis(aclKey(normalized));

  const [fromBlob, fromRedis] = await Promise.all([
    blob.readAcl(normalized),
    readRedis(aclKey(normalized)).catch(() => null)
  ]);
  return fromBlob != null ? fromBlob : fromRedis;
}

function cleanAllowList(allow) {
  return Array.from(
    new Set(
      (Array.isArray(allow) ? allow : [])
        .map(normalizeEmail)
        .filter((email) => email && isValidEmail(email))
    )
  );
}

// Upserts the access record for a page. Pass `protected: false` to make a page
// public again. `protected: true` with an empty allow list is a valid
// "restricted, awaiting approvals" state.
async function setAcl(slug, { protected: isProtected = true, allow = [] } = {}, deps = {}) {
  const blob = deps.blob || blobStorage;
  const del = deps.kvDel || kvDel;
  const setJson = deps.kvSetJson || kvSetJson;
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) {
    throw new Error('A slug is required to set access');
  }

  const record = {
    protected: Boolean(isProtected),
    allow: cleanAllowList(allow),
    updatedAt: new Date().toISOString()
  };

  if (!record.protected) {
    // Public page: drop the record entirely so serving stays zero-overhead.
    // BOTH stores must be cleared — leaving the Redis copy behind would let the
    // fallback read keep the page protected after it was opened up.
    await Promise.all([
      del(aclKey(normalizedSlug)),
      blob.blobEnabled() ? blob.deleteAcl(normalizedSlug) : Promise.resolve(false)
    ]);
    return record;
  }

  if (!blob.blobEnabled()) {
    await setJson(aclKey(normalizedSlug), record);
    return record;
  }

  await blob.saveAcl(normalizedSlug, record);
  // Drop any pre-cutover Redis copy now that Blob holds the authoritative
  // record: it frees memory and leaves no stale allow list behind. DEL is not
  // a denyoom command, so this still succeeds while Redis is full.
  await del(aclKey(normalizedSlug)).catch(() => {});
  return record;
}

// Adds a single approved email to a protected page's allow list (idempotent).
// Used by the Telegram approval webhook. Ensures the page is protected.
async function addAllowedEmail(slug, email) {
  const normalizedSlug = normalizeSlug(slug);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedSlug || !normalizedEmail || !isValidEmail(normalizedEmail)) {
    throw new Error('A valid slug and email are required');
  }
  const existing = await getAcl(normalizedSlug);
  const allow = existing && Array.isArray(existing.allow) ? existing.allow.slice() : [];
  if (!allow.includes(normalizedEmail)) allow.push(normalizedEmail);
  return setAcl(normalizedSlug, { protected: true, allow });
}

module.exports = {
  normalizeEmail,
  normalizeSlug,
  isValidEmail,
  isAllowed,
  getAcl,
  setAcl,
  addAllowedEmail,
  cleanAllowList,
  ACL_PREFIX
};
