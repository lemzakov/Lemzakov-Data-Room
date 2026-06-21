// Serves project files at /<slug>/<path> (and the entry point at /<slug>/).
//
// Wired in vercel.json:  /([^/]+)/(.*) -> /api/project?slug=$1&path=$2
// Access is enforced here (Google sign-in + per-project membership). The
// single-file publishing flow is unaffected: it serves single-segment URLs via
// /api/serve, which only routes to a project when one exists for that slug.

const { getProject } = require('../lib/projects');
const { serveProject } = require('../lib/project-serve');

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
    const project = await getProject(slug);
    if (!project) {
      return res.status(404).send('Project not found');
    }
    return serveProject(req, res, { project, rawPath });
  } catch (error) {
    console.error('[project] failed to serve', { slug, message: error.message });
    return res.status(500).send('Failed to load project file');
  }
};
