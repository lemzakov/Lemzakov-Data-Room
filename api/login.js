// GET /login — sign-in / registration UI for protected pages.
//
// Single-page flow:
//   1. Enter email.
//   2. If a passkey exists for that email -> prompt the passkey (sign in).
//      Otherwise -> email a one-time code, verify it, then create a passkey.
//   3. On success a ~6-month session cookie is set and the browser is sent to
//      the originally-requested page (?next=).
//
// WebAuthn browser glue comes from @simplewebauthn/browser (loaded as an ES
// module from a pinned CDN); all verification happens server-side.

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(PAGE);
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Sign in — Lemzakov Data Room</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1.25rem; color: #1f2937; }
    h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
    p.sub { color: #6b7280; margin: 0 0 1.5rem; }
    label { display: block; font-size: .85rem; font-weight: 600; margin: 0 0 .35rem; }
    input { width: 100%; box-sizing: border-box; padding: .7rem .8rem; font-size: 1rem; border: 1px solid #d1d5db; border-radius: .5rem; }
    input:focus { outline: 2px solid #2563eb; border-color: #2563eb; }
    button { width: 100%; margin-top: 1rem; padding: .75rem; font-size: 1rem; font-weight: 600; color: #fff; background: #2563eb; border: 0; border-radius: .5rem; cursor: pointer; }
    button:disabled { opacity: .6; cursor: progress; }
    .msg { margin-top: 1rem; padding: .7rem .8rem; border-radius: .5rem; font-size: .9rem; }
    .msg.err { background: #fef2f2; color: #991b1b; }
    .msg.ok { background: #ecfdf5; color: #065f46; }
    .hidden { display: none; }
    .muted { color: #6b7280; font-size: .85rem; margin-top: 1rem; }
    code { background: #f3f4f6; padding: .05rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>Sign in</h1>
  <p class="sub">Secure access to the Lemzakov Data Room.</p>

  <form id="emailForm">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@company.com" required />
    <button type="submit" id="emailBtn">Continue</button>
  </form>

  <form id="codeForm" class="hidden">
    <label for="code">Enter the 6-digit code we emailed you</label>
    <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />
    <button type="submit" id="codeBtn">Verify &amp; continue</button>
    <p class="muted">Sent to <span id="codeEmail"></span>. The code expires in 10 minutes.</p>
  </form>

  <div id="msg" class="msg hidden"></div>
  <p class="muted">Access is by invitation. If your email isn't recognized, ask the data room owner to grant you access.</p>

  <script type="module">
    import { startRegistration, startAuthentication, browserSupportsWebAuthn }
      from 'https://esm.sh/@simplewebauthn/browser@13';

    const params = new URLSearchParams(location.search);
    const next = params.get('next') || '/';
    const $ = (id) => document.getElementById(id);
    const emailForm = $('emailForm'), codeForm = $('codeForm'), msg = $('msg');

    let email = '';

    function show(text, kind) {
      msg.textContent = text;
      msg.className = 'msg ' + (kind || '');
      msg.classList.remove('hidden');
    }
    function clearMsg() { msg.classList.add('hidden'); }
    function go() { location.href = next; }

    async function postJson(url, body) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data = {};
      try { data = await r.json(); } catch {}
      return { status: r.status, data };
    }

    async function signInWithPasskey() {
      const opt = await postJson('/api/auth/passkey/login-options', { email });
      if (opt.status !== 200) return false;
      let assertion;
      try {
        assertion = await startAuthentication({ optionsJSON: opt.data.options });
      } catch (e) {
        show('Passkey prompt was dismissed. Try again.', 'err');
        return true; // a passkey exists; surface the cancel rather than fall back
      }
      const verify = await postJson('/api/auth/passkey/login-verify', { email, response: assertion });
      if (verify.status === 200) { show('Signed in. Redirecting…', 'ok'); go(); return true; }
      show(verify.data.error || 'Sign-in failed.', 'err');
      return true;
    }

    async function registerPasskey() {
      const opt = await postJson('/api/auth/passkey/register-options', { email });
      if (opt.status !== 200) { show(opt.data.error || 'Could not start setup.', 'err'); return; }
      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: opt.data.options });
      } catch (e) {
        show('Passkey setup was cancelled. Reload to try again.', 'err');
        return;
      }
      const verify = await postJson('/api/auth/passkey/register-verify', { email, response: attestation });
      if (verify.status === 200) { show('Passkey created. Redirecting…', 'ok'); go(); return; }
      show(verify.data.error || 'Could not create passkey.', 'err');
    }

    emailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearMsg();
      email = $('email').value.trim().toLowerCase();
      if (!email) return;
      const btn = $('emailBtn'); btn.disabled = true;
      try {
        if (!browserSupportsWebAuthn()) {
          show('This browser does not support passkeys. Use a modern browser or device.', 'err');
          return;
        }
        // Try an existing passkey first; if none, fall back to email verification.
        const handled = await signInWithPasskey();
        if (handled) return;

        const otp = await postJson('/api/auth/request-otp', { email });
        if (otp.status === 429) { show(otp.data.error || 'Please wait before retrying.', 'err'); return; }
        $('codeEmail').textContent = email;
        emailForm.classList.add('hidden');
        codeForm.classList.remove('hidden');
        show('We emailed you a 6-digit code (if your email has access).', 'ok');
        $('code').focus();
      } catch (err) {
        show('Something went wrong. Please try again.', 'err');
      } finally {
        btn.disabled = false;
      }
    });

    codeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearMsg();
      const code = $('code').value.trim();
      if (!code) return;
      const btn = $('codeBtn'); btn.disabled = true;
      try {
        const v = await postJson('/api/auth/verify-otp', { email, code });
        if (v.status !== 200) { show(v.data.error || 'Invalid or expired code.', 'err'); return; }
        if (v.data.hasPasskey) {
          const handled = await signInWithPasskey();
          if (!handled) await registerPasskey();
        } else {
          await registerPasskey();
        }
      } catch (err) {
        show('Something went wrong. Please try again.', 'err');
      } finally {
        btn.disabled = false;
      }
    });

    // If already signed in, skip straight to the destination.
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      if (d && d.authenticated) { show('Already signed in as ' + d.email + '. Redirecting…', 'ok'); setTimeout(go, 600); }
    }).catch(() => {});
  </script>
</body>
</html>`;
