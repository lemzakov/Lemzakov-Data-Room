// Serves project files at /<slug>/<path> (and the entry point at /<slug>/).
//
// Wired in vercel.json:  /([^/]+)/(.*) -> /api/project?slug=$1&path=$2
// Access is enforced here (Google sign-in + per-project membership). The
// single-file publishing flow is unaffected: it serves single-segment URLs via
// /api/serve, which only routes to a project when one exists for that slug.
//
// When the slug is NOT a project, this same URL shape addresses the images
// attached to a single-file page (/<slug>/<image>, see lib/page-assets.js).
// Projects are checked first, so an existing project's file tree always wins
// and nothing about the project flow changes.

const { getProject } = require('../lib/projects');
const { serveProject } = require('../lib/project-serve');
const { servePageAsset } = require('../lib/asset-serve');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed');
  }

  const slug = (req.query.slug || '').toString().toLowerCase().trim();
  const rawPath = (req.query.path || '').toString();

  if (!slug) {
    return res.status(400).send('Missing project slug');
  }

  try {
    // A project lookup needs Redis. If it fails, treat the slug as "not a
    // project" and carry on: a public page's images have no Redis dependency of
    // their own and should keep serving, exactly as api/serve.js keeps serving
    // pages through a Redis hiccup.
    let project = null;
    try {
      project = await getProject(slug);
    } catch (error) {
      console.error('[project] lookup failed; trying page assets', { slug, message: error.message });
    }
    if (project) {
      return serveProject(req, res, { project, rawPath });
    }

    // Not a project: this may be an image attached to the page at /<slug>.
    if (await servePageAsset(req, res, { slug, relPath: rawPath })) {
      return undefined;
    }

    // A trailing slash on a single-file page (/memo/) addresses the page
    // itself, not a file inside it — send the visitor to its real URL rather
    // than a 404 for a directory that was never meant to exist.
    if (!rawPath || rawPath === '/') {
      res.statusCode = 308;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Location', `/${slug}`);
      return res.end();
    }

    return res.status(404).send('Not found');
  } catch (error) {
    console.error('[project] failed to serve', { slug, message: error.message });
    return res.status(500).send('Failed to load project file');
  }
};
