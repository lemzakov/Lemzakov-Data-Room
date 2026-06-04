const { getRuntimeConfig } = require('../lib/config');
const { runSync } = require('../lib/sync');

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

    const result = await runSync();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('Sync failed');
    return res.status(500).json({ ok: false, error: error.message });
  }
};
