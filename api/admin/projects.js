// Admin API for project portals (CRUD + access + sync controls).
//
//   GET  /api/admin/projects              -> list all projects (with status)
//   GET  /api/admin/projects?slug=&logs=1 -> recent sync logs for one project
//   POST /api/admin/projects              -> { action, ... }
//
// Actions: create | update | delete | sync | addEmail | removeEmail | setDomain.
// Auth: ADMIN_TOKEN (or SYNC_SECRET) via X-Admin-Token header or ?token=.

const { listSlugs } = require('../../lib/storage');
const { isAdminAuthorized } = require('../../lib/admin');
const { readJsonBody, sendJson } = require('../../lib/http');
const { deleteAllProjectFiles } = require('../../lib/project-storage');
const { runProjectSync } = require('../../lib/project-sync');
const {
  listProjects, getProject, createProject, updateProject, deleteProject,
  addAllowedEmail, removeAllowedEmail, getLogs, normalizeSlug
} = require('../../lib/projects');

function publicProject(p) {
  return {
    slug: p.slug,
    driveFolderId: p.driveFolderId,
    entryFile: p.entryFile || '',
    entryPath: p.entryPath || null,
    allowedEmails: p.allowedEmails || [],
    allowedDomain: p.allowedDomain || '',
    fileCount: p.fileCount || 0,
    lastSyncedAt: p.lastSyncedAt || null,
    status: p.status || 'created',
    lastError: p.lastError || null
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (!isAdminAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    try {
      const slug = normalizeSlug(req.query.slug || '');
      if (slug && (req.query.logs === '1' || req.query.logs === 'true')) {
        return sendJson(res, 200, { ok: true, slug, logs: await getLogs(slug) });
      }
      const projects = (await listProjects()).map(publicProject);
      return sendJson(res, 200, { ok: true, projects });
    } catch (error) {
      console.error('[admin/projects] list failed', { message: error.message });
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  if (!isAdminAuthorized(req, body)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const action = String(body.action || '').trim();
  const slug = normalizeSlug(body.slug || '');

  try {
    switch (action) {
      case 'create': {
        const existingPageSlugs = await listSlugs('html');
        const project = await createProject({
          slug,
          driveFolderId: body.driveFolderId,
          entryFile: body.entryFile,
          allowedEmails: body.allowedEmails,
          allowedDomain: body.allowedDomain
        }, { existingPageSlugs });
        return sendJson(res, 200, { ok: true, project: publicProject(project) });
      }

      case 'update': {
        const project = await updateProject(slug, {
          driveFolderId: body.driveFolderId,
          entryFile: body.entryFile,
          allowedEmails: body.allowedEmails,
          allowedDomain: body.allowedDomain
        });
        return sendJson(res, 200, { ok: true, project: publicProject(project) });
      }

      case 'addEmail': {
        const project = await addAllowedEmail(slug, body.email);
        return sendJson(res, 200, { ok: true, project: publicProject(project) });
      }

      case 'removeEmail': {
        const project = await removeAllowedEmail(slug, body.email);
        return sendJson(res, 200, { ok: true, project: publicProject(project) });
      }

      case 'setDomain': {
        const project = await updateProject(slug, { allowedDomain: body.allowedDomain });
        return sendJson(res, 200, { ok: true, project: publicProject(project) });
      }

      case 'delete': {
        const removed = await deleteProject(slug, { deleteFilesImpl: deleteAllProjectFiles });
        return sendJson(res, 200, { ok: true, deleted: removed });
      }

      case 'sync': {
        const force = body.force === true || body.force === 'true';
        try {
          const result = await runProjectSync(slug, { force });
          const project = await getProject(slug);
          return sendJson(res, 200, { ok: true, result, project: project ? publicProject(project) : null });
        } catch (error) {
          // Surface the failure but keep the (updated) status/logs available.
          const project = await getProject(slug);
          return sendJson(res, 200, {
            ok: false,
            error: error.message,
            details: error.details || null,
            project: project ? publicProject(project) : null
          });
        }
      }

      default:
        return sendJson(res, 400, { ok: false, error: `Unknown action: "${action}"` });
    }
  } catch (error) {
    console.error('[admin/projects] action failed', { action, slug, message: error.message });
    return sendJson(res, 400, { ok: false, error: error.message });
  }
};
