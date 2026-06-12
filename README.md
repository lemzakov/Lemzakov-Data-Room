# Lemzakov-Data-Room

Simple Vercel app that syncs public HTML files from a Google Drive folder into Vercel Redis and serves them by slug:

- `https://your-domain/<html-file-name-without-.html>`
- manual refresh page: `https://your-domain/secret-refresh`

## Configuration

Project configuration lives in `/tmp/workspace/lemzakov/Lemzakov-Data-Room/sync.config.json`.

Required environment variables:

- `GOOGLE_DRIVE_FOLDER_ID` **or** `GOOGLE_DRIVE_FOLDER_LINK`
- **One** Google credential:
  - `GOOGLE_SERVICE_ACCOUNT_JSON` (**recommended**) - service account key, raw JSON or base64-encoded JSON, **or**
  - `GOOGLE_API_KEY` - API key (only works for fully public folders; cannot reliably enumerate folder contents)
- `REDIS_URL` (provided by the Vercel Redis integration, for example `redis://...` or `rediss://...`)

Optional:

- `SYNC_SECRET` - required token for `/api/sync`, `/api/diagnose` and `/secret-refresh?run=1`

Page protection & passkey auth (see "Protecting pages" below):

- `ADMIN_TOKEN` - token for the publish/access API (`/api/admin/page`). Falls back to `SYNC_SECRET` if unset.
- `RESEND_API_KEY` + `EMAIL_FROM` - send the one-time email codes via [Resend](https://resend.com). `EMAIL_FROM` must be a verified sender, e.g. `Data Room <auth@yourdomain.com>`. If unset, codes are logged instead of emailed (dev only).
- `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_NAME` - optional overrides. By default the Relying Party ID and origin are derived from the request host, which is correct for a single custom domain. Set these explicitly if serving passkeys across a fixed custom domain different from the deployment host.

### Recommended: service account (works with private folders)

An API key can only read **publicly shared** content and often returns an empty
list when enumerating a folder. A service account avoids both problems:

1. In Google Cloud Console, create a **service account** and a **JSON key**.
2. Enable the **Google Drive API** for that project.
3. Open the JSON key and copy the `client_email` (looks like `name@project.iam.gserviceaccount.com`).
4. In Google Drive, **share the folder** with that email as **Viewer** (for a Shared Drive, add it as a member).
5. Set `GOOGLE_SERVICE_ACCOUNT_JSON` in Vercel. Because Vercel env vars mangle
   multi-line PEM keys, base64-encode the file first:
   `base64 -w0 service-account.json` (macOS: `base64 -i service-account.json`).

The folder no longer needs to be public. `/api/diagnose` reports `authMode` and,
in service-account mode, the `serviceAccountEmail` to share with.

## Routes

- `GET /api/sync` or `POST /api/sync` - sync HTML files from Drive to Redis
- `GET /api/diagnose` - read-only health check of the Drive integration (never returns the API key)
- `GET /secret-refresh` - web form for manual sync trigger
- `GET /<slug>` - render stored HTML from KV (redirects to `/login` if the page is protected and the visitor is not signed in)
- `GET /login` - sign-in / passkey-registration page for protected pages
- `GET|POST /api/admin/page` - read or set a page's access (admin token required)
- `POST /api/auth/*` - email-code + passkey registration/login endpoints (used by `/login`)

## Protecting pages

By default every synced page is **public**. Protection is opt-in and per page.

**Set access** with the bundled Claude skill (`/publish-page`) or directly:

```bash
# protect a page for specific people
curl -X POST https://your-domain/api/admin/page \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"slug":"investor-deck","allow":["alice@x.com","bob@y.com"]}'

# make it public again
curl -X POST https://your-domain/api/admin/page \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"investor-deck","protected":false}'
```

**How a visitor gets in** (all server-verified):

1. They open a protected page and are redirected to `/login?next=/<slug>`.
2. They enter their email and receive a **6-digit one-time code** (proves email ownership).
3. After verifying, they create a **passkey** (Face ID / Touch ID / security key) bound to that email.
4. A **~6-month session** cookie (`ldr_session`, httpOnly + Secure) is set; return visits use the passkey only.

Access is enforced on every request: only emails on a page's allow list can view it, even with a valid passkey. Re-running the publish call with a new list revokes anyone removed. Access records live alongside the HTML in Redis, so re-syncing from Drive never resets them.

The `/publish-page` skill (`.claude/skills/publish-page`) wraps all of this; it
needs `LDR_BASE_URL` and `LDR_ADMIN_TOKEN` in the environment.

## Debugging the Google Drive integration

This integration authenticates with **only a Google API key** (no OAuth). An API
key can read **only publicly shared** content, so the folder *and its files* must
be shared as **"Anyone with the link can view"**. Use these exact steps to find
what's wrong:

1. **Run the diagnostic** (pinpoints the exact failure mode without leaking the key):
   - Deployed: `GET https://your-domain/api/diagnose` (add `?secret=...` if `SYNC_SECRET` is set).
   - Locally: `GOOGLE_DRIVE_FOLDER_ID=... GOOGLE_API_KEY=... npm run diagnose`
2. **Read the `summary` + `hint`** in the JSON report and match it below:

| What you see | Cause | Fix |
|---|---|---|
| `Configuration error` | `GOOGLE_DRIVE_FOLDER_ID`/`GOOGLE_API_KEY` not visible to the function | Set them in Vercel env vars and **redeploy** (env changes need a redeploy) |
| HTTP `403` + "referer ... blocked" | API key restricted to **HTTP referrers** | In Cloud Console > Credentials, set the key's Application restriction to **None** or **IP addresses** (server calls send no referer) |
| HTTP `403` + "has not been used in project ... or it is disabled" | **Drive API not enabled** | Enable **Google Drive API** in APIs & Services > Library |
| HTTP `400` + "API key not valid" | Wrong key value | Re-copy `GOOGLE_API_KEY` |
| `200` but `totalItems: 0` | Folder/files **not public**, wrong folder ID, or a **Shared Drive** | Share folder + files as "Anyone with the link"; verify the ID |
| `totalItems > 0` but `htmlItems: 0` | Files aren't HTML (e.g. Google Docs) | Put `.html`/`.htm` files (or `text/html`) in the folder |
| `OK: N HTML file(s) ...` | Drive side is healthy | Run `/api/sync`; if it still fails, check `REDIS_URL` |

## Deployment behavior

- Vercel runs `npm run build` during deployment, which attempts a full Google Drive → Redis sync.
- A failed sync **no longer blocks the deploy**: the build logs a full diagnosis and continues, so `/api/diagnose` and already-synced pages stay available. The every-30-min cron (`/api/sync`) retries automatically once Drive is fixed.
- Only unexpected (non-Drive) errors fail the build.
- Sync logs include sanitized Google Drive request/response details and per-file failure details.

## Logs

Sync flow logs Google Drive request/response metadata, uploaded files, and detailed failures with `console.log` / `console.error` (visible in Vercel function logs).
