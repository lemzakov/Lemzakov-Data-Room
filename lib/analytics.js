// Per-page open analytics.
//
// Every time a page is served we record a rich "open" event and roll it into a
// handful of aggregate counters, so /admin can answer "who opened this page,
// when, from where, and how long did they stay?". The goal is to personalise
// each open as much as the request allows:
//
//   - WHO   — a Google-verified email + name for restricted pages, and a
//             persistent `ldr_vid` visitor cookie that recognises repeat opens
//             (including anonymous ones on public pages).
//   - WHERE — Vercel's edge geo headers (country / region / city / timezone)
//             plus the client IP.
//   - WHAT  — device / browser / OS parsed from the User-Agent, and the
//             referrer that led them here.
//   - HOW LONG — active dwell time + scroll depth reported by a tiny injected
//             beacon (see lib/analytics-beacon.js + api/stat/ping.js).
//
// Storage (Redis), all O(1) writes:
//   stat:index                       SET  — every slug that has stats
//   stat:agg:<slug>                  HASH — views, firstSeen, lastSeen, dwell…
//   stat:vis:<slug>                  SET  — visitor ids (SCARD = uniques)
//   stat:by:day:<slug>               HASH — YYYY-MM-DD -> count
//   stat:by:country:<slug>           HASH — country    -> count
//   stat:by:ref:<slug>               HASH — referrer   -> count
//   stat:by:email:<slug>             HASH — email      -> count
//   stat:by:device:<slug>            HASH — "Browser · OS" -> count
//   stat:events:<slug>               LIST — recent event ids (capped)
//   stat:ev:<slug>:<eventId>         HASH — one open's full detail (TTL'd)
//
// Recording NEVER throws and NEVER blocks page serving: every public entry
// point is wrapped so a Redis hiccup degrades to "no stats", not a 500.

const crypto = require('crypto');
const storage = require('./storage');
const { appendSetCookie, parseCookies, requestHost, clientIp } = require('./http');

const VISITOR_COOKIE = 'ldr_vid';
// Browsers cap persistent cookies at ~400 days; use that so returning visitors
// stay recognisable for as long as the platform allows.
const VISITOR_TTL_SECONDS = 400 * 24 * 60 * 60;
// How long a single open's full detail lives before it ages out of Redis.
const EVENT_TTL_SECONDS = 180 * 24 * 60 * 60; // ~6 months
// Cap on the per-page recent-opens index (older ids are trimmed away).
const MAX_EVENTS = 1000;

function analyticsEnabled(env = process.env) {
  // On by default; set ANALYTICS_DISABLED=1 to turn all recording off.
  const off = String(env.ANALYTICS_DISABLED || '').trim().toLowerCase();
  return !(off === '1' || off === 'true' || off === 'yes');
}

function newEventId() {
  return crypto.randomBytes(9).toString('base64url');
}

// ---- Pure helpers (unit-tested; no I/O) ------------------------------------

// "YYYY-MM-DD" in UTC for day bucketing.
function dayKey(input) {
  const d = input instanceof Date ? input : new Date(input || Date.now());
  return d.toISOString().slice(0, 10);
}

// Very small, dependency-free User-Agent classifier. Not exhaustive — enough to
// group opens by browser family, OS, and device type for the dashboard.
function parseUserAgent(uaRaw) {
  const ua = String(uaRaw || '');
  const has = (re) => re.test(ua);

  let browser = 'Unknown';
  if (has(/\bEdg(e|A|iOS)?\//)) browser = 'Edge';
  else if (has(/OPR\/|\bOpera\b/)) browser = 'Opera';
  else if (has(/\bYaBrowser\//)) browser = 'Yandex';
  else if (has(/\bChrome\/|\bCriOS\//) && !has(/\bChromium\b/)) browser = 'Chrome';
  else if (has(/\bChromium\//)) browser = 'Chromium';
  else if (has(/\bFirefox\/|\bFxiOS\//)) browser = 'Firefox';
  else if (has(/\bSafari\//) && has(/Version\//)) browser = 'Safari';
  else if (has(/\bMSIE |Trident\//)) browser = 'Internet Explorer';

  let os = 'Unknown';
  if (has(/\bWindows NT\b/)) os = 'Windows';
  else if (has(/\biPhone\b|\biPad\b|\biPod\b/)) os = 'iOS';
  else if (has(/\bMac OS X\b|\bMacintosh\b/)) os = 'macOS';
  else if (has(/\bAndroid\b/)) os = 'Android';
  else if (has(/\bCrOS\b/)) os = 'ChromeOS';
  else if (has(/\bLinux\b/)) os = 'Linux';

  let device = 'Desktop';
  if (has(/\biPad\b|\bTablet\b/)) device = 'Tablet';
  else if (has(/\bMobi\b|\bMobile\b|\biPhone\b|\bAndroid\b/)) device = 'Mobile';
  if (has(/\bbot\b|crawler|spider|slurp|facebookexternalhit|preview|monitor/i)) device = 'Bot';

  return { browser, os, device };
}

// A compact "Chrome · macOS" style label for the device breakdown.
function deviceLabel(ua) {
  const { browser, os } = parseUserAgent(ua);
  return `${browser} · ${os}`;
}

// Vercel's edge injects geo headers. City may be percent-encoded.
function geoFromRequest(req) {
  const h = (req && req.headers) || {};
  const get = (name) => {
    const v = h[name];
    return (Array.isArray(v) ? v[0] : v) || '';
  };
  const decode = (v) => {
    try { return decodeURIComponent(v); } catch { return v; }
  };
  return {
    country: get('x-vercel-ip-country') || '',
    region: get('x-vercel-ip-country-region') || '',
    city: decode(get('x-vercel-ip-city')) || '',
    timezone: get('x-vercel-ip-timezone') || ''
  };
}

// Reduces a full referrer URL to a hostname; "direct" when absent, and
// "<same host>" collapses to "direct" so we only surface external sources.
function referrerHost(referrer, selfHost) {
  const raw = String(referrer || '').trim();
  if (!raw) return 'direct';
  let host = '';
  try {
    host = new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return 'direct';
  }
  if (!host) return 'direct';
  const self = String(selfHost || '').replace(/^www\./, '').split(':')[0];
  if (self && host === self) return 'direct';
  return host;
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// Assembles the normalized event record from a request + optional session.
function buildOpenEvent(req, { slug, session, visitorId, newVisitor, type = 'single', protectedPage = false, now } = {}) {
  const at = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  const ua = (req && req.headers && (req.headers['user-agent'] || '')) || '';
  const referrer = (req && req.headers && (req.headers['referer'] || req.headers['referrer'] || '')) || '';
  const geo = geoFromRequest(req);
  const email = (session && session.email) || '';
  const name = (session && session.name) || '';
  return {
    id: newEventId(),
    at,
    slug: String(slug || ''),
    type,
    protected: Boolean(protectedPage),
    visitorId: String(visitorId || ''),
    newVisitor: Boolean(newVisitor),
    email,
    name,
    ip: clientIp(req),
    country: geo.country,
    region: geo.region,
    city: geo.city,
    timezone: geo.timezone,
    ua: String(ua).slice(0, 400),
    device: deviceLabel(ua),
    referrer: String(referrer).slice(0, 300),
    referrerHost: referrerHost(referrer, requestHostSafe(req))
  };
}

function requestHostSafe(req) {
  try { return requestHost(req); } catch { return ''; }
}

// Reads (or mints + Set-Cookies) the persistent visitor id. Returns
// { visitorId, newVisitor }. Safe to call even when res is unavailable.
function ensureVisitor(req, res) {
  const existing = parseCookies(req)[VISITOR_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{10,64}$/.test(existing)) {
    return { visitorId: existing, newVisitor: false };
  }
  const visitorId = crypto.randomBytes(16).toString('base64url');
  if (res && typeof res.getHeader === 'function') {
    const secure = !requestHostSafe(req).startsWith('localhost');
    const parts = [
      `${VISITOR_COOKIE}=${visitorId}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${VISITOR_TTL_SECONDS}`
    ];
    if (secure) parts.push('Secure');
    try { appendSetCookie(res, parts.join('; ')); } catch {}
  }
  return { visitorId, newVisitor: true };
}

// ---- Redis keys ------------------------------------------------------------

const K = {
  index: () => 'stat:index',
  agg: (s) => `stat:agg:${s}`,
  visitors: (s) => `stat:vis:${s}`,
  byDay: (s) => `stat:by:day:${s}`,
  byCountry: (s) => `stat:by:country:${s}`,
  byRef: (s) => `stat:by:ref:${s}`,
  byEmail: (s) => `stat:by:email:${s}`,
  byDevice: (s) => `stat:by:device:${s}`,
  events: (s) => `stat:events:${s}`,
  event: (s, id) => `stat:ev:${s}:${id}`
};

// ---- Recording -------------------------------------------------------------

// Records one page open. Wrapped so it can never throw into the serve path.
// Returns the event id (for the beacon to reference), or null when disabled /
// on any failure.
async function recordOpen(req, res, opts = {}) {
  if (!analyticsEnabled()) return null;
  const slug = String(opts.slug || '').trim().toLowerCase();
  if (!slug) return null;
  try {
    const { visitorId, newVisitor } = ensureVisitor(req, res);
    const event = buildOpenEvent(req, { ...opts, slug, visitorId, newVisitor });
    const day = dayKey(event.at);

    await Promise.all([
      storage.setAdd(K.index(), slug),
      storage.hashIncr(K.agg(slug), 'views', 1),
      storage.hashSetNx(K.agg(slug), 'firstSeen', event.at),
      storage.hashSet(K.agg(slug), { lastSeen: event.at }),
      storage.setAdd(K.visitors(slug), visitorId),
      storage.hashIncr(K.byDay(slug), day, 1),
      event.country ? storage.hashIncr(K.byCountry(slug), event.country, 1) : null,
      storage.hashIncr(K.byRef(slug), event.referrerHost || 'direct', 1),
      event.email ? storage.hashIncr(K.byEmail(slug), event.email, 1) : null,
      storage.hashIncr(K.byDevice(slug), event.device, 1),
      writeEvent(slug, event)
    ].filter(Boolean));

    return event.id;
  } catch (error) {
    console.error('[analytics] recordOpen failed', { slug, message: error.message });
    return null;
  }
}

async function writeEvent(slug, event) {
  const key = K.event(slug, event.id);
  const flat = {};
  for (const [k, v] of Object.entries(event)) {
    flat[k] = typeof v === 'boolean' ? (v ? '1' : '') : String(v == null ? '' : v);
  }
  await storage.hashSet(key, flat);
  await storage.expireKey(key, EVENT_TTL_SECONDS);
  await storage.listPush(K.events(slug), event.id);
  await storage.listTrim(K.events(slug), MAX_EVENTS);
}

// Records client-reported engagement for a single open (dwell time, scroll
// depth, language, screen). Called by the /api/stat/ping beacon endpoint.
async function recordEngagement(input = {}) {
  if (!analyticsEnabled()) return false;
  const slug = String(input.slug || '').trim().toLowerCase();
  const eventId = String(input.eventId || '').trim();
  if (!slug || !/^[A-Za-z0-9_-]{6,64}$/.test(eventId)) return false;
  try {
    const dwellMs = clampInt(input.dwellMs, 0, 6 * 60 * 60 * 1000); // cap 6h
    const scrollPct = clampInt(input.scrollPct, 0, 100);
    const patch = {};
    if (dwellMs > 0) patch.dwellMs = String(dwellMs);
    if (scrollPct > 0) patch.scrollPct = String(scrollPct);
    if (input.lang) patch.lang = String(input.lang).slice(0, 20);
    if (input.tz) patch.clientTz = String(input.tz).slice(0, 40);
    const sw = clampInt(input.screenW, 0, 20000);
    const sh = clampInt(input.screenH, 0, 20000);
    if (sw && sh) patch.screen = `${sw}x${sh}`;

    // Patch the per-open record only if it still exists (TTL not expired).
    const existing = await storage.hashGetAll(K.event(slug, eventId));
    if (existing && Object.keys(existing).length) {
      // Keep the largest dwell / deepest scroll across repeated beacons.
      if (patch.dwellMs && Number(existing.dwellMs || 0) >= Number(patch.dwellMs)) delete patch.dwellMs;
      if (patch.scrollPct && Number(existing.scrollPct || 0) >= Number(patch.scrollPct)) delete patch.scrollPct;
      if (Object.keys(patch).length) await storage.hashSet(K.event(slug, eventId), patch);
    }

    // Aggregate dwell (for an average-time-on-page number) — count each open
    // once, the first time it reports a positive dwell.
    if (dwellMs > 0 && !(existing && existing.dwellCounted)) {
      await storage.hashIncr(K.agg(slug), 'dwellMsTotal', dwellMs);
      await storage.hashIncr(K.agg(slug), 'dwellSamples', 1);
      await storage.hashSet(K.event(slug, eventId), { dwellCounted: '1' });
    } else if (dwellMs > 0 && existing && existing.dwellCounted) {
      // Later, longer beacon for the same open: adjust the running total.
      const prev = Number(existing.dwellMs || 0);
      if (dwellMs > prev) await storage.hashIncr(K.agg(slug), 'dwellMsTotal', dwellMs - prev);
    }
    return true;
  } catch (error) {
    console.error('[analytics] recordEngagement failed', { message: error.message });
    return false;
  }
}

// ---- Reading (admin dashboard) ---------------------------------------------

function hashToSortedPairs(hash, limit = 0) {
  const pairs = Object.entries(hash || {})
    .map(([key, count]) => ({ key, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count);
  return limit > 0 ? pairs.slice(0, limit) : pairs;
}

// Full stats for one page: headline numbers + dimensional breakdowns.
async function readPageStats(slug) {
  const s = String(slug || '').trim().toLowerCase();
  const [agg, uniques, byDay, byCountry, byRef, byEmail, byDevice] = await Promise.all([
    storage.hashGetAll(K.agg(s)),
    storage.setCard(K.visitors(s)),
    storage.hashGetAll(K.byDay(s)),
    storage.hashGetAll(K.byCountry(s)),
    storage.hashGetAll(K.byRef(s)),
    storage.hashGetAll(K.byEmail(s)),
    storage.hashGetAll(K.byDevice(s))
  ]);
  const dwellSamples = Number((agg && agg.dwellSamples) || 0);
  const dwellMsTotal = Number((agg && agg.dwellMsTotal) || 0);
  return {
    slug: s,
    views: Number((agg && agg.views) || 0),
    uniques: Number(uniques || 0),
    firstSeen: (agg && agg.firstSeen) || '',
    lastSeen: (agg && agg.lastSeen) || '',
    avgDwellMs: dwellSamples > 0 ? Math.round(dwellMsTotal / dwellSamples) : 0,
    dwellSamples,
    byDay: hashToSortedPairs(byDay).sort((a, b) => a.key.localeCompare(b.key)),
    byCountry: hashToSortedPairs(byCountry, 20),
    byReferrer: hashToSortedPairs(byRef, 20),
    byEmail: hashToSortedPairs(byEmail, 50),
    byDevice: hashToSortedPairs(byDevice, 20)
  };
}

// The most recent opens for a page, newest first, as full detail records.
async function readRecentOpens(slug, limit = 100) {
  const s = String(slug || '').trim().toLowerCase();
  const cap = clampInt(limit, 1, 500);
  const ids = await storage.listRange(K.events(s), 0, cap - 1);
  const events = await Promise.all(ids.map((id) => storage.hashGetAll(K.event(s, id))));
  return events
    .filter((e) => e && Object.keys(e).length)
    .map((e) => ({
      id: e.id || '',
      at: e.at || '',
      email: e.email || '',
      name: e.name || '',
      visitorId: e.visitorId || '',
      newVisitor: e.newVisitor === '1',
      country: e.country || '',
      region: e.region || '',
      city: e.city || '',
      ip: e.ip || '',
      device: e.device || '',
      referrerHost: e.referrerHost || '',
      referrer: e.referrer || '',
      lang: e.lang || '',
      screen: e.screen || '',
      dwellMs: Number(e.dwellMs || 0),
      scrollPct: Number(e.scrollPct || 0)
    }));
}

// A lightweight per-slug summary for the /admin overview: one HGETALL + SCARD
// per slug, run in parallel.
async function listStatsOverview() {
  const slugs = await storage.setMembers(K.index());
  const rows = await Promise.all(
    (slugs || []).map(async (slug) => {
      const [agg, uniques] = await Promise.all([
        storage.hashGetAll(K.agg(slug)),
        storage.setCard(K.visitors(slug))
      ]);
      return {
        slug,
        views: Number((agg && agg.views) || 0),
        uniques: Number(uniques || 0),
        lastSeen: (agg && agg.lastSeen) || ''
      };
    })
  );
  return rows.sort((a, b) => b.views - a.views);
}

module.exports = {
  VISITOR_COOKIE,
  analyticsEnabled,
  // pure helpers
  dayKey,
  parseUserAgent,
  deviceLabel,
  geoFromRequest,
  referrerHost,
  clampInt,
  buildOpenEvent,
  ensureVisitor,
  // recording
  recordOpen,
  recordEngagement,
  // reading
  readPageStats,
  readRecentOpens,
  listStatsOverview
};
