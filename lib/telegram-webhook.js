// Telegram webhook registration — shared by the CLI script
// (scripts/register-telegram-webhook.js) and the deploy build hook
// (scripts/verify-sync-on-build.js).
//
// Registering from code that runs with the deployed environment guarantees the
// `secret_token` sent to Telegram always equals the app's TELEGRAM_WEBHOOK_SECRET,
// so the webhook can never drift into the 401 state.
//
// Zero dependencies — Node built-ins + global fetch (Node 18+).

const { getPageDomains } = require('./config');

const API_BASE = 'https://api.telegram.org';
const WEBHOOK_PATH = '/api/telegram/webhook';
const ALLOWED_UPDATES = ['message', 'callback_query'];

function botToken(env = process.env) {
  return String(env.TELEGRAM_BOT_TOKEN || '').trim();
}

function webhookSecret(env = process.env) {
  return String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

// The URL Telegram should POST updates to. Explicit WEBHOOK_URL wins; otherwise
// it is built from the first configured page domain.
function resolveWebhookUrl(env = process.env) {
  const explicit = String(env.WEBHOOK_URL || '').trim();
  if (explicit) {
    const trimmed = explicit.replace(/\/+$/, '');
    return trimmed.endsWith(WEBHOOK_PATH) ? explicit : `${trimmed}${WEBHOOK_PATH}`;
  }
  const host = getPageDomains(env)[0];
  return `https://${host}${WEBHOOK_PATH}`;
}

async function callApi(token, method, payload, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
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

async function getWebhookInfo(env = process.env, deps = {}) {
  return callApi(botToken(env), 'getWebhookInfo', {}, deps);
}

async function deleteWebhook(env = process.env, deps = {}) {
  return callApi(botToken(env), 'deleteWebhook', { drop_pending_updates: false }, deps);
}

// Registers the webhook using the environment's token/secret/url. Returns a
// small summary. Throws only on a missing token or a Telegram API failure.
async function setWebhookFromEnv(env = process.env, deps = {}) {
  const token = botToken(env);
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const url = resolveWebhookUrl(env);
  const secret = webhookSecret(env);

  const payload = { url, allowed_updates: ALLOWED_UPDATES };
  if (secret) payload.secret_token = secret;

  await callApi(token, 'setWebhook', payload, deps);
  return { url, hasSecret: Boolean(secret), allowedUpdates: ALLOWED_UPDATES };
}

// Best-effort registration for the deploy build hook. Never throws: it decides
// whether to run, logs what it did, and returns a status. `logger` defaults to
// console so it shows up in the Vercel build log.
//
// Skips unless this is a Vercel *production* build (VERCEL_ENV === 'production')
// so preview/local builds never hijack the production webhook. Opt out entirely
// with TELEGRAM_WEBHOOK_AUTOREGISTER=0.
async function ensureWebhookOnDeploy(env = process.env, deps = {}) {
  const log = deps.logger || console;

  if (String(env.TELEGRAM_WEBHOOK_AUTOREGISTER || '').trim() === '0') {
    log.log('[deploy] Telegram webhook auto-register disabled (TELEGRAM_WEBHOOK_AUTOREGISTER=0)');
    return { skipped: 'disabled' };
  }
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') {
    log.log(`[deploy] Skipping Telegram webhook register on ${env.VERCEL_ENV} build`);
    return { skipped: `env:${env.VERCEL_ENV}` };
  }
  if (!env.VERCEL_ENV && !deps.force) {
    // Local `npm run build` — don't touch the live webhook unless forced.
    log.log('[deploy] Not a Vercel build; skipping Telegram webhook register');
    return { skipped: 'not-vercel' };
  }
  if (!botToken(env)) {
    log.log('[deploy] TELEGRAM_BOT_TOKEN not set; skipping Telegram webhook register');
    return { skipped: 'no-token' };
  }

  try {
    const result = await setWebhookFromEnv(env, deps);
    log.log(
      `[deploy] Telegram webhook registered -> ${result.url} ` +
        `(secret ${result.hasSecret ? 'set' : 'MISSING'}, allowed_updates [${result.allowedUpdates.join(', ')}])`
    );
    if (!result.hasSecret) {
      log.warn('[deploy] Warning: TELEGRAM_WEBHOOK_SECRET is empty — the webhook is unauthenticated.');
    }
    return { ok: true, ...result };
  } catch (error) {
    // A Telegram hiccup must never fail the deploy.
    log.error(`[deploy] Telegram webhook register failed (deploy continues): ${error.message}`);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  API_BASE,
  WEBHOOK_PATH,
  ALLOWED_UPDATES,
  botToken,
  webhookSecret,
  resolveWebhookUrl,
  callApi,
  getWebhookInfo,
  deleteWebhook,
  setWebhookFromEnv,
  ensureWebhookOnDeploy
};
