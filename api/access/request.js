// POST /api/access/request  { slug }
//
// A signed-in (Google) visitor requests access to a restricted page. We use the
// session's verified email/name (never client-supplied identity), create a
// pending request, and notify the owner via Telegram with Approve/Deny buttons.

const { normalizeSlug, getAcl, isAllowed } = require('../../lib/access');
const { getSessionFromRequest } = require('../../lib/session');
const { readJsonBody, sendJson } = require('../../lib/http');
const { createRequest } = require('../../lib/requests');
const telegram = require('../../lib/telegram');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const current = await getSessionFromRequest(req);
  if (!current) {
    return sendJson(res, 401, { ok: false, error: 'Sign in with Google first' });
  }

  const body = await readJsonBody(req);
  const slug = normalizeSlug(body.slug);
  if (!slug) {
    return sendJson(res, 400, { ok: false, error: 'A page slug is required' });
  }

  const { email, name } = current.session;

  try {
    const acl = await getAcl(slug);
    if (!acl || !acl.protected) {
      return sendJson(res, 400, { ok: false, error: 'This page is public' });
    }
    if (isAllowed(email, acl)) {
      return sendJson(res, 200, { ok: true, alreadyApproved: true });
    }

    if (!telegram.isConfigured()) {
      console.error('[access/request] Telegram not configured; request not delivered', { slug, email });
      return sendJson(res, 503, {
        ok: false,
        error: 'Access requests are not available right now. Please contact the owner directly.'
      });
    }

    const record = await createRequest({ email, name, slug });
    await telegram.sendAccessRequest({ requestId: record.id, email, name, slug });

    return sendJson(res, 200, { ok: true, requested: true });
  } catch (error) {
    console.error('[access/request] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: 'Could not submit request' });
  }
};
