---
name: publish-page
description: Publish a page to the Lemzakov Data Room and set whether it is public or restricted. Use when the user wants to publish/update a data-room page, make a page public, restrict a page, pre-approve people by email, or grant/revoke access. Restricted pages use Google sign-in plus a Telegram-approved "Request access" flow.
---

# Publish a Data Room page (public or restricted)

Publish or update an HTML page on the Lemzakov Data Room and choose whether it
is **public** or **restricted**. Protection is per page.

- **Public** — anyone with the link can view it.
- **Restricted** — visitors sign in with **Google**; only approved emails can
  view. Anyone else sees a **Request access** button whose request is sent to
  the owner's **Telegram bot** for one-tap Approve/Deny.

## How restricted access works (so you can explain it)

1. A visitor opens a restricted page and is sent to **Google sign-in**.
2. If their verified Google email is on the page's allow list → they see the page.
3. If not → a **Request access** page; tapping the button sends their name +
   email to the owner's **Telegram** with Approve / Deny buttons.
4. The owner taps **Approve** → the email is added to that page's allow list.
5. The visitor revisits and is let in. A **~6-month session** keeps them signed in.

## Prerequisites

Set by the data-room owner (this skill needs the first two):

- `LDR_BASE_URL` — the deployed site, e.g. `https://data-room.example.com`
- `LDR_ADMIN_TOKEN` — the `ADMIN_TOKEN` (or `SYNC_SECRET`) configured in Vercel

Server side also needs (see repo README): `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` for sign-in, and `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_ADMIN_CHAT_ID` / `TELEGRAM_WEBHOOK_SECRET` for approvals.

If `LDR_BASE_URL` or `LDR_ADMIN_TOKEN` is missing, ask the user. Never print the token.

## How to publish — use the MCP tools (default)

Publish **directly through the bundled `data-room` MCP server** — no Google
Drive, no shell. The server (`mcp/data-room-mcp.js`, registered in `.mcp.json`)
exposes four tools, surfaced to you as:

- `mcp__data-room__publish_page` — publish/replace a page's HTML **and** set its
  access in one call
- `mcp__data-room__set_page_access` — flip a page public/restricted and edit its
  allow list (no HTML change)
- `mcp__data-room__get_page` — read a page's current access record
- `mcp__data-room__list_pages` — list every stored page and its access state

**Always prefer these tools.** Only fall back to the CLI helper (below) if the
`mcp__data-room__*` tools are not present in this session.

### Decide the inputs first

- **slug** — the page name without `.html`; it is served at `/<slug>`.
- **html** — the full HTML document. Pass it inline via `html`, or pass a local
  path via `htmlFile` and the server reads the file. If the user gave you HTML
  content directly, pass it as `html`.
- **access** — `"public"` (anyone with the link) or `"restricted"` (Google
  sign-in + allow list). If omitted, access is left unchanged; if you pass
  `allow` without `access`, the page becomes restricted.
- **allow** — array of emails pre-approved for a restricted page.

### Common calls

- **Publish HTML and make it public** — `mcp__data-room__publish_page`:
  ```json
  { "slug": "public-memo", "html": "<!doctype html>…", "access": "public" }
  ```

- **Publish HTML, restricted, request-access only** — `publish_page`:
  ```json
  { "slug": "investor-deck", "html": "<!doctype html>…", "access": "restricted" }
  ```

- **Publish HTML, restricted, pre-approve people** — `publish_page`:
  ```json
  { "slug": "investor-deck", "htmlFile": "./deck.html",
    "access": "restricted", "allow": ["alice@x.com", "bob@y.com"] }
  ```

- **Change access on an existing page (no HTML change)** —
  `mcp__data-room__set_page_access`:
  ```json
  { "slug": "investor-deck", "access": "restricted", "allow": ["alice@x.com"] }
  ```

- **Make a restricted page public again** — `set_page_access`:
  ```json
  { "slug": "investor-deck", "access": "public" }
  ```

- **Inspect current access** — `mcp__data-room__get_page` with `{ "slug": "investor-deck" }`,
  or `mcp__data-room__list_pages` with `{}` to see every page.

Each tool returns the server's JSON (`{ ok, slug, published, protected, allow … }`)
as text — report the `slug`, whether it `published`, and the resulting
`protected`/`allow` state. On a config error the tool returns
`Missing config: set LDR_BASE_URL and LDR_ADMIN_TOKEN` — if you see that, the
server env vars aren't set; ask the owner (never print the token).

Emails are lower-cased and de-duplicated server-side. Setting `access: "public"`
clears the allow list.

> Pages can also originate from a synced Google Drive folder (see the repo
> README). That flow is independent — the MCP tools write the HTML directly, so
> you never need Drive to publish a single page.

## Fallback: CLI helper (`scripts/publish.js`)

Use this **only** when the `mcp__data-room__*` tools aren't available. Same admin
API under the hood. Run it with Node:

- **Make a page public:**
  ```bash
  node scripts/publish.js --slug public-memo --public
  ```

- **Make a page restricted** (no one pre-approved; people use Request access):
  ```bash
  node scripts/publish.js --slug investor-deck --restricted
  ```

- **Restricted + pre-approve some people:**
  ```bash
  node scripts/publish.js --slug investor-deck --restricted --allow alice@x.com,bob@y.com
  ```

- **Publish/replace the HTML and set access in one step:**
  ```bash
  node scripts/publish.js --slug investor-deck --html-file ./deck.html --restricted
  ```

- **Inspect current access:**
  ```bash
  node scripts/publish.js --slug investor-deck --show
  ```

Slugs are the page name without `.html` (served at `/<slug>`). Emails are
lower-cased and de-duplicated server-side.

## Notes

- Pages synced from Google Drive keep working; this only stores an access record
  alongside them, so re-syncing HTML never resets access.
- **Revoke** by calling `set_page_access` (or `publish_page`) again with the new
  allow list (omit the email); they lose access on their next request.
- Approvals normally happen in Telegram, but you can also pre-approve or revoke
  here at publish time via the `allow` field (`--allow` on the CLI).
