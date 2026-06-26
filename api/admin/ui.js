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
    <h2 style="font-size:1.05rem;margin:1.25rem 0 .5rem;">Single-file pages</h2>
    <div class="card">
      <table>
        <thead>
          <tr><th>Page</th><th>Access</th><th></th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="dashMsg" class="msg hidden"></div>
    </div>

    <h2 style="font-size:1.05rem;margin:1.75rem 0 .5rem;">Projects (synced Drive folders)</h2>
    <div class="card" style="margin-bottom:1rem;">
      <form id="createForm" class="row" style="align-items:flex-end;gap:.6rem;">
        <label style="margin:0;flex:1 1 9rem;"><span>Slug</span>
          <input type="text" id="cSlug" placeholder="strategy" pattern="[a-z0-9-]+" required />
        </label>
        <label style="margin:0;flex:2 1 14rem;"><span>Drive folder ID or link</span>
          <input type="text" id="cFolder" placeholder="1AbC... or https://drive.google.com/drive/folders/..." required />
        </label>
        <label style="margin:0;flex:1 1 9rem;"><span>Entry file (optional)</span>
          <input type="text" id="cEntry" placeholder="index.html" />
        </label>
        <button type="submit" id="createBtn">Create</button>
      </form>
      <p class="allow" style="margin-top:.5rem;">Share the private Drive folder with the service account email first (see README). Slug must be unique and not collide with an existing page.</p>
      <div id="createMsg" class="msg hidden"></div>
    </div>
    <div class="card">
      <table>
        <thead>
          <tr><th>Project</th><th>Drive / files</th><th>Last sync</th><th>Access</th><th></th></tr>
        </thead>
        <tbody id="projRows"></tbody>
      </table>
      <div id="projMsg" class="msg hidden"></div>
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

  <!-- Project access dialog -->
  <dialog id="accessDlg">
    <form method="dialog">
      <h3 style="margin:.1rem 0 1rem;">Access for <code id="aSlug"></code></h3>
      <fieldset>
        <label><span>Allowed emails (one per line)</span></label>
        <textarea id="aEmails" rows="5" style="width:100%;padding:.6rem .7rem;border:1px solid #d1d5db;border-radius:.5rem;background:transparent;color:inherit;font-family:inherit;"></textarea>
      </fieldset>
      <fieldset>
        <label><span>Allowed domain (optional, e.g. mycompany.com)</span>
          <input type="text" id="aDomain" placeholder="mycompany.com" />
        </label>
        <p class="allow">Anyone signing in with a matching email or domain can view every page in this project.</p>
      </fieldset>
      <div class="row" style="justify-content:flex-end;">
        <button type="button" class="ghost" id="aCancel">Cancel</button>
        <button type="button" id="aSave">Save</button>
      </div>
    </form>
  </dialog>

  <!-- Project logs dialog -->
  <dialog id="logsDlg">
    <form method="dialog">
      <h3 style="margin:.1rem 0 1rem;">Sync log — <code id="lSlug"></code></h3>
      <pre id="lBody" style="max-height:24rem;overflow:auto;background:#0b1020;color:#e5e7eb;padding:.8rem;border-radius:.5rem;font-size:.78rem;white-space:pre-wrap;"></pre>
      <div class="row" style="justify-content:flex-end;">
        <button type="button" class="ghost" id="lClose">Close</button>
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
        loadProjects();
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

    $('refreshBtn').addEventListener('click', () => { loadPages(); loadProjects(); });

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

    // ---- Projects ----------------------------------------------------------
    function fmtTime(iso) {
      if (!iso) return 'never';
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    }

    async function loadProjects() {
      try {
        const r = await fetch('/api/admin/projects', { headers: authHeaders() });
        if (r.status === 401) return;
        const data = await r.json();
        if (!r.ok || !data.ok) { showMsg($('projMsg'), data.error || 'Failed to load projects.', 'err'); return; }
        renderProjects(data.projects || []);
      } catch {
        showMsg($('projMsg'), 'Network error loading projects.', 'err');
      }
    }

    function statusPill(status) {
      const cls = status === 'ok' ? 'public' : (status === 'error' ? 'restricted' : '');
      return '<span class="pill ' + cls + '">' + escapeHtml(status || 'created') + '</span>';
    }

    function renderProjects(projects) {
      hide($('projMsg'));
      const rows = $('projRows');
      if (!projects.length) {
        rows.innerHTML = '<tr><td colspan="5" class="muted">No projects yet. Create one above.</td></tr>';
        return;
      }
      rows.innerHTML = projects.map((p) => {
        const slug = escapeHtml(p.slug);
        const access = (p.allowedEmails && p.allowedEmails.length ? p.allowedEmails.length + ' email(s)' : 'no emails')
          + (p.allowedDomain ? ' · @' + escapeHtml(p.allowedDomain) : '');
        const err = p.lastError ? '<div class="allow muted">' + escapeHtml(p.lastError) + '</div>' : '';
        return '<tr>' +
          '<td><a class="slug" href="/' + slug + '/" target="_blank" rel="noopener">' + slug + '</a>' + statusPill(p.status) + err + '</td>' +
          '<td><div class="allow">' + escapeHtml(p.driveFolderId) + '</div><div class="allow muted">' + (p.fileCount || 0) + ' files</div></td>' +
          '<td class="allow">' + escapeHtml(fmtTime(p.lastSyncedAt)) + '</td>' +
          '<td class="allow">' + escapeHtml(access) + '</td>' +
          '<td><div class="row">' +
            '<button class="ghost" data-pact="sync" data-slug="' + slug + '">Sync</button>' +
            '<button class="ghost" data-pact="force" data-slug="' + slug + '">Full resync</button>' +
            '<button class="ghost" data-pact="access" data-slug="' + slug + '">Access</button>' +
            '<button class="ghost" data-pact="logs" data-slug="' + slug + '">Logs</button>' +
            '<button class="danger" data-pact="delete" data-slug="' + slug + '">Delete</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    async function projectAction(payload) {
      const r = await fetch('/api/admin/projects', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      return { r, data };
    }

    $('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      hide($('createMsg'));
      $('createBtn').disabled = true;
      const { r, data } = await projectAction({
        action: 'create',
        slug: $('cSlug').value.trim().toLowerCase(),
        driveFolderId: $('cFolder').value.trim(),
        entryFile: $('cEntry').value.trim()
      });
      $('createBtn').disabled = false;
      if (r.ok && data.ok) {
        $('cSlug').value = ''; $('cFolder').value = ''; $('cEntry').value = '';
        showMsg($('createMsg'), 'Project created. Click "Sync" to pull files from Drive.', 'ok');
        loadProjects();
      } else {
        showMsg($('createMsg'), data.error || 'Could not create project.', 'err');
      }
    });

    $('projRows').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-pact]');
      if (!btn) return;
      const slug = btn.dataset.slug;
      const act = btn.dataset.pact;

      if (act === 'sync' || act === 'force') {
        const force = act === 'force';
        if (force && !confirm('Full resync re-downloads every file in "' + slug + '". Continue?')) return;
        btn.disabled = true;
        showMsg($('projMsg'), 'Syncing "' + slug + '"…', '');
        const { r, data } = await projectAction({ action: 'sync', slug, force });
        if (r.ok && data.ok) {
          const res = data.result || {};
          showMsg($('projMsg'), 'Synced "' + slug + '": ' + (res.downloaded || 0) + ' downloaded, ' + (res.unchanged || 0) + ' unchanged, ' + (res.removed || 0) + ' removed.', 'ok');
        } else {
          showMsg($('projMsg'), 'Sync failed for "' + slug + '": ' + (data.error || 'unknown error') + ' (see Logs).', 'err');
        }
        loadProjects();
        return;
      }

      if (act === 'delete') {
        if (!confirm('Delete project "' + slug + '" and all its synced files? This cannot be undone.')) return;
        const { r, data } = await projectAction({ action: 'delete', slug });
        if (r.ok && data.ok) showMsg($('projMsg'), 'Deleted "' + slug + '".', 'ok');
        else showMsg($('projMsg'), data.error || 'Delete failed.', 'err');
        loadProjects();
        return;
      }

      if (act === 'access') { openAccess(slug); return; }
      if (act === 'logs') { openLogs(slug); return; }
    });

    // ---- Project access dialog ---------------------------------------------
    const accessDlg = $('accessDlg');
    let accessSlug = '';
    async function openAccess(slug) {
      accessSlug = slug;
      $('aSlug').textContent = slug;
      $('aEmails').value = ''; $('aDomain').value = '';
      try {
        const r = await fetch('/api/admin/projects', { headers: authHeaders() });
        const data = await r.json();
        const p = (data.projects || []).find((x) => x.slug === slug);
        if (p) { $('aEmails').value = (p.allowedEmails || []).join('\\n'); $('aDomain').value = p.allowedDomain || ''; }
      } catch {}
      accessDlg.showModal();
    }
    $('aCancel').addEventListener('click', () => accessDlg.close());
    $('aSave').addEventListener('click', async () => {
      const allowedEmails = $('aEmails').value.split(/[\\n,;]+/).map((s) => s.trim()).filter(Boolean);
      const allowedDomain = $('aDomain').value.trim();
      $('aSave').disabled = true;
      const { r, data } = await projectAction({ action: 'update', slug: accessSlug, allowedEmails, allowedDomain });
      $('aSave').disabled = false;
      if (r.ok && data.ok) { accessDlg.close(); showMsg($('projMsg'), 'Updated access for "' + accessSlug + '".', 'ok'); loadProjects(); }
      else showMsg($('projMsg'), data.error || 'Could not save access.', 'err');
    });

    // ---- Project logs dialog -----------------------------------------------
    const logsDlg = $('logsDlg');
    async function openLogs(slug) {
      $('lSlug').textContent = slug;
      $('lBody').textContent = 'Loading…';
      logsDlg.showModal();
      try {
        const r = await fetch('/api/admin/projects?slug=' + encodeURIComponent(slug) + '&logs=1', { headers: authHeaders() });
        const data = await r.json();
        const lines = (data.logs || []).map((l) => '[' + l.at + '] ' + l.level.toUpperCase() + ': ' + l.message + (l.extra ? ' ' + JSON.stringify(l.extra) : ''));
        $('lBody').textContent = lines.length ? lines.join('\\n') : 'No logs yet.';
      } catch { $('lBody').textContent = 'Failed to load logs.'; }
    }
    $('lClose').addEventListener('click', () => logsDlg.close());

    // Resume an existing session if the token is still in sessionStorage.
    if (token()) {
      loadPages(true).then((ok) => {
        if (ok) { $('login').classList.add('hidden'); $('dash').classList.remove('hidden'); loadProjects(); }
        else sessionStorage.removeItem(TOKEN_KEY);
      });
    }
  </script>
</body>
</html>`;
