// Local CLI to debug the Google Drive folder integration.
//
//   GOOGLE_DRIVE_FOLDER_ID=... GOOGLE_API_KEY=... node scripts/diagnose-drive.js
//
// Prints a structured report that pinpoints the exact failure mode (config
// missing, key blocked by referrer/IP, Drive API disabled, folder not
// public/empty, no HTML files, or OK). The API key is never printed.
const { diagnose } = require('../lib/sync');

async function main() {
  const report = await diagnose();
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n=> ${report.summary}`);
  if (report.hint) {
    console.log(`=> Fix: ${report.hint}`);
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('Diagnose crashed:', error.message);
  process.exit(1);
});
