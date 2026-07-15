const test = require('node:test');
const assert = require('node:assert/strict');

const wh = require('../lib/telegram-webhook');

// Fake fetch capturing the Telegram API calls; always returns ok.
function fakeFetch(result = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { fetch, calls };
}

function quietLogger() {
  const lines = [];
  const rec = (level) => (...a) => lines.push({ level, msg: a.join(' ') });
  return { lines, log: rec('log'), warn: rec('warn'), error: rec('error') };
}

test('resolveWebhookUrl uses WEBHOOK_URL and appends the path when needed', () => {
  assert.equal(
    wh.resolveWebhookUrl({ WEBHOOK_URL: 'https://x.com' }),
    'https://x.com/api/telegram/webhook'
  );
  assert.equal(
    wh.resolveWebhookUrl({ WEBHOOK_URL: 'https://x.com/api/telegram/webhook' }),
    'https://x.com/api/telegram/webhook'
  );
});

test('resolveWebhookUrl falls back to the first PAGE_DOMAINS host', () => {
  assert.equal(
    wh.resolveWebhookUrl({ PAGE_DOMAINS: 'data.wize.ae, data.lemzakov.com' }),
    'https://data.wize.ae/api/telegram/webhook'
  );
  assert.equal(wh.resolveWebhookUrl({}), 'https://data.lemzakov.com/api/telegram/webhook');
});

test('setWebhookFromEnv posts url, secret and allowed_updates', async () => {
  const f = fakeFetch();
  const res = await wh.setWebhookFromEnv(
    { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_WEBHOOK_SECRET: 'S', PAGE_DOMAINS: 'a.com' },
    { fetch: f.fetch }
  );
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/botT\/setWebhook$/);
  assert.deepEqual(f.calls[0].body, {
    url: 'https://a.com/api/telegram/webhook',
    allowed_updates: ['message', 'callback_query'],
    secret_token: 'S'
  });
  assert.equal(res.hasSecret, true);
});

test('setWebhookFromEnv omits secret_token when no secret set', async () => {
  const f = fakeFetch();
  await wh.setWebhookFromEnv({ TELEGRAM_BOT_TOKEN: 'T', PAGE_DOMAINS: 'a.com' }, { fetch: f.fetch });
  assert.equal('secret_token' in f.calls[0].body, false);
});

test('setWebhookFromEnv throws without a token', async () => {
  await assert.rejects(() => wh.setWebhookFromEnv({}, {}), /Missing TELEGRAM_BOT_TOKEN/);
});

test('ensureWebhookOnDeploy skips non-production Vercel builds', async () => {
  const f = fakeFetch();
  const res = await wh.ensureWebhookOnDeploy(
    { VERCEL_ENV: 'preview', TELEGRAM_BOT_TOKEN: 'T' },
    { fetch: f.fetch, logger: quietLogger() }
  );
  assert.deepEqual(res, { skipped: 'env:preview' });
  assert.equal(f.calls.length, 0);
});

test('ensureWebhookOnDeploy skips local (non-Vercel) builds unless forced', async () => {
  const f = fakeFetch();
  const res = await wh.ensureWebhookOnDeploy(
    { TELEGRAM_BOT_TOKEN: 'T' },
    { fetch: f.fetch, logger: quietLogger() }
  );
  assert.equal(res.skipped, 'not-vercel');
  assert.equal(f.calls.length, 0);
});

test('ensureWebhookOnDeploy skips when the token is missing', async () => {
  const f = fakeFetch();
  const res = await wh.ensureWebhookOnDeploy(
    { VERCEL_ENV: 'production' },
    { fetch: f.fetch, logger: quietLogger() }
  );
  assert.equal(res.skipped, 'no-token');
  assert.equal(f.calls.length, 0);
});

test('ensureWebhookOnDeploy registers on a production build', async () => {
  const f = fakeFetch();
  const res = await wh.ensureWebhookOnDeploy(
    { VERCEL_ENV: 'production', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_WEBHOOK_SECRET: 'S', PAGE_DOMAINS: 'a.com' },
    { fetch: f.fetch, logger: quietLogger() }
  );
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://a.com/api/telegram/webhook');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /setWebhook$/);
});

test('ensureWebhookOnDeploy can be disabled with TELEGRAM_WEBHOOK_AUTOREGISTER=0', async () => {
  const f = fakeFetch();
  const res = await wh.ensureWebhookOnDeploy(
    { VERCEL_ENV: 'production', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_WEBHOOK_AUTOREGISTER: '0' },
    { fetch: f.fetch, logger: quietLogger() }
  );
  assert.deepEqual(res, { skipped: 'disabled' });
  assert.equal(f.calls.length, 0);
});

test('ensureWebhookOnDeploy never throws on a Telegram failure', async () => {
  const fetch = async () => ({ ok: false, json: async () => ({ ok: false, description: 'boom' }) });
  const res = await wh.ensureWebhookOnDeploy(
    { VERCEL_ENV: 'production', TELEGRAM_BOT_TOKEN: 'T', PAGE_DOMAINS: 'a.com' },
    { fetch, logger: quietLogger() }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /setWebhook failed/);
});
