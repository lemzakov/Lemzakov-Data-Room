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

## Usage

Run the helper (`scripts/publish.js`) with Node:

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
- **Revoke** by re-running with the new allow list (omit the email); they lose
  access on their next request.
- Approvals normally happen in Telegram, but you can also pre-approve or revoke
  here at publish time with `--allow`.
