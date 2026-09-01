# Lemzakov-Data-Room

Vercel app that syncs HTML from Google Drive into Vercel storage and serves it. Two flows share the same stack:

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
- `BLOB_READ_WRITE_TOKEN` (provided by the Vercel Blob integration) — see [Where content is stored](#where-content-is-stored)

Optional:

- `SYNC_SECRET` - required token for `/api/sync`, `/api/diagnose` and `/secret-refresh?run=1`

## Where content is stored

Content lives in **two stores at once**, and which one a given page uses is
invisible to visitors.

| | Store | What is in it |
|---|---|---|
| **New writes** | Vercel Blob (private) | Every page and project file written since the cutover, plus **all access records** and **all page images** |
| **Back catalogue** | Redis | Pages, project files and ACLs written before the cutover — deliberately **not** migrated |
| **Always Redis** | Redis | Sessions, project config, page categories, analytics |

Access records are in Blob for an availability reason rather than a size one:
Redis refuses every write once it reaches `maxmemory`, which would otherwise
make it impossible to restrict a page exactly when the store is under pressure.
Writing an ACL to Blob also drops any pre-cutover Redis copy, and making a page
public clears the record from **both** stores — leaving one behind would let the
fallback read keep serving a page as protected after it was opened up.

Reads query both stores concurrently and prefer Blob, so a pre-cutover page
serves from Redis exactly as it always did, and nothing had to be moved. Writes
only ever go to Blob (or to Redis if `BLOB_READ_WRITE_TOKEN` is unset, which
restores the old behaviour wholesale).

**Page images are the one exception with no Redis path at all.** Image bytes in
Redis would mean base64 — a third larger — sitting in the RAM-priced store that
`maxmemory` already took down once, so with no `BLOB_READ_WRITE_TOKEN` an upload
is refused outright instead of quietly filling Redis.

`/admin` labels every page with the store that serves it — `Blob`, `Redis`, or
`Blob + Redis` for a legacy page that has since been re-synced or re-published
(Blob serves it; the Redis copy is an inert leftover).

**The Blob store must be private.** Private blobs have no publicly reachable URL
and are readable only through the read-write token, so every byte still leaves
the app via `api/html.js` or `lib/project-serve.js`, where the Google sign-in
and allow-list checks live. A public store would hand out permanent
unauthenticated URLs and bypass page-level access control entirely. Access
management is unchanged by the move.

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
- `GET /api/admin/stats` - page-open analytics: overview across all pages, or `?slug=` for one page's breakdowns + recent opens (admin token required)
- `POST /api/stat/ping` - viewer-facing engagement beacon (dwell time + scroll depth); no auth, always answers `204`
- `GET /<slug>` - render stored HTML from KV. If the page is restricted: redirects to Google sign-in when not signed in, or to `/request-access` when signed in but not approved.
- `GET /login` - convenience redirect into Google sign-in
- `GET /request-access` - page with the "Request access" button for restricted pages
- `GET|POST /api/admin/page` - read or set a page's access (admin token required)
- `GET|POST|DELETE /api/admin/asset` - list, upload or remove the images attached to a page (admin token required)
- `GET /<slug>/<image>` - an image attached to the page at `/<slug>`, served under that page's own access
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

### Images in a page

A page is one self-contained HTML document, so an image either had to be inlined
as a `data:` URI — bloating the document, and requiring a full republish to
change a picture — or hosted somewhere else. Now it can be **uploaded and
attached to the page**:

```
stored at   asset/<slug>/<name>   (Vercel Blob, private)
served at   /<slug>/<name>
```

The HTML then references it as an ordinary `<img src="/<slug>/<name>">`. Because
the path sits under the page's own URL, no new route was needed: `/<slug>/<path>`
already resolves projects first, and falls through to the page's images when the
slug is an ordinary page.

**Access is not stored per image.** Every image request re-reads the *page's* ACL,
so an image is exactly as visible as the page it belongs to — restricting the
page restricts its images in the same instant, with no second list to keep in
sync. A public page's images are cacheable for five minutes; a restricted page's
are `private, no-store` and, like the page, bounce an unapproved visitor into
Google sign-in.

- **In `/admin`**: each page row has an **Images** button — upload (multiple at
  once), preview, copy the ready-made `<img>` tag, or delete.
- **Over MCP**: `upload_image` → put the returned `path` in the HTML →
  `publish_page`. `list_images` and `delete_image` manage what is already there.
- **From a script** (`.claude/skills/publish-page/scripts/upload-image.js`):
  ```bash
  node upload-image.js --slug investor-deck --file ./chart.png
  node upload-image.js --slug investor-deck --list
  node upload-image.js --slug investor-deck --delete chart.png
  ```
- **Over HTTP**, either raw bytes (no base64 inflation) or JSON:
  ```bash
  curl -X POST "https://your-domain/api/admin/asset?slug=investor-deck&name=chart.png" \
    -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: image/png' \
    --data-binary @chart.png

  curl -X POST https://your-domain/api/admin/asset \
    -H 'Content-Type: application/json' -H "X-Admin-Token: $ADMIN_TOKEN" \
    -d '{"slug":"investor-deck","name":"chart.png","data":"<base64 or data: URI>"}'
  ```

Rules the API enforces:

- **Formats**: png, jpg/jpeg, gif, webp, avif, svg, ico, bmp — nothing else. The
  served `Content-Type` comes from the extension, never from what the uploader
  claimed, and responses carry `X-Content-Type-Options: nosniff`.
- **Size**: 4 MB per image (Vercel caps a request body at 4.5 MB, and base64 adds
  a third on top).
- **Names** are lower-cased and cleaned (`Q3 Chart.PNG` → `q3-chart.png`) into one
  flat namespace per page; any path component is stripped, so nothing can be
  written outside the page's own prefix. Re-uploading a name replaces that image
  without republishing the page.
- Uploading or deleting an image never touches the page's access record, and
  publishing new HTML never touches the images. **Deleting a page deletes its
  images.**

### Page-open analytics (who opened what, when, from where)

Every page open is measured server-side and surfaced per page in **`/admin`**
(the **Stats** button on each single-file page row, plus an inline
"N opens · M visitors" under each slug). Recording happens in the serve path,
so it can't be blocked by ad-blockers and captures every open — including who
is signed in.

Each open is personalised as much as the request allows:

- **Who** — for **restricted** pages, the Google-verified **email + name**; for
  everyone, a persistent `ldr_vid` visitor cookie (~400 days, httpOnly) that
  recognises **repeat opens** and counts **unique visitors**, even anonymous
  ones on public pages.
- **Where** — **country / region / city / timezone** from Vercel's edge geo
  headers, plus the client IP.
- **What** — **device / browser / OS** parsed from the User-Agent, and the
  **referrer** source (e.g. `linkedin.com`, `t.co`, `direct`).
- **How long** — a tiny injected **beacon** reports **active dwell time**
  (paused while the tab is hidden) and **scroll depth**, plus language and
  screen size. It uses `navigator.sendBeacon`, so the reading time survives the
  page being closed. Hidden in print/PDF output.
- **When** — timestamp, with per-day / per-country / per-referrer / per-viewer /
  per-device breakdowns.

The **Stats** dialog shows headline tiles (opens, unique visitors, average
time, countries), first/last open, top viewers by email, country / referrer /
device bar charts, and a **Recent opens** table (time · who · location · device
· referrer · time-on-page · scroll).

Storage is in Redis (`stat:*` keys); per-open detail records carry a ~6-month
TTL and the recent-opens index is capped, so the footprint stays bounded.
Recording **never** blocks or fails page delivery — a Redis hiccup degrades to
"no stats", not an error. Turn the whole feature off with `ANALYTICS_DISABLED=1`.

APIs (admin token required, same as the rest of `/api/admin/*`):

```bash
# overview across every page that has opens
curl https://your-domain/api/admin/stats -H "X-Admin-Token: $ADMIN_TOKEN"
# one page's breakdowns + recent opens
curl "https://your-domain/api/admin/stats?slug=investor-deck" -H "X-Admin-Token: $ADMIN_TOKEN"
```

`POST /api/stat/ping` is the viewer-facing beacon receiver (no auth; it only
records clamped engagement values and always answers `204`).

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
| `upload_image` | Attach an image to a page (inline `data` or local `file`) and get back its `/<slug>/<name>` path |
| `list_images` · `delete_image` | List or remove the images attached to a page |

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
`list_pages`) and the image tools (`upload_image`, `list_images`,
`delete_image`) from any chat. No extra environment variables are required — it
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
3. **Register the webhook — automatic on deploy.** Every **production** Vercel
   build registers the webhook for you (`scripts/verify-sync-on-build.js` →
   `ensureWebhookOnDeploy`). Because it runs with the deployed environment, the
   `secret_token` it sends to Telegram always equals `TELEGRAM_WEBHOOK_SECRET`, so
   the two can never drift into the `401 Unauthorized` state — you don't have to
   run anything or remember the secret. It uses `WEBHOOK_URL` (if set) or the
   first `PAGE_DOMAINS` host, with `allowed_updates=["message","callback_query"]`.

   So the normal flow is just: **set the Telegram env vars in Vercel → redeploy.**
   Preview and local builds are skipped so they never hijack the production
   webhook; opt out entirely with `TELEGRAM_WEBHOOK_AUTOREGISTER=0`.

   You can still register/inspect manually (handy for debugging):
   ```bash
   vercel env pull .env.local          # pulls the deployed TELEGRAM_* + PAGE_DOMAINS
   npm run register-telegram           # set   (auto-loads .env.local / .env)
   npm run register-telegram -- --info     # health check (getWebhookInfo)
   npm run register-telegram -- --delete   # remove
   ```
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

**Persistence:** project metadata stays in Redis — each project at
`project:<slug>`, indexed in the `projects:index` set, with sync logs at
`projectlog:<slug>`. The mirrored **files** follow the two-store rule above:
new syncs write raw bytes to Vercel Blob at `projfile/<slug>/<relPath>`, while
anything synced before the cutover stays in Redis at `projfile:<slug>:<relPath>`
as a base64 envelope. Reads check both, and a delete clears both, so a file
removed upstream in Drive stops serving regardless of where it landed.

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

## Runbook: Redis "OOM command not allowed"

Symptom: writes fail with `OOM command not allowed when used memory > 'maxmemory'`
while pages still load. Redis has hit its memory ceiling under a `noeviction`
policy, so it rejects every command that could grow memory and permits the rest.

**What breaks.** Reads are unaffected, so public pages keep serving and existing
sessions keep working. Everything that writes fails:

| Path | Effect |
|---|---|
| `createSession`, `oauthstate:*` | **New Google sign-ins fail** — restricted pages and project portals are unreachable for anyone not already holding a session cookie |
| `setAcl` (`set_page_access`) | Access changes rejected |
| `setPageCategory`, access requests, MCP OAuth, project config | Rejected |
| Analytics | Silently stops recording — `recordOpen` is guarded and never breaks page delivery |

**Why the Blob change alone is not the fix.** Moving new writes to Blob stops
Redis *growing*; it frees nothing already there. Redis stays full until data is
removed.

### Clearing it

`DEL` is not a `denyoom` command, so the drain runs while the store is still
full — no plan upgrade needed first.

```bash
npm run drain -- --report          # census: keys and MB per class, deletes nothing
npm run drain -- --events          # dry run
npm run drain -- --events --apply  # drop analytics detail records
```

Every pass is a dry run until `--apply`. Order matters:

1. **`--events`** — deletes `stat:ev:*` analytics detail records. Derived,
   already TTL'd data; no Blob copy is made. Safe at any time, no deploy needed.
   Aggregate counters behind `/admin` are left alone. Try this first.
2. **Deploy the Blob branch**, then confirm a page still serves. Until the
   dual-read code is live, readers consult Redis only, and steps 3–4 would take
   pages offline.
3. **`--projfiles`** — copies `projfile:*` to Blob and deletes the Redis copy.
   Usually the largest consumer: these are base64 envelopes, ~33% larger than
   the bytes they hold.
4. **`--html`** — same for `html:*`.

Steps 3 and 4 each verify the Blob copy byte-for-byte and skip the delete if it
does not match, so a failed upload cannot cost content. Both need
`BLOB_READ_WRITE_TOKEN`; step 1 needs only `REDIS_URL`.

Raising `maxmemory` on the Redis plan is the other lever — instant relief, no
code, but the growth resumes unless new writes are going to Blob.

### Deleting pages from /admin

Each row in `/admin` has a **Delete** button. It removes the page HTML, its
access record, its category, every image attached to it and its entire analytics
footprint — the counters plus up to 1000 per-open detail records, which are
usually the larger share.
Both stores are cleared. It asks for confirmation twice, the second time
requiring the slug typed back, because nothing about it is reversible.

This works while Redis is full: the whole operation is `DEL` and `SREM`, neither
of which is a `denyoom` command. Deleting a few heavy, obsolete pages is the
quickest way to get writes accepted again without a terminal.

`DELETE /api/admin/page?slug=<slug>` is the same operation for scripting.

### What still needs Redis

Freeing memory remains necessary — these paths write to Redis and stay broken
until it has headroom:

- **Sessions** (`createSession`, `oauthstate:*`) — new Google sign-ins fail, so
  restricted pages are unreachable to anyone without an existing cookie. This is
  the one that matters most.
- **Access requests** (`accessreq:*`) — the "Request access" button.
- **Page categories** (`pagemeta:*`).
- **Analytics** — silently skipped; never breaks page delivery.

Admin access itself is unaffected: `/admin` authenticates with `ADMIN_TOKEN`,
not Google, so the Delete button is reachable during an outage.
