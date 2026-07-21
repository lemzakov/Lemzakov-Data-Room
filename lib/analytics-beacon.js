'use strict';

// A tiny, self-contained beacon injected into served single-file pages. It
// enriches the server-recorded "open" event with signals only the browser
// knows: active dwell time, scroll depth, language, timezone and screen size.
//
// Design notes:
//   - Uses navigator.sendBeacon so the final report survives page unload.
//   - Counts only *active* time (pauses while the tab is hidden), so dwell
//     reflects real reading, not a tab left open in the background.
//   - Reports once shortly after load (captures lang/screen even for a quick
//     bounce) and again whenever the page is hidden/unloaded.
//   - Hidden from print/PDF output; leaves no visible UI.
//   - The eventId ties every report back to the exact open the server logged.

const MARKER = 'ldr-stat-beacon';

// Builds the injected <script>. slug + eventId are embedded as JSON so quoting
// is always safe.
function beaconSnippet(slug, eventId) {
  const cfg = JSON.stringify({ slug: String(slug || ''), eventId: String(eventId || '') });
  return `
<script id="${MARKER}">
(function () {
  try {
    var CFG = ${cfg};
    if (!CFG.slug || !CFG.eventId) return;
    var start = Date.now();
    var active = 0;          // accumulated active (visible) ms
    var lastTick = Date.now();
    var maxScroll = 0;
    var sent = false;

    function visible() { return document.visibilityState !== 'hidden'; }
    function accrue() {
      var now = Date.now();
      if (visible()) active += now - lastTick;
      lastTick = now;
    }
    function scrollPct() {
      var doc = document.documentElement;
      var body = document.body || {};
      var scrollTop = window.pageYOffset || doc.scrollTop || 0;
      var viewport = window.innerHeight || doc.clientHeight || 0;
      var full = Math.max(doc.scrollHeight, body.scrollHeight || 0, doc.offsetHeight, body.offsetHeight || 0);
      if (full <= viewport) return 100;
      var pct = Math.round(((scrollTop + viewport) / full) * 100);
      return pct > 100 ? 100 : (pct < 0 ? 0 : pct);
    }
    function payload() {
      accrue();
      var p = maxScroll > scrollPct() ? maxScroll : scrollPct();
      maxScroll = p;
      var tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      return {
        slug: CFG.slug,
        eventId: CFG.eventId,
        dwellMs: active,
        scrollPct: p,
        lang: navigator.language || '',
        tz: tz,
        screenW: (window.screen && screen.width) || 0,
        screenH: (window.screen && screen.height) || 0
      };
    }
    function send(final) {
      try {
        var body = JSON.stringify(payload());
        var url = '/api/stat/ping';
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        } else {
          fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
        }
        if (final) sent = true;
      } catch (e) {}
    }

    window.addEventListener('scroll', function () {
      var p = scrollPct();
      if (p > maxScroll) maxScroll = p;
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
      accrue();
      if (!visible()) send(false);
    });
    window.addEventListener('pagehide', function () { if (!sent) send(true); });
    window.addEventListener('beforeunload', function () { if (!sent) send(true); });

    // Early report so a quick bounce still captures lang/screen/scroll.
    setTimeout(function () { send(false); }, 4000);
  } catch (e) {}
})();
</script>
`;
}

// Inserts the beacon just before </body> (falls back to appending). No-ops when
// slug/eventId are missing or when it has already been injected.
function injectAnalyticsBeacon(html, { slug, eventId } = {}) {
  if (typeof html !== 'string' || !html) return html;
  if (!slug || !eventId) return html;
  if (html.includes(`id="${MARKER}"`)) return html;
  const snippet = beaconSnippet(slug, eventId);
  const closingBody = /<\/body\s*>/i;
  if (closingBody.test(html)) {
    return html.replace(closingBody, (match) => snippet + match);
  }
  return html + snippet;
}

module.exports = { injectAnalyticsBeacon, beaconSnippet, MARKER };
