# Lemzakov-Data-Room

Simple Vercel app that syncs public HTML files from a Google Drive folder into Vercel Storage (KV) and serves them by slug:

- `https://your-domain/<html-file-name-without-.html>`
- manual refresh page: `https://your-domain/secret-refresh`

## Configuration

Project configuration lives in `/tmp/workspace/lemzakov/Lemzakov-Data-Room/sync.config.json`.

Required environment variables:

- `GOOGLE_API_KEY` - Google API key for Drive API access
- `GOOGLE_DRIVE_FOLDER_ID` **or** `GOOGLE_DRIVE_FOLDER_LINK`
- `KV_REST_API_URL` and `KV_REST_API_TOKEN` (provided by Vercel KV integration)
- Do not use a `redis://...` TCP URL here; this app requires the HTTPS REST URL/token pair.

Optional:

- `SYNC_SECRET` - required token for `/api/sync` and `/secret-refresh?run=1`

## Routes

- `GET /api/sync` or `POST /api/sync` - sync HTML files from Drive to KV
- `GET /secret-refresh` - web form for manual sync trigger
- `GET /<slug>` - render stored HTML from KV

## Logs

Sync flow logs file scan, upload success, and errors with `console.log` / `console.error` (visible in Vercel function logs).
