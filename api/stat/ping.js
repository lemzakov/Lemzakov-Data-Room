// Viewer-facing beacon receiver: POST /api/stat/ping
//
// The analytics beacon injected into served pages (lib/analytics-beacon.js)
// posts a small JSON body reporting engagement for one open:
//   { slug, eventId, dwellMs, scrollPct, lang, tz, screenW, screenH }
//
// This is NOT admin-protected — it is called by every page visitor. It records
// engagement (bounded/clamped in lib/analytics) and always answers 204, so a
// bad or malicious body can never do anything but no-op.

const { readJsonBody } = require('../../lib/http');
const { recordEngagement } = require('../../lib/analytics');

module.exports = async function handler(req, res) {
  // sendBeacon issues a POST; accept only that. Answer 204 regardless so the
  // beacon never surfaces console noise on the viewer's page.
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end();
  }

  try {
    const body = await readJsonBody(req);
    await recordEngagement(body || {});
  } catch (error) {
    console.error('[stat/ping] failed', { message: error.message });
  }

  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
};
