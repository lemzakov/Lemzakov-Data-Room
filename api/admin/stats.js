// Admin analytics endpoint. Auth: ADMIN_TOKEN (or SYNC_SECRET).
//
//   GET /api/admin/stats                 -> { ok, overview: [{ slug, views, uniques, lastSeen }] }
//   GET /api/admin/stats?slug=<slug>     -> { ok, slug, stats, recent }
//
// Backs the "Stats" view in the /admin dashboard: an overview across every page
// with recorded opens, and a per-page drill-down (breakdowns + recent opens).

const { isAdminAuthorized } = require('../../lib/admin');
const { sendJson } = require('../../lib/http');
const { normalizeSlug } = require('../../lib/access');
const { readPageStats, readRecentOpens, listStatsOverview } = require('../../lib/analytics');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }
  if (!isAdminAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const slug = normalizeSlug(req.query.slug || '');
    if (slug) {
      const [stats, recent] = await Promise.all([
        readPageStats(slug),
        readRecentOpens(slug, 150)
      ]);
      return sendJson(res, 200, { ok: true, slug, stats, recent });
    }
    const overview = await listStatsOverview();
    return sendJson(res, 200, { ok: true, overview });
  } catch (error) {
    console.error('[admin/stats] failed', { message: error.message });
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
