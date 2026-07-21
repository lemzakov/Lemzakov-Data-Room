const { getRuntimeConfig } = require('../lib/config');
const { readHtml } = require('../lib/storage');
const { getAcl, isAllowed } = require('../lib/access');
const { getSessionFromRequest } = require('../lib/session');
const { injectSavePdfButton } = require('../lib/save-pdf');
const { recordOpen } = require('../lib/analytics');
const { injectAnalyticsBeacon } = require('../lib/analytics-beacon');

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
    // public (backward compatible). We resolve the session up front so a
    // signed-in visitor can be personalised in analytics even on public pages.
    const acl = await getAcl(slug);
    const current = await getSessionFromRequest(req);
    const session = (current && current.session) || null;
    const email = session && session.email;
    if (acl && acl.protected) {
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

    // Record this open (who / where / device / referrer) and mint the visitor
    // cookie BEFORE sending the body so its Set-Cookie header sticks. Guarded:
    // analytics never blocks or fails page delivery.
    const eventId = await recordOpen(req, res, {
      slug,
      session,
      type: 'single',
      protectedPage: Boolean(acl && acl.protected)
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (acl && acl.protected) {
      // Never let a shared cache store a protected page.
      res.setHeader('Cache-Control', 'private, no-store');
    }
    const body = injectAnalyticsBeacon(injectSavePdfButton(html), { slug, eventId });
    return res.status(200).send(body);
  } catch (error) {
    console.error('Failed to load HTML', {
      slug,
      message: error.message
    });
    return res.status(500).send('Failed to load HTML');
  }
};
