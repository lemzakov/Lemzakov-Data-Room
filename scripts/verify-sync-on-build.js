const { runSync, diagnose } = require('../lib/sync');
const { closeRedis } = require('../lib/storage');
const { ensureWebhookOnDeploy } = require('../lib/telegram-webhook');

// Runs during `vercel build`. A Drive sync problem should NOT block the whole
// deployment (that also takes /api/diagnose and already-synced pages offline).
// Instead we log loudly + print a diagnosis, let the deploy proceed, and rely
// on the every-30-min cron (/api/sync) to retry once Drive is fixed.
//
// IMPORTANT: this script MUST exit explicitly. runSync opens a Redis
// connection, whose live socket keeps the Node event loop alive and makes the
// build hang forever after the work is done. We close Redis and force-exit.
async function run() {
  console.log('[deploy] Starting sync verification during build');

  // Make sure the Telegram webhook is registered against this deployment, using
  // the deployed env (so the secret always matches). Production builds only;
  // best-effort — never fails the deploy.
  try {
    await ensureWebhookOnDeploy();
  } catch (error) {
    console.error('[deploy] Telegram webhook step errored (deploy continues):', error.message);
  }

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

async function main() {
  let exitCode = 0;
  try {
    await run();
  } catch (error) {
    // Only truly unexpected crashes (not Drive sync issues) fail the build.
    console.error('[deploy] Unexpected build error:', error.message);
    exitCode = 1;
  } finally {
    await closeRedis();
  }
  // Force-exit so any lingering open handles can't hang the build.
  process.exit(exitCode);
}

main();
