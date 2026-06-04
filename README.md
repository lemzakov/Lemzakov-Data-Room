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
- `GET /secret-refresh` - web form for manual sync trigger
- `GET /<slug>` - render stored HTML from KV

## Deployment behavior

- Vercel runs `npm run build` during deployment, which now performs a full Google Drive → Redis sync.
- Deployments fail if no HTML files are synced or if any file download/upload step fails.
- Sync logs include sanitized Google Drive request/response details and per-file failure details.

## Logs

Sync flow logs Google Drive request/response metadata, uploaded files, and detailed failures with `console.log` / `console.error` (visible in Vercel function logs).
