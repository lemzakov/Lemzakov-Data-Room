const { getRuntimeConfig } = require('../lib/config');
const { readHtml } = require('../lib/storage');
const { getAcl, isAllowed } = require('../lib/access');
const { getSessionFromRequest } = require('../lib/session');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const slug = (req.query.slug || '').toString().toLowerCase().trim();
  if (!slug) {
    return res.status(400).send('Missing HTML slug');
  }

  try {
    const { storagePrefix } = getRuntimeConfig();

    // Access control: a page with an `acl` record marked protected requires a
    // valid session whose email is on the allow list. Pages with no record stay
    // public (backward compatible).
    const acl = await getAcl(slug);
    if (acl && acl.protected) {
      const current = await getSessionFromRequest(req);
      const email = current && current.session && current.session.email;
      if (!isAllowed(email, acl)) {
        res.setHeader('Cache-Control', 'no-store');
        res.statusCode = 302;
        if (!email) {
          // Not signed in -> Google sign-in, returning here afterwards.
          res.setHeader('Location', `/api/auth/google/start?next=${encodeURIComponent('/' + slug)}`);
        } else {
          // Signed in but not approved -> request-access page.
          res.setHeader('Location', `/request-access?slug=${encodeURIComponent(slug)}`);
        }
        return res.end();
      }
    }

    const html = await readHtml(storagePrefix, slug);
    if (!html) {
      return res.status(404).send('HTML file not found');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (acl && acl.protected) {
      // Never let a shared cache store a protected page.
      res.setHeader('Cache-Control', 'private, no-store');
    }
    return res.status(200).send(html);
  } catch (error) {
    console.error('Failed to load HTML', {
      slug,
      message: error.message
    });
    return res.status(500).send('Failed to load HTML');
  }
};
