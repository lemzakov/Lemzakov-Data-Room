---
name: publish-page
description: Publish a page to the Lemzakov Data Room and set who can access it. Use when the user wants to publish/update a data-room page, protect a page for specific people, restrict or grant access by email, or make a page public again. Handles per-page access control; allowed users authenticate with a passkey after a one-time email verification.
---

# Publish a Data Room page with access control

Publish or update an HTML page on the Lemzakov Data Room and control **who can
view it**. Protection is per-page and opt-in: a page with no allow list stays
public; adding emails makes it private to exactly those people.

## How access works (so you can explain it)

1. You publish a page and set an **allow list of emails**.
2. When an allowed person opens the page, they're sent to `/login`.
3. They enter their email and receive a **one-time code** by email (proves they
   own the address).
4. After verifying, they create a **passkey** (Face ID / Touch ID / security
   key) bound to that email.
5. A **~6-month session** cookie is set; return visits just use the passkey, no
   code needed.

People **not** on a page's allow list cannot view it, even with a valid passkey.

## Prerequisites

These must be available in the environment (set by the data-room owner):

- `LDR_BASE_URL` — the deployed site, e.g. `https://data-room.example.com`
- `LDR_ADMIN_TOKEN` — the `ADMIN_TOKEN` (or `SYNC_SECRET`) configured in Vercel

If either is missing, ask the user for it before running. Never print the token.

The server side also needs `RESEND_API_KEY` + `EMAIL_FROM` configured in Vercel
for the verification emails to actually send (see the repo README).

## Usage

Run the helper script (`scripts/publish.js`) with Node:

- **Protect a page for specific people:**
  ```bash
  node scripts/publish.js --slug investor-deck --allow alice@x.com,bob@y.com
  ```

- **Publish/replace the HTML and set access in one step:**
  ```bash
  node scripts/publish.js --slug investor-deck --html-file ./deck.html --allow alice@x.com
  ```

- **Make a page public again:**
  ```bash
  node scripts/publish.js --slug public-memo --public
  ```

- **Inspect current access for a page:**
  ```bash
  node scripts/publish.js --slug investor-deck --show
  ```

Slugs are the page name without `.html` (the same slug the page is served at:
`/<slug>`). Emails are lower-cased and de-duplicated server-side.

## Notes

- Pages synced from Google Drive keep working; this only adds an access record
  alongside them, so re-syncing HTML does **not** reset access.
- To **revoke** someone, re-run with the new allow list (omit their email). They
  lose access immediately on their next request; their session is no longer
  honored for that page.
- After setting access, tell the user which emails were granted and remind them
  each person verifies via email + passkey on first visit.
