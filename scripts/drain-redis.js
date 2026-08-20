#!/usr/bin/env node
//
// Maintenance CLI for the Redis OOM. Reads and deletes on the Redis side only,
// so it runs while the store is already at maxmemory.
//
//   node scripts/drain-redis.js --report
//   node scripts/drain-redis.js --events            # safe: derived data only
//   node scripts/drain-redis.js --projfiles         # needs the Blob deploy live
//   node scripts/drain-redis.js --html              # needs the Blob deploy live
//
// Every pass is a DRY RUN until --apply is passed. Requires REDIS_URL, and
// BLOB_READ_WRITE_TOKEN for the two content passes.

const { report, drainHtml, drainProjectFiles, purgeAnalyticsEvents } = require('../lib/redis-drain');
const { getRedisClientForMaintenance, closeRedis } = require('../lib/storage');
const blob = require('../lib/blob-storage');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const dryRun = !has('--apply');
const log = (msg) => console.log(msg);

async function main() {
  const wantReport = has('--report') || argv.length === 0;
  const wantEvents = has('--events') || has('--all');
  const wantProjfiles = has('--projfiles') || has('--all');
  const wantHtml = has('--html') || has('--all');

  if ((wantProjfiles || wantHtml) && !blob.blobEnabled()) {
    console.error('BLOB_READ_WRITE_TOKEN is required for --html / --projfiles.');
    process.exitCode = 1;
    return;
  }

  if (dryRun && (wantEvents || wantProjfiles || wantHtml)) {
    log('DRY RUN — nothing will be deleted. Re-run with --apply to act.\n');
  }

  const client = await getRedisClientForMaintenance();

  if (wantReport) {
    const r = await report(client, { log });
    const rows = Object.entries(r.classes).sort((a, b) => b[1].bytes - a[1].bytes);
    log('');
    log('class                keys        MB');
    log('-----------------------------------');
    for (const [cls, c] of rows) {
      log(cls.padEnd(20) + String(c.keys).padStart(5) + (c.bytes / 1048576).toFixed(1).padStart(10));
    }
    log('');
  }

  // Ordered cheapest-and-safest first, so an operator who stops early has
  // already reclaimed whatever the derived data was holding.
  if (wantEvents) await purgeAnalyticsEvents({ client, dryRun, log });
  if (wantProjfiles) await drainProjectFiles({ client, blob, dryRun, log });
  if (wantHtml) await drainHtml({ client, blob, dryRun, log });

  if (dryRun && (wantEvents || wantProjfiles || wantHtml)) {
    log('\nDry run complete — re-run with --apply to perform it.');
  }
}

main()
  .catch((error) => {
    console.error('drain-redis failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    process.exit(process.exitCode || 0);
  });
