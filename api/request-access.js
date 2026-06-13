// GET /request-access?slug=<slug>
//
// Shown when a signed-in visitor opens a restricted page they're not approved
// for. Displays who they're signed in as and a "Request access" button that
// POSTs to /api/access/request, which notifies the owner via Telegram.

const { normalizeSlug } = require('../lib/access');

module.exports = async function handler(req, res) {
  const slug = normalizeSlug(req.query.slug || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(renderPage(slug));
};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderPage(slug) {
  const safeSlug = escapeHtml(slug);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Request access — Lemzakov Data Room</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem; color: #1f2937; }
    h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
    p.sub { color: #6b7280; margin: 0 0 1.5rem; }
    .card { border: 1px solid #e5e7eb; border-radius: .75rem; padding: 1.25rem; }
    .who { font-size: .9rem; color: #374151; margin: 0 0 1rem; }
    .who b { color: #111827; }
    button { width: 100%; padding: .75rem; font-size: 1rem; font-weight: 600; color: #fff; background: #2563eb; border: 0; border-radius: .5rem; cursor: pointer; }
    button:disabled { opacity: .6; cursor: progress; }
    button.secondary { background: transparent; color: #2563eb; border: 1px solid #d1d5db; margin-top: .6rem; }
    .msg { margin-top: 1rem; padding: .7rem .8rem; border-radius: .5rem; font-size: .9rem; }
    .msg.err { background: #fef2f2; color: #991b1b; }
    .msg.ok { background: #ecfdf5; color: #065f46; }
    .hidden { display: none; }
    code { background: #f3f4f6; padding: .05rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>Request access</h1>
  <p class="sub">This page is restricted: <code>/${safeSlug}</code></p>

  <div class="card">
    <p class="who" id="who">Checking your sign-in…</p>
    <button id="requestBtn" disabled>Request access</button>
    <button id="switchBtn" class="secondary">Sign in with a different account</button>
    <div id="msg" class="msg hidden"></div>
  </div>

  <script type="module">
    const slug = ${JSON.stringify(slug)};
    const $ = (id) => document.getElementById(id);
    const msg = $('msg');
    function show(t, k) { msg.textContent = t; msg.className = 'msg ' + (k || ''); msg.classList.remove('hidden'); }

    async function init() {
      try {
        const me = await (await fetch('/api/auth/me')).json();
        if (!me.authenticated) {
          $('who').textContent = 'You are not signed in.';
          location.href = '/api/auth/google/start?next=' + encodeURIComponent('/request-access?slug=' + slug);
          return;
        }
        $('who').innerHTML = 'Signed in as <b>' + me.email + '</b>.';
        $('requestBtn').disabled = false;
      } catch {
        $('who').textContent = 'Could not check sign-in status.';
      }
    }

    $('requestBtn').addEventListener('click', async () => {
      $('requestBtn').disabled = true;
      try {
        const r = await fetch('/api/access/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.alreadyApproved) {
          show('You already have access. Redirecting…', 'ok');
          setTimeout(() => location.href = '/' + slug, 700);
        } else if (r.ok && data.requested) {
          show('Request sent. You will get access once the owner approves — just revisit the page.', 'ok');
        } else {
          show(data.error || 'Could not send request.', 'err');
          $('requestBtn').disabled = false;
        }
      } catch {
        show('Something went wrong. Please try again.', 'err');
        $('requestBtn').disabled = false;
      }
    });

    $('switchBtn').addEventListener('click', () => {
      location.href = '/api/auth/google/start?next=' + encodeURIComponent('/request-access?slug=' + slug);
    });

    init();
  </script>
</body>
</html>`;
}
