// Register (or inspect / delete) the Telegram webhook from the environment.
//
// You normally DON'T need this: the deploy build hook auto-registers the webhook
// on every production deploy (see lib/telegram-webhook.js → ensureWebhookOnDeploy,
// called from scripts/verify-sync-on-build.js). This CLI is for one-off local
// use or debugging.
//
// Usage:
//   node scripts/register-telegram-webhook.js            # set the webhook
//   node scripts/register-telegram-webhook.js --info     # show getWebhookInfo
//   node scripts/register-telegram-webhook.js --delete   # remove the webhook
//   npm run register-telegram -- --info
//
// Environment (auto-loaded from .env.local then .env if present):
//   TELEGRAM_BOT_TOKEN       (required) bot token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  (recommended) shared secret; sent to Telegram AND
//                            checked by /api/telegram/webhook — keep them equal
//   WEBHOOK_URL              (optional) full webhook URL; else built from the
//                            first PAGE_DOMAINS host
//   PAGE_DOMAINS             (optional) used to derive the host (default data.lemzakov.com)
//
// Guarantee the secret matches production by pulling the deployed env first:
//   vercel env pull .env.local && npm run register-telegram
//
// Zero dependencies — Node built-ins + global fetch (Node 18+). Secrets are
// never printed.

const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dotenv dependency). Loads .env.local then .env from
// the repo root, without overriding variables already present in the
// environment. Just enough to parse `KEY=value` / `KEY="value"` lines.
function loadEnvFiles() {
  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf-8');
    } catch {
      continue; // file absent — fine
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || process.env[key] !== undefined) continue; // real env wins
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvFiles();

const {
  getWebhookInfo,
  deleteWebhook,
  setWebhookFromEnv,
  ALLOWED_UPDATES
} = require('../lib/telegram-webhook');

function requireToken() {
  if (!String(process.env.TELEGRAM_BOT_TOKEN || '').trim()) {
    console.error('Missing TELEGRAM_BOT_TOKEN. Set it in the environment (or .env.local) and re-run.');
    process.exit(1);
  }
}

async function showInfo() {
  const info = await getWebhookInfo();
  console.log(JSON.stringify(info, null, 2));
  if (info.last_error_message) {
    console.log(`\n=> Last error: ${info.last_error_message}`);
  }
  if (info.pending_update_count) {
    console.log(`=> ${info.pending_update_count} update(s) queued; they retry once the endpoint returns 200.`);
  }
  return info;
}

async function main() {
  requireToken();
  const args = process.argv.slice(2);

  if (args.includes('--info')) {
    await showInfo();
    return;
  }

  if (args.includes('--delete')) {
    await deleteWebhook();
    console.log('=> Webhook deleted.');
    return;
  }

  const result = await setWebhookFromEnv();
  console.log(`=> Webhook set to ${result.url}`);
  console.log(`=> allowed_updates: [${ALLOWED_UPDATES.join(', ')}]`);
  console.log(`=> secret_token: ${result.hasSecret ? 'set (matches TELEGRAM_WEBHOOK_SECRET)' : 'NONE'}`);
  console.log('\nVerifying…\n');
  await showInfo();
}

main().catch((error) => {
  console.error('register-telegram-webhook failed:', error.message);
  process.exit(1);
});
