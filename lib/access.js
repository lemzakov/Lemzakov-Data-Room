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

const { kvGetJson, kvSetJson, kvDel } = require('./storage');

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

async function getAcl(slug) {
  return kvGetJson(aclKey(normalizeSlug(slug)));
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
async function setAcl(slug, { protected: isProtected = true, allow = [] } = {}) {
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
    await kvDel(aclKey(normalizedSlug));
  } else {
    await kvSetJson(aclKey(normalizedSlug), record);
  }

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
