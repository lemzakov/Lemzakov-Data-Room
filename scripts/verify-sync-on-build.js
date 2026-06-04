const { runSync } = require('../lib/sync');

async function main() {
  console.log('[deploy] Starting sync verification during build');
  const result = await runSync();
  console.log('[deploy] Sync verification succeeded', result);
}

main().catch((error) => {
  console.error('[deploy] Sync verification failed');
  process.exit(1);
});
