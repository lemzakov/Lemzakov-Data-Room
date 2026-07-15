// Per-page metadata for single-file pages — currently the page's category.
//
// Category lets you group/organize the single-file pages in /admin and browse
// them by category from the Telegram bot. It is stored SEPARATELY from the ACL
// (`acl:<slug>`) so it survives a page being flipped between public and
// restricted (a public page has no ACL record at all).
//
//   pagemeta:<slug>  ->  { category: string, updatedAt: <iso> }
//
// A page with no record is "Uncategorized". Categories are free-form short
// labels; they are created implicitly by assigning them to a page.

const { kvGetJson, kvSetJson, kvDel } = require('./storage');
const { normalizeSlug } = require('./access');

const META_PREFIX = 'pagemeta';
const MAX_CATEGORY_LEN = 60;

function metaKey(slug) {
  return `${META_PREFIX}:${slug}`;
}

// Collapses whitespace and caps the length so categories stay tidy and always
// fit inside a Telegram button / callback payload.
function normalizeCategory(input) {
  return String(input == null ? '' : input)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CATEGORY_LEN);
}

async function getPageMeta(slug) {
  return kvGetJson(metaKey(normalizeSlug(slug)));
}

async function getCategory(slug) {
  const meta = await getPageMeta(slug);
  return (meta && typeof meta.category === 'string' && meta.category) || '';
}

// Assigns (or, with an empty value, clears) a page's category. Clearing drops
// the record so an uncategorized page carries zero storage overhead.
async function setPageCategory(slug, category) {
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) {
    throw new Error('A slug is required to set a category');
  }
  const normalized = normalizeCategory(category);
  if (!normalized) {
    await kvDel(metaKey(normalizedSlug));
    return { category: '' };
  }
  const record = { category: normalized, updatedAt: new Date().toISOString() };
  await kvSetJson(metaKey(normalizedSlug), record);
  return record;
}

// Bulk read: returns a plain object mapping each slug to its category (''
// for uncategorized). One Redis round-trip per slug, run in parallel.
async function getCategoryMap(slugs) {
  const list = Array.isArray(slugs) ? slugs : [];
  const entries = await Promise.all(
    list.map(async (slug) => [slug, await getCategory(slug)])
  );
  return Object.fromEntries(entries);
}

module.exports = {
  META_PREFIX,
  MAX_CATEGORY_LEN,
  normalizeCategory,
  getPageMeta,
  getCategory,
  setPageCategory,
  getCategoryMap
};
