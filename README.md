# Lemzakov-Data-Room

Simple Vercel app that syncs public HTML files from a Google Drive folder into Vercel Redis and serves them by slug:

- `https://your-domain/<html-file-name-without-.html>`
- manual refresh page: `https://your-domain/secret-refresh`

## Configuration

Project configuration lives in `/tmp/workspace/lemzakov/Lemzakov-Data-Room/sync.config.json`.

Required environment variables:

- `GOOGLE_API_KEY` - Google API key for Drive API access
- `GOOGLE_DRIVE_FOLDER_ID` **or** `GOOGLE_DRIVE_FOLDER_LINK`
- `REDIS_URL` (provided by the Vercel Redis integration, for example `redis://...` or `rediss://...`)

Optional:

- `SYNC_SECRET` - required token for `/api/sync` and `/secret-refresh?run=1`

## Routes

- `GET /api/sync` or `POST /api/sync` - sync HTML files from Drive to Redis
- `GET /api/diagnose` - read-only health check of the Drive integration (never returns the API key)
- `GET /secret-refresh` - web form for manual sync trigger
- `GET /<slug>` - render stored HTML from KV

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

- Vercel runs `npm run build` during deployment, which now performs a full Google Drive → Redis sync.
- Deployments fail if no HTML files are synced or if any file download/upload step fails.
- Sync logs include sanitized Google Drive request/response details and per-file failure details.

## Logs

Sync flow logs Google Drive request/response metadata, uploaded files, and detailed failures with `console.log` / `console.error` (visible in Vercel function logs).
