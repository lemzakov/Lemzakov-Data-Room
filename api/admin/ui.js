// GET /admin  ->  the admin dashboard (served via the /admin route).
//
// A single self-contained HTML page. It is NOT protected server-side (it holds
// no secrets); instead it presents a login form (username "admin" + the
// ADMIN_TOKEN as password) and keeps the token only in the browser's
// sessionStorage. Every data call carries the token in the X-Admin-Token header
// and is authorized server-side by lib/admin.js, so the page is useless without
// the real token. From here you can see every page and flip it between public
// and restricted (with an optional pre-approved email list).

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(200).send(PAGE);
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Admin — Lemzakov Data Room</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 56rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1f2937; }
    h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
    p.sub { color: #6b7280; margin: 0 0 1.5rem; }
    .card { border: 1px solid #e5e7eb; border-radius: .75rem; padding: 1.25rem; }
    label { display: block; font-size: .85rem; color: #374151; margin: 0 0 .9rem; }
    label span { display: block; margin-bottom: .3rem; font-weight: 600; }
    input[type=text], input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; border: 1px solid #d1d5db; border-radius: .5rem; background: transparent; color: inherit; }
    button { padding: .6rem 1rem; font-size: .95rem; font-weight: 600; color: #fff; background: #2563eb; border: 0; border-radius: .5rem; cursor: pointer; }
    button:disabled { opacity: .6; cursor: progress; }
    button.ghost { background: transparent; color: #2563eb; border: 1px solid #d1d5db; }
    button.danger { background: #dc2626; }
    .row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: .5rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: .65rem .5rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: .92rem; }
    th { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
    a.slug { color: #2563eb; text-decoration: none; font-weight: 600; }
    .pill { display: inline-block; padding: .12rem .55rem; border-radius: 999px; font-size: .72rem; font-weight: 700; }
    .pill.public { background: #ecfdf5; color: #065f46; }
    .pill.restricted { background: #fef3c7; color: #92400e; }
    .allow { color: #6b7280; font-size: .82rem; margin-top: .25rem; }
    .msg { margin-top: 1rem; padding: .7rem .8rem; border-radius: .5rem; font-size: .9rem; }
    .msg.err { background: #fef2f2; color: #991b1b; }
    .msg.ok { background: #ecfdf5; color: #065f46; }
    .hidden { display: none; }
    .muted { color: #9ca3af; }
    dialog { border: 1px solid #e5e7eb; border-radius: .75rem; padding: 1.25rem; max-width: 28rem; width: 92%; color: inherit; }
    dialog::backdrop { background: rgba(0,0,0,.4); }
    fieldset { border: 0; padding: 0; margin: 0 0 .75rem; }
  </style>
</head>
<body>
  <h1>Data Room admin</h1>
  <p class="sub">Sign in to view every page and set who can access it.</p>

  <!-- Login -->
  <section id="login" class="card" style="max-width: 24rem;">
    <form id="loginForm">
      <label><span>Username</span>
        <input type="text" id="username" autocomplete="username" value="admin" />
      </label>
      <label><span>Password</span>
        <input type="password" id="password" autocomplete="current-password" placeholder="ADMIN_TOKEN" required />
      </label>
      <button type="submit" id="loginBtn">Sign in</button>
      <div id="loginMsg" class="msg err hidden"></div>
    </form>
  </section>

  <!-- Dashboard -->
  <section id="dash" class="hidden">
    <div class="topbar">
      <div class="row">
        <button id="refreshBtn" class="ghost">Refresh</button>
        <span id="count" class="muted"></span>
      </div>
      <button id="logoutBtn" class="ghost">Sign out</button>
    </div>
    <div class="card">
      <table>
        <thead>
          <tr><th>Page</th><th>Access</th><th></th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="dashMsg" class="msg hidden"></div>
    </div>
  </section>

  <!-- Restrict dialog -->
  <dialog id="restrictDlg">
    <form method="dialog" id="restrictForm">
      <h3 style="margin:.1rem 0 1rem;">Restrict <code id="rSlug"></code></h3>
      <fieldset>
        <label><span>Pre-approved emails (one per line, optional)</span></label>
        <textarea id="rAllow" rows="5" style="width:100%;padding:.6rem .7rem;border:1px solid #d1d5db;border-radius:.5rem;background:transparent;color:inherit;font-family:inherit;"></textarea>
        <p class="allow">Anyone listed can view immediately. Others sign in with Google and tap “Request access”, which you approve from Telegram.</p>
      </fieldset>
      <div class="row" style="justify-content:flex-end;">
        <button type="button" class="ghost" id="rCancel">Cancel</button>
        <button type="button" id="rSave">Save</button>
      </div>
    </form>
  </dialog>

  <script type="module">
    const $ = (id) => document.getElementById(id);
    const TOKEN_KEY = 'ldr_admin_token';

    function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
    function authHeaders(extra) { return Object.assign({ 'X-Admin-Token': token() }, extra || {}); }

    function showMsg(el, text, kind) {
      el.textContent = text;
      el.className = 'msg ' + (kind || '');
      el.classList.remove('hidden');
    }
    function hide(el) { el.classList.add('hidden'); }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    // ---- Login -------------------------------------------------------------
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      hide($('loginMsg'));
      const user = $('username').value.trim();
      const pass = $('password').value;
      if (user !== 'admin') {
        showMsg($('loginMsg'), 'Username must be "admin".', 'err');
        return;
      }
      $('loginBtn').disabled = true;
      sessionStorage.setItem(TOKEN_KEY, pass);
      const ok = await loadPages(true);
      $('loginBtn').disabled = false;
      if (ok) {
        $('login').classList.add('hidden');
        $('dash').classList.remove('hidden');
      } else {
        sessionStorage.removeItem(TOKEN_KEY);
        showMsg($('loginMsg'), 'Wrong password (ADMIN_TOKEN).', 'err');
      }
    });

    $('logoutBtn').addEventListener('click', () => {
      sessionStorage.removeItem(TOKEN_KEY);
      $('dash').classList.add('hidden');
      $('login').classList.remove('hidden');
      $('password').value = '';
    });

    $('refreshBtn').addEventListener('click', () => loadPages());

    // ---- Data --------------------------------------------------------------
    // Returns false on auth failure so the login flow can react.
    async function loadPages(silent) {
      try {
        const r = await fetch('/api/admin/pages', { headers: authHeaders() });
        if (r.status === 401) return false;
        const data = await r.json();
        if (!r.ok || !data.ok) {
          if (!silent) showMsg($('dashMsg'), data.error || 'Failed to load pages.', 'err');
          return true;
        }
        render(data.pages || []);
        return true;
      } catch {
        if (!silent) showMsg($('dashMsg'), 'Network error loading pages.', 'err');
        return true;
      }
    }

    function render(pages) {
      hide($('dashMsg'));
      $('count').textContent = pages.length + (pages.length === 1 ? ' page' : ' pages');
      const rows = $('rows');
      if (!pages.length) {
        rows.innerHTML = '<tr><td colspan="3" class="muted">No pages synced yet.</td></tr>';
        return;
      }
      rows.innerHTML = pages.map((p) => {
        const slug = escapeHtml(p.slug);
        const pill = p.protected
          ? '<span class="pill restricted">Restricted</span>'
          : '<span class="pill public">Public</span>';
        const allow = (p.protected && p.allow && p.allow.length)
          ? '<div class="allow">' + p.allow.map(escapeHtml).join(', ') + '</div>'
          : (p.protected ? '<div class="allow muted">No one pre-approved</div>' : '');
        const action = p.protected
          ? '<button class="ghost" data-act="public" data-slug="' + slug + '">Make public</button> ' +
            '<button class="ghost" data-act="edit" data-slug="' + slug + '">Edit access</button>'
          : '<button data-act="restrict" data-slug="' + slug + '">Restrict</button>';
        return '<tr>' +
          '<td><a class="slug" href="/' + slug + '" target="_blank" rel="noopener">' + slug + '</a></td>' +
          '<td>' + pill + allow + '</td>' +
          '<td><div class="row">' + action + '</div></td>' +
          '</tr>';
      }).join('');
    }

    // ---- Actions -----------------------------------------------------------
    async function setAccess(slug, body) {
      const r = await fetch('/api/admin/page', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(Object.assign({ slug }, body))
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    $('rows').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const slug = btn.dataset.slug;
      const act = btn.dataset.act;

      if (act === 'public') {
        if (!confirm('Make "' + slug + '" public? Anyone with the link will be able to view it.')) return;
        btn.disabled = true;
        try { await setAccess(slug, { protected: false }); showMsg($('dashMsg'), slug + ' is now public.', 'ok'); }
        catch (err) { showMsg($('dashMsg'), err.message, 'err'); }
        await loadPages();
        return;
      }

      if (act === 'restrict' || act === 'edit') {
        openRestrict(slug, act === 'edit');
      }
    });

    // ---- Restrict dialog ---------------------------------------------------
    const dlg = $('restrictDlg');
    let dlgSlug = '';

    async function openRestrict(slug, prefill) {
      dlgSlug = slug;
      $('rSlug').textContent = slug;
      $('rAllow').value = '';
      if (prefill) {
        try {
          const r = await fetch('/api/admin/page?slug=' + encodeURIComponent(slug), { headers: authHeaders() });
          const data = await r.json();
          if (r.ok && data.ok) $('rAllow').value = (data.allow || []).join('\\n');
        } catch {}
      }
      dlg.showModal();
    }

    $('rCancel').addEventListener('click', () => dlg.close());

    $('rSave').addEventListener('click', async () => {
      const allow = $('rAllow').value.split(/[\\n,;]+/).map((s) => s.trim()).filter(Boolean);
      $('rSave').disabled = true;
      try {
        await setAccess(dlgSlug, { protected: true, allow });
        dlg.close();
        showMsg($('dashMsg'), dlgSlug + ' is now restricted.', 'ok');
        await loadPages();
      } catch (err) {
        showMsg($('dashMsg'), err.message, 'err');
      } finally {
        $('rSave').disabled = false;
      }
    });

    // Resume an existing session if the token is still in sessionStorage.
    if (token()) {
      loadPages(true).then((ok) => {
        if (ok) { $('login').classList.add('hidden'); $('dash').classList.remove('hidden'); }
        else sessionStorage.removeItem(TOKEN_KEY);
      });
    }
  </script>
</body>
</html>`;
