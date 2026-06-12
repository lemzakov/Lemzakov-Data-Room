// Per-page access control.
//
// Each page is identified by its slug. An access record lives at `acl:<slug>`:
//
//   { protected: true, allow: ["a@x.com", "b@y.com"], updatedAt: <iso> }
//
// A page with NO record (or `protected: false`) is PUBLIC — this keeps the
// existing Drive-synced pages working unchanged (protection is opt-in).
//
// `allow` is a list of normalized email addresses. A signed-in user may view a
// protected page only if their session email is in that list.
//
// To answer "is this email allowed on ANY page?" cheaply (used to gate sending
// verification emails), we maintain a reverse index per email at
// `emailpages:<email>` (a Redis set of slugs).

const {
  kvGetJson,
  kvSetJson,
  kvDel,
  setAdd,
  setRemove,
  setMembers
} = require('./storage');

const ACL_PREFIX = 'acl';
const EMAIL_INDEX_PREFIX = 'emailpages';

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

function emailIndexKey(email) {
  return `${EMAIL_INDEX_PREFIX}:${email}`;
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

// Upserts the access record for a page and keeps the reverse email index in
// sync. Pass `protected: false` (or an empty/absent allow list with protected
// false) to make a page public again.
async function setAcl(slug, { protected: isProtected = true, allow = [] } = {}) {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) {
    throw new Error('A slug is required to set access');
  }

  const cleanedAllow = Array.from(
    new Set(
      allow
        .map(normalizeEmail)
        .filter((email) => email && isValidEmail(email))
    )
  );

  const previous = await getAcl(normalizedSlug);
  const previousAllow = previous && Array.isArray(previous.allow) ? previous.allow : [];

  const record = {
    protected: Boolean(isProtected),
    allow: cleanedAllow,
    updatedAt: new Date().toISOString()
  };

  if (!record.protected) {
    // Public page: drop the record entirely so serving stays zero-overhead.
    await kvDel(aclKey(normalizedSlug));
  } else {
    await kvSetJson(aclKey(normalizedSlug), record);
  }

  // Reconcile the reverse index: add newly-allowed emails, remove dropped ones.
  const nextSet = new Set(record.protected ? cleanedAllow : []);
  const prevSet = new Set(previousAllow);

  for (const email of nextSet) {
    if (!prevSet.has(email)) {
      await setAdd(emailIndexKey(email), normalizedSlug);
    }
  }
  for (const email of prevSet) {
    if (!nextSet.has(email)) {
      await setRemove(emailIndexKey(email), normalizedSlug);
    }
  }

  return record;
}

// Slugs this email is allowed to view (used for diagnostics / future UI).
async function pagesForEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  return setMembers(emailIndexKey(normalized));
}

// True if the email is on at least one page's allow list. Used to decide
// whether it is worth emailing a verification code at all.
async function emailAllowedAnywhere(email) {
  const pages = await pagesForEmail(email);
  return pages.length > 0;
}

module.exports = {
  normalizeEmail,
  normalizeSlug,
  isValidEmail,
  isAllowed,
  getAcl,
  setAcl,
  pagesForEmail,
  emailAllowedAnywhere,
  ACL_PREFIX,
  EMAIL_INDEX_PREFIX
};
