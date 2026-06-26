// Scheduled (and manual) incremental sync of ALL projects.
//
// Wired as a Vercel Cron in vercel.json. Protected by CRON_SECRET (falling back
// to SYNC_SECRET). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; we
// also accept ?secret= / x-sync-secret for manual triggering. Never fails the
// whole run for one bad project — see runAllProjectsSync.

const { runAllProjectsSync } = require('../lib/project-sync');

function expectedSecret() {
  return (process.env.CRON_SECRET || process.env.SYNC_SECRET || '').trim();
}

function presentedSecret(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  return (
    (bearer && bearer[1]) ||
    req.headers['x-sync-secret'] ||
    req.query?.secret ||
    req.body?.secret ||
    ''
  ).toString().trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const secret = expectedSecret();
  if (secret && presentedSecret(req) !== secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const force = req.query?.force === '1' || req.query?.force === 'true';

  try {
    const summary = await runAllProjectsSync({ force });
    const failed = summary.results.filter((r) => !r.ok).length;
    return res.status(200).json({ ok: failed === 0, ...summary });
  } catch (error) {
    console.error('[projects-sync] failed', { message: error.message });
    return res.status(500).json({ ok: false, error: error.message });
  }
};
