# Lemzakov-Data-Room

Vercel app that syncs HTML from Google Drive into Vercel Redis and serves it. Two flows share the same stack:

1. **Single-file pages** — each `.html` in one Drive folder is served by slug:
   - `https://your-domain/<html-file-name-without-.html>`
   - manual refresh page: `https://your-domain/secret-refresh`
2. **Project portals** — each project maps ONE private Drive folder (recursively,
   including subfolders + static assets) to `https://your-domain/<projectname>`,
   gated behind Google sign-in and a per-project allow list. See
   [Project portals](#project-portals-multi-page-synced-drive-folders) below.

## Configuration

Project configuration lives in `sync.config.json`. All required environment variables are documented in `.env.example`.

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
- `TELEGRAM_ADMIN_CHAT_ID` - the chat id that should receive access requests **and publish notifications**, and the *only* chat the bot menu answers (your own chat with the bot). Get it from `https://api.telegram.org/bot<TOKEN>/getUpdates` after messaging the bot.
- `TELEGRAM_WEBHOOK_SECRET` - shared secret validating incoming webhook calls (set the same value when registering the webhook).
- `PAGE_DOMAINS` - comma/space-separated hostnames a single-file page is reachable on, used to build the address list in publish notifications and the Telegram menu. Defaults to `data.lemzakov.com,data.wize.ae`.

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
- `POST /api/telegram/webhook` - receives Approve/Deny taps **and** the private admin bot menu commands/navigation (owner-only)

Remote MCP connector routes (OAuth-protected; see "Remote MCP connector" below):

- `GET|POST /mcp` - the remote MCP endpoint (Bearer token required)
- `GET /.well-known/oauth-protected-resource` · `GET /.well-known/oauth-authorization-server` - OAuth discovery metadata
- `POST /api/mcp/register` - dynamic client registration; `GET|POST /api/mcp/authorize` - sign-in + auth code; `POST /api/mcp/token` - token exchange

Project portal routes:

- `GET /<projectname>/` and `GET /<projectname>/<path>` - serve a project's mirrored files (entry point at the root). Requires Google sign-in **and** membership in the project; unauthorized users get a clean "no access" page.
- `GET /api/admin/projects` - list projects (admin token); `?slug=&logs=1` returns a project's sync logs
- `POST /api/admin/projects` - project actions (`create`/`update`/`delete`/`sync`/`addEmail`/`removeEmail`/`setDomain`), admin token required
- `GET|POST /api/projects-sync` - incremental sync of all projects (Vercel Cron target; `?force=1` for a full resync). Protected by `CRON_SECRET`/`SYNC_SECRET`.
- `POST /api/projects-changes` - Drive `changes.watch` webhook **stub** (acknowledges only; cron does the syncing for now)

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

### Organizing pages with categories

Single-file pages can be grouped into **categories** so a growing data room stays
organized. A category is a free-form short label (e.g. `Investors`, `Marketing`)
created implicitly the moment you assign it — there is nothing to pre-define.

- In **`/admin`**, each page row has a **Category** button; the Single-file pages
  table is grouped under category headings, with a **Category** filter dropdown to
  focus on one group. Uncategorized pages fall under an "Uncategorized" bucket.
- Category is **independent of access** — changing it never flips a page between
  public and restricted, and it survives re-syncs (it lives at `pagemeta:<slug>`
  in Redis, separate from the ACL).
- The publish APIs accept an optional `category`:
  ```bash
  curl -X POST https://your-domain/api/admin/page \
    -H 'Content-Type: application/json' -H "X-Admin-Token: $ADMIN_TOKEN" \
    -d '{"slug":"investor-deck","category":"Investors"}'
  ```
  The MCP `publish_page` tool takes the same optional `category` argument, and
  `list_pages` returns each page's `category`.

### Telegram bot: publish alerts + a private page menu

The same bot that approves access requests doubles as a **private admin console**
for your pages. It only ever responds to `TELEGRAM_ADMIN_CHAT_ID` — every message
and button tap from anyone else is refused, so the bot is yours alone.

- **Publish notifications** — whenever a page's HTML is (re)published (via `/admin`,
  the publish API, or either MCP server), the bot messages you the page's slug,
  category, access state, and **every address it resolves to** (one per
  `PAGE_DOMAINS` entry, e.g. `https://data.lemzakov.com/<slug>` **and**
  `https://data.wize.ae/<slug>`).
- **Menu navigation** — message the bot:
  - `/start` or `/menu` → main menu (**All pages** · **Categories**)
  - `/list` → a flat listing of every page with its addresses
  - `/categories` → tap a **category**, then a **page**, to get its URLs
- Delivery is best-effort: a Telegram outage never blocks or fails a publish.

### MCP server: upload HTML without Google Drive

For MCP clients (Claude Code / Claude Desktop / the `/publish-page` skill) the
repo ships a small **stdio MCP server** at `mcp/data-room-mcp.js`, registered in
`.mcp.json` as the `data-room` server. It publishes HTML **directly** — no
Google Drive folder, no sync — by calling the same admin API as above. It has
**zero runtime dependencies** (Node built-ins only).

It reads two env vars (the same ones the skill uses):

- `LDR_BASE_URL` — the deployed site, e.g. `https://data-room.example.com`
- `LDR_ADMIN_TOKEN` — the `ADMIN_TOKEN` (or `SYNC_SECRET`) set in Vercel

Tools:

| Tool | What it does |
|---|---|
| `publish_page` | Publish/replace a page's HTML (inline `html` or local `htmlFile`) and set access (`public`/`restricted` + `allow`) in one call |
| `set_page_access` | Flip a page public/restricted and edit its allow list (no HTML change) |
| `get_page` | Read a page's current access record |
| `list_pages` | List every stored page and its access state |

`.mcp.json` references the env vars by name, so export them (or put them in your
MCP client config) before starting the client:

```bash
export LDR_BASE_URL=https://data-room.example.com
export LDR_ADMIN_TOKEN=...   # ADMIN_TOKEN / SYNC_SECRET
```

This is the recommended path for publishing a **single** page; the Drive sync
flow remains available and unchanged for folder-based content.

### Remote MCP connector (OAuth) — publish from Claude mobile/desktop/web

The stdio server above runs **locally** (Claude Code / Claude Desktop). To
publish HTML straight from a **Claude.ai chat on your phone, desktop app, or the
web** — e.g. "publish this as `/pitch`" right after Claude generates a page —
the repo also ships a **remote, OAuth-protected MCP server** that you add as a
[custom connector](https://support.anthropic.com/en/articles/11175166-about-custom-connectors).

**Add the connector** (Claude → Settings → Connectors → *Add custom connector*):

```
https://<your-domain>/mcp
```

Claude discovers the OAuth endpoints automatically, opens a small sign-in page,
and asks for your **admin token** (the same `ADMIN_TOKEN` / `SYNC_SECRET` that
guards `/admin`). After you enter it once, Claude holds an access token and can
call the publish tools (`publish_page`, `set_page_access`, `get_page`,
`list_pages`) from any chat. No extra environment variables are required — it
reuses `ADMIN_TOKEN`, `REDIS_URL`, and the existing page store.

**How the OAuth works** (standard MCP authorization — Authorization Code + PKCE
+ Dynamic Client Registration, implemented with zero new dependencies):

| Endpoint | Purpose |
|---|---|
| `GET /mcp` · `POST /mcp` | The MCP endpoint. Requires a Bearer token; unauthenticated calls return `401` with a `WWW-Authenticate` challenge that starts the flow. |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 — points at the authorization server. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 — advertises the endpoints below + PKCE (S256). |
| `POST /api/mcp/register` | RFC 7591 — dynamic client registration (Claude self-registers). |
| `GET\|POST /api/mcp/authorize` | Login page; you enter the admin token, it mints a one-time auth code. |
| `POST /api/mcp/token` | Exchanges the code (verifying PKCE) for an access + refresh token. |

Access tokens live in Redis (`mcp:token:*`) with a 30-day TTL and are refreshed
automatically; revoke a connector by deleting its `mcp:token:*` / `mcp:refresh:*`
keys (or rotating `ADMIN_TOKEN`). The login step authenticates **you** with the
admin token; PKCE protects the code exchange, so only someone who knows the
token can ever mint a token.

> Unlike viewer sign-in, the connector does **not** require Google OAuth or any
> Google Cloud changes — it gates on the admin token you already have.

### One-time setup

1. **Google OAuth**: create an OAuth 2.0 **Web application** client in Google
   Cloud Console. Add `https://<your-domain>/api/auth/google/callback` as an
   authorized redirect URI. Put the client id/secret in `GOOGLE_OAUTH_CLIENT_ID`
   / `GOOGLE_OAUTH_CLIENT_SECRET`.
2. **Telegram bot**: create a bot with @BotFather → `TELEGRAM_BOT_TOKEN`. Message
   the bot, then read your chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_ADMIN_CHAT_ID`.
3. **Register the webhook** (once). The endpoint rejects any update whose secret
   doesn't match the deployed `TELEGRAM_WEBHOOK_SECRET`, so the reliable way is to
   register from the **same environment** the app runs with — then the two can't
   drift and you never have to remember the secret:
   ```bash
   # pulls the deployed TELEGRAM_* + PAGE_DOMAINS, then registers with them
   vercel env pull .env.local
   npm run register-telegram        # the script auto-loads .env.local / .env
   ```
   The script reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`, derives the
   URL from `WEBHOOK_URL` or the first `PAGE_DOMAINS` host, sets
   `allowed_updates` to `["message","callback_query"]`, and prints
   `getWebhookInfo` to confirm. Inspect or remove it with `--info` / `--delete`.
   Plain-curl equivalent (secret must match the env var by hand):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram/webhook&secret_token=<SECRET>&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D"
   ```

## Project portals (multi-page synced Drive folders)

A **project** maps ONE private Google Drive folder to a URL slug and serves the
whole folder — recursively, including subfolders and static assets — at
`https://your-domain/<projectname>`. Every page is gated behind Google sign-in
plus a per-project allow list. This is separate from, and does not affect, the
single-file flow above.

**Persistence:** Redis (the project's existing durable store). Each project is
stored at `project:<slug>`, indexed in the `projects:index` set, with files
mirrored under `projfile:<slug>:<relPath>` and sync logs at `projectlog:<slug>`.

### How a private Drive folder reaches the service account

The folder is **never made public**. The service account reads it because you
share it explicitly:

1. Create a Google Cloud **service account** + **JSON key** and enable the
   **Google Drive API** (same account used by the single-file flow — see
   [Recommended: service account](#recommended-service-account-works-with-private-folders)).
2. Copy the service account's `client_email`
   (`name@project.iam.gserviceaccount.com`).
3. In Google Drive, open the project's root folder → **Share** → add that email
   as **Viewer**. Subfolders inherit access. (For a Shared Drive, add the
   service account as a member of the drive.)
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` in Vercel (base64-encoded is safest).

If a sync returns 0 files, the folder almost certainly isn't shared with the
service account — re-check step 3. The per-project **Logs** button in `/admin`
shows exactly what was listed, downloaded, and skipped.

### Creating and managing projects (`/admin`)

Sign in to **`/admin`** (username `admin` + `ADMIN_TOKEN`). The **Projects**
section lets you:

- **Create** a project: pick a URL slug (lowercase, url-safe, must be unique and
  not collide with `/admin`, the API, or an existing single-file page), paste the
  Drive **folder ID or link**, and optionally set an **entry filename**.
- **Sync now** (incremental) or **Full resync** (re-downloads everything).
- **Access**: edit the allowed-emails list and/or an allowed **domain**
  (e.g. `mycompany.com`).
- **Logs**: view recent sync activity and errors.
- **Delete**: removes the project config **and** all its mirrored files.

### Incremental sync, cross-links, and entry point

- **Incremental:** each file's Drive `modifiedTime` is stored in the project's
  `fileManifest`; only changed/new files are re-downloaded, deleted files are
  pruned. "Full resync" ignores the manifest.
- **Asset-aware:** only real `.html` and static assets (images/CSS/JS/fonts/…)
  are taken. Google-native Docs/Sheets/Slides are skipped and logged.
- **Cross-links preserved:** the Drive folder structure is mirrored **exactly**,
  so relative links (`./page2.html`, `../sub/index.html`) resolve unchanged.
  `/<projectname>` redirects to `/<projectname>/` so relative links resolve
  against the project prefix. Only **root-relative** links (`/style.css`) are
  rewritten — to `/<projectname>/style.css`; absolute and relative links are left
  untouched.
- **Entry point order:** `index.html` at the root → the configured entry
  filename (if present) → the first `.html` alphabetically.

### Access control

- **Admin** (`/admin` + `/api/admin/*`): guarded by `ADMIN_TOKEN`
  (falls back to `SYNC_SECRET`).
- **Viewers:** must sign in with **Google OAuth** (same OAuth app as the
  single-file flow — see [One-time setup](#one-time-setup)). A signed-in user can
  view a project only if their verified email is on the project's
  `allowedEmails` list **or** matches its `allowedDomain`. Everyone else gets a
  clean "no access" page. Enforcement happens on **every** `/<projectname>/*`
  request (`api/project.js` → `lib/project-serve.js`), and project files are
  served with `Cache-Control: private, no-store`.

### Scheduled sync

A Vercel Cron hits `/api/projects-sync` (default **every 15 minutes**,
incremental, all projects). Change the interval by editing the `schedule` in
`vercel.json`. Protect it with `CRON_SECRET` (Vercel Cron sends it as a Bearer
token); it falls back to `SYNC_SECRET`. `POST /api/projects-changes` is a stub
for Drive `changes.watch` push notifications (near-instant sync) — wired and
acknowledging, but the cron does the actual syncing for now.

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
