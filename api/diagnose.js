const { getRuntimeConfig } = require('../lib/config');
const { diagnose } = require('../lib/sync');

// Read-only diagnostics for the Google Drive folder integration.
//   GET /api/diagnose            (or ?secret=... / X-Sync-Secret header)
// Returns a structured report identifying the exact failure mode without ever
// exposing the API key. Protected by SYNC_SECRET when that variable is set.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cfg = getRuntimeConfig();
    const token = req.headers['x-sync-secret'] || req.query.secret || req.body?.secret;

    if (cfg.syncSecret && token !== cfg.syncSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const report = await diagnose();
    return res.status(200).json(report);
  } catch (error) {
    console.error('Diagnose failed');
    return res.status(500).json({ ok: false, error: error.message });
  }
};
