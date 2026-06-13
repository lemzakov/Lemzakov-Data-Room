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

Page protection (public/restricted), Google sign-in & Telegram approvals (see "Protecting pages" below):

- `ADMIN_TOKEN` - token for the publish/access API (`/api/admin/page`). Falls back to `SYNC_SECRET` if unset.
- `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` - OAuth 2.0 Web client credentials used to sign visitors in. Add `https://<your-domain>/api/auth/google/callback` as an Authorized redirect URI in Google Cloud Console.
- `GOOGLE_OAUTH_REDIRECT_URI` - optional override if the callback URL differs from `<request-origin>/api/auth/google/callback`.
- `TELEGRAM_BOT_TOKEN` - bot token from [@BotFather](https://t.me/BotFather).
- `TELEGRAM_ADMIN_CHAT_ID` - the chat id that should receive access requests (your own chat with the bot). Get it from `https://api.telegram.org/bot<TOKEN>/getUpdates` after messaging the bot.
- `TELEGRAM_WEBHOOK_SECRET` - shared secret validating incoming webhook calls (set the same value when registering the webhook).

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
- `GET /admin` - admin dashboard: sign in with username `admin` + `ADMIN_TOKEN`, see every page, and flip any page between public and restricted
- `GET /api/admin/pages` - list every stored page with its access state (admin token required)
- `GET /<slug>` - render stored HTML from KV. If the page is restricted: redirects to Google sign-in when not signed in, or to `/request-access` when signed in but not approved.
- `GET /login` - convenience redirect into Google sign-in
- `GET /request-access` - page with the "Request access" button for restricted pages
- `GET|POST /api/admin/page` - read or set a page's access (admin token required)
- `GET /api/auth/google/start` · `GET /api/auth/google/callback` - Google OAuth sign-in
- `GET /api/auth/me` · `POST /api/auth/logout` - session helpers
- `POST /api/access/request` - submit an access request (sends it to Telegram)
- `POST /api/telegram/webhook` - receives Approve/Deny taps from the bot

## Protecting pages

By default every synced page is **public**. Protection is opt-in and per page.
A **restricted** page requires Google sign-in, and only approved emails can view
it; others can request access, which you approve from Telegram.

**The easiest way** is the admin dashboard at **`/admin`**: sign in with the
username `admin` and your `ADMIN_TOKEN` as the password. You'll see every synced
page and can flip each between public and restricted (with an optional list of
pre-approved emails) in one click. The token never leaves the browser's
`sessionStorage`; every action is re-authorized server-side.

You can also **set access** with the bundled Claude skill (`/publish-page`) or
directly via the API:

```bash
# make a page restricted (no one pre-approved; visitors use "Request access")
curl -X POST https://your-domain/api/admin/page \
  -H 'Content-Type: application/json' -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"slug":"investor-deck","protected":true,"allow":[]}'

# restricted + pre-approve people
curl -X POST https://your-domain/api/admin/page \
  -H 'Content-Type: application/json' -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"slug":"investor-deck","allow":["alice@x.com","bob@y.com"]}'

# make it public again
curl -X POST https://your-domain/api/admin/page \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"investor-deck","protected":false}'
```

**How a visitor gets in** (identity is always Google-verified, server-side):

1. They open a restricted page and are sent to **Google sign-in**.
2. If their email is on the page's allow list → the page renders.
3. If not → the **Request access** page; tapping the button sends their name +
   email to your **Telegram** bot with Approve / Deny buttons.
4. You tap **Approve** → the email is added to the page's allow list.
5. They revisit and are let in. A **~6-month session** cookie (`ldr_session`,
   httpOnly + Secure) keeps them signed in.

Access is enforced on every request: only emails on a page's allow list can view
it. Re-running publish with a new list revokes anyone removed. Access records
live alongside the HTML in Redis, so re-syncing from Drive never resets them.

The `/publish-page` skill (`.claude/skills/publish-page`) wraps the publish API;
it needs `LDR_BASE_URL` and `LDR_ADMIN_TOKEN` in the environment.

### One-time setup

1. **Google OAuth**: create an OAuth 2.0 **Web application** client in Google
   Cloud Console. Add `https://<your-domain>/api/auth/google/callback` as an
   authorized redirect URI. Put the client id/secret in `GOOGLE_OAUTH_CLIENT_ID`
   / `GOOGLE_OAUTH_CLIENT_SECRET`.
2. **Telegram bot**: create a bot with @BotFather → `TELEGRAM_BOT_TOKEN`. Message
   the bot, then read your chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_ADMIN_CHAT_ID`.
3. **Register the webhook** (once), using a secret you also store in
   `TELEGRAM_WEBHOOK_SECRET`:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram/webhook&secret_token=<SECRET>"
   ```

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
