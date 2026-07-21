const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dayKey,
  parseUserAgent,
  deviceLabel,
  geoFromRequest,
  referrerHost,
  clampInt,
  buildOpenEvent,
  ensureVisitor,
  analyticsEnabled,
  VISITOR_COOKIE
} = require('../lib/analytics');
const { injectAnalyticsBeacon, MARKER } = require('../lib/analytics-beacon');

test('dayKey returns UTC YYYY-MM-DD', () => {
  assert.equal(dayKey('2026-07-21T15:04:05.000Z'), '2026-07-21');
  assert.equal(dayKey(new Date('2026-01-02T00:00:00Z')), '2026-01-02');
});

test('parseUserAgent classifies common browsers/OS/devices', () => {
  const chromeMac = parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');
  assert.equal(chromeMac.browser, 'Chrome');
  assert.equal(chromeMac.os, 'macOS');
  assert.equal(chromeMac.device, 'Desktop');

  const iphoneSafari = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  assert.equal(iphoneSafari.os, 'iOS');
  assert.equal(iphoneSafari.device, 'Mobile');

  const edgeWin = parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0');
  assert.equal(edgeWin.browser, 'Edge');
  assert.equal(edgeWin.os, 'Windows');

  const bot = parseUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  assert.equal(bot.device, 'Bot');
});

test('deviceLabel joins browser and OS', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36'), 'Chrome · Windows');
});

test('geoFromRequest reads Vercel edge headers and decodes city', () => {
  const geo = geoFromRequest({
    headers: {
      'x-vercel-ip-country': 'AE',
      'x-vercel-ip-country-region': 'DU',
      'x-vercel-ip-city': 'Abu%20Dhabi',
      'x-vercel-ip-timezone': 'Asia/Dubai'
    }
  });
  assert.deepEqual(geo, { country: 'AE', region: 'DU', city: 'Abu Dhabi', timezone: 'Asia/Dubai' });
});

test('geoFromRequest is empty when headers absent', () => {
  assert.deepEqual(geoFromRequest({ headers: {} }), { country: '', region: '', city: '', timezone: '' });
});

test('referrerHost strips www, collapses same-host and invalid to direct', () => {
  assert.equal(referrerHost('', 'data.lemzakov.com'), 'direct');
  assert.equal(referrerHost('https://www.google.com/search?q=x'), 'google.com');
  assert.equal(referrerHost('https://data.lemzakov.com/deck', 'data.lemzakov.com'), 'direct');
  assert.equal(referrerHost('not a url'), 'direct');
  assert.equal(referrerHost('https://t.co/abc', 'data.lemzakov.com'), 't.co');
});

test('clampInt bounds and floors values', () => {
  assert.equal(clampInt('42.9', 0, 100), 42);
  assert.equal(clampInt(-5, 0, 100), 0);
  assert.equal(clampInt(500, 0, 100), 100);
  assert.equal(clampInt('nope', 7, 100), 7);
});

test('buildOpenEvent captures identity, geo, device and referrer', () => {
  const req = {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36',
      referer: 'https://www.linkedin.com/feed/',
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-city': 'New%20York',
      'x-forwarded-for': '203.0.113.5, 10.0.0.1',
      host: 'data.lemzakov.com'
    }
  };
  const ev = buildOpenEvent(req, {
    slug: 'investor-deck',
    session: { email: 'ALICE@x.com', name: 'Alice' },
    visitorId: 'vid123',
    newVisitor: true,
    protectedPage: true,
    now: '2026-07-21T10:00:00Z'
  });
  assert.equal(ev.slug, 'investor-deck');
  assert.equal(ev.email, 'ALICE@x.com');
  assert.equal(ev.name, 'Alice');
  assert.equal(ev.visitorId, 'vid123');
  assert.equal(ev.newVisitor, true);
  assert.equal(ev.protected, true);
  assert.equal(ev.country, 'US');
  assert.equal(ev.city, 'New York');
  assert.equal(ev.ip, '203.0.113.5');
  assert.equal(ev.device, 'Chrome · Windows');
  assert.equal(ev.referrerHost, 'linkedin.com');
  assert.match(ev.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(ev.at, '2026-07-21T10:00:00.000Z');
});

test('ensureVisitor reuses a valid cookie and does not set a new one', () => {
  const setCookies = [];
  const res = { getHeader: () => undefined, setHeader: (_n, v) => setCookies.push(v) };
  const req = { headers: { cookie: `${VISITOR_COOKIE}=abcdef1234567890` } };
  const out = ensureVisitor(req, res);
  assert.equal(out.visitorId, 'abcdef1234567890');
  assert.equal(out.newVisitor, false);
  assert.equal(setCookies.length, 0);
});

test('ensureVisitor mints and Set-Cookies a new visitor id', () => {
  const setCookies = [];
  const res = { getHeader: () => undefined, setHeader: (_n, v) => setCookies.push(v) };
  const req = { headers: { cookie: '', host: 'data.lemzakov.com' } };
  const out = ensureVisitor(req, res);
  assert.equal(out.newVisitor, true);
  assert.match(out.visitorId, /^[A-Za-z0-9_-]{10,}$/);
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], new RegExp(`${VISITOR_COOKIE}=`));
  assert.match(setCookies[0], /HttpOnly/);
  assert.match(setCookies[0], /Secure/);
});

test('ensureVisitor does not mark localhost cookie Secure', () => {
  const setCookies = [];
  const res = { getHeader: () => undefined, setHeader: (_n, v) => setCookies.push(v) };
  const req = { headers: { cookie: '', host: 'localhost:3000' } };
  ensureVisitor(req, res);
  assert.doesNotMatch(setCookies[0], /Secure/);
});

test('analyticsEnabled defaults on, off via ANALYTICS_DISABLED', () => {
  assert.equal(analyticsEnabled({}), true);
  assert.equal(analyticsEnabled({ ANALYTICS_DISABLED: '1' }), false);
  assert.equal(analyticsEnabled({ ANALYTICS_DISABLED: 'true' }), false);
  assert.equal(analyticsEnabled({ ANALYTICS_DISABLED: '0' }), true);
});

test('injectAnalyticsBeacon inserts before </body> with slug + eventId', () => {
  const out = injectAnalyticsBeacon('<html><body><h1>Deck</h1></body></html>', { slug: 'deck', eventId: 'ev123456' });
  assert.match(out, new RegExp(`id="${MARKER}"`));
  assert.match(out, /"slug":"deck"/);
  assert.match(out, /"eventId":"ev123456"/);
  assert.ok(out.indexOf(MARKER) < out.indexOf('</body>'));
});

test('injectAnalyticsBeacon no-ops without slug/eventId and never double-injects', () => {
  const html = '<body></body>';
  assert.equal(injectAnalyticsBeacon(html, {}), html);
  assert.equal(injectAnalyticsBeacon(html, { slug: 'x' }), html);
  const once = injectAnalyticsBeacon(html, { slug: 'x', eventId: 'evABCDEF' });
  const twice = injectAnalyticsBeacon(once, { slug: 'x', eventId: 'evABCDEF' });
  assert.equal(once, twice);
  assert.equal((twice.match(new RegExp(`id="${MARKER}"`, 'g')) || []).length, 1);
});

test('injectAnalyticsBeacon leaves empty/non-string untouched', () => {
  assert.equal(injectAnalyticsBeacon('', { slug: 'x', eventId: 'y' }), '');
  assert.equal(injectAnalyticsBeacon(null, { slug: 'x', eventId: 'y' }), null);
});
