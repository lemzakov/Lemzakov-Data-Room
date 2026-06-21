// Serves a project's mirrored files behind Google sign-in + per-project access.
//
// Every project request requires: (1) a valid session (Google OAuth), and
// (2) membership in the project (email on the allow list or matching the
// allowed domain). Unauthenticated visitors are bounced to Google sign-in;
// authenticated-but-unauthorized visitors get a clean "no access" page.

const projectStorage = require('./project-storage');
const { resolveEntryPath } = require('./project-sync');
const { isProjectMember } = require('./projects');
const { getSessionFromRequest } = require('./session');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Normalizes the path portion after the slug into a safe relative path. Returns
// '' for the project root (entry point). Rejects directory traversal.
function normalizeRelPath(rawPath) {
  let value = String(rawPath || '');
  try { value = decodeURIComponent(value); } catch {}
  value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!value) return '';
  const parts = value.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null; // traversal attempt
  return parts.join('/');
}

function currentPath(slug, relPath) {
  return relPath ? `/${slug}/${relPath}` : `/${slug}/`;
}

function renderNoAccessPage(project, email) {
  const slug = escapeHtml(project.slug);
  const who = email ? `signed in as <b>${escapeHtml(email)}</b>` : 'not signed in';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>No access — ${slug}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem; color: #1f2937; }
    h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
    p { color: #374151; }
    .card { border: 1px solid #e5e7eb; border-radius: .75rem; padding: 1.25rem; }
    .muted { color: #6b7280; font-size: .9rem; }
    a.btn { display: inline-block; margin-top: 1rem; padding: .6rem 1rem; font-weight: 600; color: #fff; background: #2563eb; border-radius: .5rem; text-decoration: none; }
    code { background: #f3f4f6; padding: .05rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>No access</h1>
  <div class="card">
    <p>You don't have access to the <code>${slug}</code> project.</p>
    <p class="muted">You are ${who}. Ask the project owner to add your email or domain to this project's allow list.</p>
    <a class="btn" href="/api/auth/google/start?next=${encodeURIComponent('/' + project.slug + '/')}">Sign in with a different account</a>
  </div>
</body>
</html>`;
}

// Serves a single file (or the entry point) from an already-resolved project.
// `store` is injectable for testing.
async function serveProject(req, res, { project, rawPath, store = projectStorage } = {}) {
  const relPathInput = normalizeRelPath(rawPath);
  if (relPathInput === null) {
    res.statusCode = 400;
    return res.end('Bad request');
  }

  // 1. Require a signed-in session.
  const current = await getSessionFromRequest(req);
  const email = current && current.session && current.session.email;
  if (!email) {
    res.statusCode = 302;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', `/api/auth/google/start?next=${encodeURIComponent(currentPath(project.slug, relPathInput))}`);
    return res.end();
  }

  // 2. Require project membership.
  if (!isProjectMember(email, project)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(renderNoAccessPage(project, email));
  }

  // 3. Resolve the target file (entry point for the project root).
  let relPath = relPathInput;
  if (!relPath) {
    relPath = project.entryPath || resolveEntryPath(await store.listProjectPaths(project.slug), project.entryFile);
    if (!relPath) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<h1>404</h1><p>This project has no files yet. Run a sync from /admin.</p>');
    }
  }

  const file = await store.readProjectFile(project.slug, relPath);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<h1>404</h1><p>File not found.</p>');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', file.contentType);
  // Project files are access-controlled: never let a shared cache store them.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.end(file.body);
}

module.exports = {
  escapeHtml,
  normalizeRelPath,
  currentPath,
  renderNoAccessPage,
  serveProject
};
