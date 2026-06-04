const { runSync, diagnose } = require('../lib/sync');

// Runs during `vercel build`. A Drive sync problem should NOT block the whole
// deployment (that also takes /api/diagnose and already-synced pages offline).
// Instead we log loudly + print a diagnosis, let the deploy proceed, and rely
// on the every-30-min cron (/api/sync) to retry once Drive is fixed.
async function main() {
  console.log('[deploy] Starting sync verification during build');

  try {
    const result = await runSync();
    console.log('[deploy] Sync verification succeeded', result);
    return;
  } catch (error) {
    console.error('[deploy] Sync verification failed (deploy will continue):', error.message);
  }

  // Explain *why* Drive returned nothing so the build log states the exact
  // cause (key blocked, Drive API disabled, folder not public/empty, etc.).
  try {
    const report = await diagnose();
    console.error('[deploy] Drive diagnosis:', JSON.stringify(report, null, 2));
    console.error(`[deploy] => ${report.summary}`);
    if (report.hint) {
      console.error(`[deploy] => Fix: ${report.hint}`);
    }
    console.error('[deploy] After fixing, trigger /api/sync (or wait for the cron) — no redeploy needed.');
  } catch (diagError) {
    console.error('[deploy] Diagnosis also failed:', diagError.message);
  }
}

main().catch((error) => {
  // Only truly unexpected crashes (not Drive sync issues) fail the build.
  console.error('[deploy] Unexpected build error:', error.message);
  process.exit(1);
});
