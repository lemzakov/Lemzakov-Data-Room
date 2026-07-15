// Register (or inspect / delete) the Telegram webhook from the environment.
//
// The webhook endpoint rejects any update whose secret doesn't match the
// deployed TELEGRAM_WEBHOOK_SECRET. This script calls setWebhook using the SAME
// env var, so the two sides can never drift — you don't need to remember the
// secret, only to run this with the same environment the app has.
//
// Usage:
//   node scripts/register-telegram-webhook.js            # set the webhook
//   node scripts/register-telegram-webhook.js --info     # show getWebhookInfo
//   node scripts/register-telegram-webhook.js --delete   # remove the webhook
//   npm run register-telegram -- --info
//
// Environment:
//   TELEGRAM_BOT_TOKEN       (required) bot token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  (recommended) shared secret; sent to Telegram AND
//                            checked by /api/telegram/webhook — keep them equal
//   WEBHOOK_URL              (optional) full webhook URL to register. If unset,
//                            it is built as https://<first PAGE_DOMAINS host>/api/telegram/webhook
//   PAGE_DOMAINS             (optional) used to derive the host when WEBHOOK_URL
//                            is not given (defaults to data.lemzakov.com)
//
// The easiest way to guarantee the secret matches production is to pull the
// deployed env first, then run this — the script auto-loads .env.local / .env
// (no dotenv needed):
//   vercel env pull .env.local && node scripts/register-telegram-webhook.js
// (or just export the same TELEGRAM_* values you set in Vercel before running.)
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

const { getPageDomains } = require('../lib/config');

const API_BASE = 'https://api.telegram.org';
const WEBHOOK_PATH = '/api/telegram/webhook';
const ALLOWED_UPDATES = ['message', 'callback_query'];

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`Missing ${name}. Set it in the environment and re-run.`);
    process.exit(1);
  }
  return value;
}

// The URL Telegram should POST updates to. Explicit WEBHOOK_URL wins; otherwise
// build it from the first configured page domain.
function resolveWebhookUrl() {
  const explicit = String(process.env.WEBHOOK_URL || '').trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '').endsWith(WEBHOOK_PATH)
      ? explicit
      : `${explicit.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  }
  const host = getPageDomains()[0];
  return `https://${host}${WEBHOOK_PATH}`;
}

async function callApi(token, method, payload) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`${method} failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function showInfo(token) {
  const info = await callApi(token, 'getWebhookInfo');
  // Redact nothing sensitive here (getWebhookInfo returns no secret), but keep
  // the output focused on what tells you whether it's healthy.
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
  const token = required('TELEGRAM_BOT_TOKEN');
  const args = process.argv.slice(2);

  if (args.includes('--info')) {
    await showInfo(token);
    return;
  }

  if (args.includes('--delete')) {
    await callApi(token, 'deleteWebhook', { drop_pending_updates: false });
    console.log('=> Webhook deleted.');
    return;
  }

  const url = resolveWebhookUrl();
  const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

  const payload = { url, allowed_updates: ALLOWED_UPDATES };
  if (secret) {
    payload.secret_token = secret;
  } else {
    console.warn('Warning: TELEGRAM_WEBHOOK_SECRET is empty — registering without a secret is not recommended.');
  }

  await callApi(token, 'setWebhook', payload);
  console.log(`=> Webhook set to ${url}`);
  console.log(`=> allowed_updates: [${ALLOWED_UPDATES.join(', ')}]`);
  console.log(`=> secret_token: ${secret ? 'set (matches TELEGRAM_WEBHOOK_SECRET)' : 'NONE'}`);
  console.log('\nVerifying…\n');
  await showInfo(token);
}

main().catch((error) => {
  console.error('register-telegram-webhook failed:', error.message);
  process.exit(1);
});
