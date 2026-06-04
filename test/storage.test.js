const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRedisConfig } = require('../lib/storage');

test('resolveRedisConfig uses KV REST variables', () => {
  const cfg = resolveRedisConfig({
    KV_REST_API_URL: 'https://example.upstash.io',
    KV_REST_API_TOKEN: 'token-1'
  });

  assert.equal(cfg.url, 'https://example.upstash.io');
  assert.equal(cfg.token, 'token-1');
});

test('resolveRedisConfig rejects non-https URL', () => {
  assert.throws(
    () =>
      resolveRedisConfig({
        lemzakov_REDIS_URL: 'redis://example.redis.io:6379',
        lemzakov_REDIS_TOKEN: 'secret'
      }),
    /expected an https URL/
  );
});

test('resolveRedisConfig requires both URL and token', () => {
  assert.throws(
    () => resolveRedisConfig({ KV_REST_API_URL: 'https://example.upstash.io' }),
    /Missing Redis REST config/
  );
});
