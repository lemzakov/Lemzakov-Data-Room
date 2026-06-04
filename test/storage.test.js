const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRedisUrl } = require('../lib/storage');

test('resolveRedisUrl uses REDIS_URL', () => {
  const url = resolveRedisUrl({
    REDIS_URL: 'redis://example.redis.io:6379'
  });

  assert.equal(url, 'redis://example.redis.io:6379');
});

test('resolveRedisUrl accepts rediss URL', () => {
  const url = resolveRedisUrl({
    REDIS_URL: 'rediss://example.redis.io:6379'
  });

  assert.equal(url, 'rediss://example.redis.io:6379');
});

test('resolveRedisUrl rejects non-redis URL', () => {
  assert.throws(
    () =>
      resolveRedisUrl({
        REDIS_URL: 'https://example.upstash.io'
      }),
    /expected redis:\/\/ or rediss:\/\//
  );
});

test('resolveRedisUrl requires a URL', () => {
  assert.throws(
    () => resolveRedisUrl({}),
    /Missing Redis config/
  );
});
