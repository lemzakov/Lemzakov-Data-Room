// Project portals.
//
// A "project" maps ONE private Google Drive folder to a public URL slug. Every
// .html file (and static asset) under that folder — recursively — is mirrored
// into Redis and served at `/<slug>/...`, behind Google sign-in + a per-project
// allow list. This is separate from, and does not affect, the existing
// single-file publishing flow (html:<slug> + acl:<slug>).
//
// Persistence (Redis, the project's existing durable store):
//   project:<slug>        JSON config record (see PROJECT shape below)
//   projects:index        Redis set of every project slug
//   projectlog:<slug>     JSON array of recent sync log lines (capped)
//   projfile:<slug>:<rel> mirrored file content (see lib/project-storage.js)
//
// Project record shape:
//   {
//     slug, driveFolderId, entryFile,
//     allowedEmails: string[], allowedDomain: string,
//     lastSyncedAt, fileManifest: { <relPath>: <modifiedTime> },
//     fileCount, status, lastError, createdAt, updatedAt
//   }

const {
  kvGetJson, kvSetJson, kvDel,
  setAdd, setRemove, setMembers
} = require('./storage');

const PROJECT_PREFIX = 'project';
const PROJECT_INDEX = 'projects:index';
const PROJECT_LOG_PREFIX = 'projectlog';
const MAX_LOG_LINES = 60;

// Slugs that must never become a project because they collide with existing
// routes or static files. Single-file page slugs are also rejected at create
// time (see assertSlugAvailable) so the two systems can share the URL space.
const RESERVED_SLUGS = new Set([
  'admin', 'login', 'logout', 'request-access', 'secret-refresh', 'secret',
  'api', 'public', 'assets', 'static', 'favicon.ico', 'robots.txt',
  'sitemap.xml', 'index', '_next', 'auth', 'access', 'diagnose', 'sync',
  'projects'
]);

function normalizeEmail(input) {
  return String(input || '').trim().toLowerCase();
}

function normalizeDomain(input) {
  return String(input || '').trim().toLowerCase().replace(/^@/, '');
}

function normalizeSlug(input) {
  return String(input || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidDomain(domain) {
  if (!domain) return true; // optional
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain);
}

// URL-safe slug: lowercase letters/digits/hyphens, must start & end
// alphanumeric, 1–40 chars. Mirrors the constraints of a DNS-style label so it
// is always a clean single URL path segment.
function isValidSlugFormat(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug);
}

function isReservedSlug(slug) {
  return RESERVED_SLUGS.has(slug);
}

function projectKey(slug) {
  return `${PROJECT_PREFIX}:${slug}`;
}

function logKey(slug) {
  return `${PROJECT_LOG_PREFIX}:${slug}`;
}

function cleanEmailList(emails) {
  return Array.from(
    new Set(
      (Array.isArray(emails) ? emails : [])
        .map(normalizeEmail)
        .filter((e) => e && isValidEmail(e))
    )
  );
}

// Pure membership check: a signed-in viewer may see a project if their verified
// email is explicitly allowed OR matches the project's allowed domain.
function isProjectMember(email, project) {
  const normalized = normalizeEmail(email);
  if (!normalized || !project) return false;
  if (Array.isArray(project.allowedEmails) && project.allowedEmails.includes(normalized)) {
    return true;
  }
  const domain = normalizeDomain(project.allowedDomain);
  if (domain) {
    const at = normalized.lastIndexOf('@');
    if (at !== -1 && normalized.slice(at + 1) === domain) return true;
  }
  return false;
}

async function getProject(slug) {
  return kvGetJson(projectKey(normalizeSlug(slug)));
}

async function listProjectSlugs() {
  const slugs = await setMembers(PROJECT_INDEX);
  return Array.from(new Set(slugs)).sort();
}

async function listProjects() {
  const slugs = await listProjectSlugs();
  const projects = await Promise.all(slugs.map((slug) => getProject(slug)));
  return projects.filter(Boolean);
}

// Validates a slug for creation: format, not reserved, not already a project,
// and not colliding with a single-file page. `existingPageSlugs` is injected so
// this stays testable and avoids a hard dependency on the html store here.
async function assertSlugAvailable(slug, { existingPageSlugs = [] } = {}) {
  const normalized = normalizeSlug(slug);
  if (!normalized) throw new Error('A project slug is required');
  if (!isValidSlugFormat(normalized)) {
    throw new Error('Slug must be lowercase letters, digits and hyphens (1–40 chars), starting and ending alphanumeric');
  }
  if (isReservedSlug(normalized)) {
    throw new Error(`"${normalized}" is a reserved route and cannot be used as a project slug`);
  }
  if (await getProject(normalized)) {
    throw new Error(`A project named "${normalized}" already exists`);
  }
  if (existingPageSlugs.map(normalizeSlug).includes(normalized)) {
    throw new Error(`"${normalized}" already serves a single-file page; pick another slug`);
  }
  return normalized;
}

async function saveProject(project) {
  const slug = normalizeSlug(project.slug);
  if (!slug) throw new Error('Cannot save a project without a slug');
  const record = { ...project, slug, updatedAt: new Date().toISOString() };
  await kvSetJson(projectKey(slug), record);
  await setAdd(PROJECT_INDEX, slug);
  return record;
}

async function createProject({ slug, driveFolderId, entryFile, allowedEmails, allowedDomain }, options = {}) {
  const normalized = await assertSlugAvailable(slug, options);
  const folderId = String(driveFolderId || '').trim();
  if (!folderId) throw new Error('A Google Drive folder ID is required');

  const domain = normalizeDomain(allowedDomain);
  if (!isValidDomain(domain)) throw new Error(`Invalid allowed domain: "${domain}"`);

  const now = new Date().toISOString();
  const record = {
    slug: normalized,
    driveFolderId: folderId,
    entryFile: String(entryFile || '').trim(),
    allowedEmails: cleanEmailList(allowedEmails),
    allowedDomain: domain,
    fileManifest: {},
    fileCount: 0,
    lastSyncedAt: null,
    status: 'created',
    lastError: null,
    createdAt: now,
    updatedAt: now
  };
  return saveProject(record);
}

// Partial update of mutable, admin-editable fields only. Sync-owned fields
// (fileManifest, status, lastSyncedAt, ...) are updated by the sync module.
async function updateProject(slug, patch = {}) {
  const existing = await getProject(slug);
  if (!existing) throw new Error(`Project "${slug}" not found`);

  const next = { ...existing };
  if (patch.driveFolderId !== undefined) {
    const folderId = String(patch.driveFolderId || '').trim();
    if (!folderId) throw new Error('A Google Drive folder ID is required');
    next.driveFolderId = folderId;
  }
  if (patch.entryFile !== undefined) {
    next.entryFile = String(patch.entryFile || '').trim();
  }
  if (patch.allowedEmails !== undefined) {
    next.allowedEmails = cleanEmailList(patch.allowedEmails);
  }
  if (patch.allowedDomain !== undefined) {
    const domain = normalizeDomain(patch.allowedDomain);
    if (!isValidDomain(domain)) throw new Error(`Invalid allowed domain: "${domain}"`);
    next.allowedDomain = domain;
  }
  return saveProject(next);
}

async function addAllowedEmail(slug, email) {
  const existing = await getProject(slug);
  if (!existing) throw new Error(`Project "${slug}" not found`);
  const normalized = normalizeEmail(email);
  if (!normalized || !isValidEmail(normalized)) throw new Error('A valid email is required');
  const allowedEmails = cleanEmailList([...(existing.allowedEmails || []), normalized]);
  return saveProject({ ...existing, allowedEmails });
}

async function removeAllowedEmail(slug, email) {
  const existing = await getProject(slug);
  if (!existing) throw new Error(`Project "${slug}" not found`);
  const normalized = normalizeEmail(email);
  const allowedEmails = (existing.allowedEmails || []).filter((e) => e !== normalized);
  return saveProject({ ...existing, allowedEmails });
}

async function deleteProject(slug, { deleteFilesImpl } = {}) {
  const normalized = normalizeSlug(slug);
  const existing = await getProject(normalized);
  if (!existing) return false;
  if (typeof deleteFilesImpl === 'function') {
    await deleteFilesImpl(normalized);
  }
  await kvDel(projectKey(normalized));
  await kvDel(logKey(normalized));
  await setRemove(PROJECT_INDEX, normalized);
  return true;
}

// --- Sync logs ----------------------------------------------------------

async function appendLog(slug, level, message, extra) {
  const key = logKey(normalizeSlug(slug));
  const lines = (await kvGetJson(key)) || [];
  lines.push({
    at: new Date().toISOString(),
    level: level || 'info',
    message: String(message || ''),
    ...(extra ? { extra } : {})
  });
  const trimmed = lines.slice(-MAX_LOG_LINES);
  await kvSetJson(key, trimmed);
  return trimmed;
}

async function getLogs(slug) {
  return (await kvGetJson(logKey(normalizeSlug(slug)))) || [];
}

module.exports = {
  PROJECT_PREFIX,
  PROJECT_INDEX,
  RESERVED_SLUGS,
  normalizeEmail,
  normalizeDomain,
  normalizeSlug,
  isValidEmail,
  isValidDomain,
  isValidSlugFormat,
  isReservedSlug,
  isProjectMember,
  cleanEmailList,
  getProject,
  listProjectSlugs,
  listProjects,
  assertSlugAvailable,
  saveProject,
  createProject,
  updateProject,
  addAllowedEmail,
  removeAllowedEmail,
  deleteProject,
  appendLog,
  getLogs
};
