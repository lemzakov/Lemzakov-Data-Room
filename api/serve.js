// Single-segment dispatcher for /<slug>.
//
// Wired in vercel.json:  /([^/]+) -> /api/serve?slug=$1
//
// If <slug> is a project, redirect to /<slug>/ so the browser uses the project
// prefix as the base for relative links, and the /api/project handler takes
// over. Otherwise this is an ordinary single-file page: delegate UNCHANGED to
// the existing /api/html handler, keeping the original publishing flow intact.

const { getProject } = require('../lib/projects');
const htmlHandler = require('./html');

module.exports = async function handler(req, res) {
  const slug = (req.query.slug || '').toString().toLowerCase().trim();

  // Projects only own GET/HEAD URLs; anything else falls through to the
  // single-file handler, which enforces its own method rules.
  if (slug && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const project = await getProject(slug);
      if (project) {
        res.statusCode = 308; // permanent; preserves method
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Location', `/${slug}/`);
        return res.end();
      }
    } catch (error) {
      // If the project lookup fails, fall back to the single-file handler
      // rather than 500 — keeps existing pages serving during Redis hiccups.
      console.error('[serve] project lookup failed; falling back to html', { slug, message: error.message });
    }
  }

  return htmlHandler(req, res);
};
