#!/usr/bin/env node
// Publish a page and/or set its per-page access on the Lemzakov Data Room.
//
// Calls POST /api/admin/page with the admin token. Use it to:
//   - protect a page for specific emails
//   - make a page public again
//   - optionally push/replace the page HTML at the same time
//
// Config (env or flags):
//   LDR_BASE_URL / --base-url   e.g. https://data-room.example.com
//   LDR_ADMIN_TOKEN / --token   ADMIN_TOKEN (or SYNC_SECRET) set in Vercel
//
// Examples:
//   node publish.js --slug investor-deck --restricted               # request-access only
//   node publish.js --slug investor-deck --restricted --allow a@x.com  # + pre-approved
//   node publish.js --slug investor-deck --allow a@x.com,b@y.com    # pre-approved (restricted)
//   node publish.js --slug investor-deck --html-file ./deck.html --restricted
//   node publish.js --slug public-memo --public
//   node publish.js --slug investor-deck --show                     # read current access

const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = (args['base-url'] || process.env.LDR_BASE_URL || '').replace(/\/$/, '');
  const token = args.token || process.env.LDR_ADMIN_TOKEN || '';
  const slug = args.slug;

  if (!baseUrl || !token) {
    console.error('Missing config: set LDR_BASE_URL and LDR_ADMIN_TOKEN (or pass --base-url/--token).');
    process.exit(2);
  }
  if (!slug) {
    console.error('Missing --slug.');
    process.exit(2);
  }

  const endpoint = `${baseUrl}/api/admin/page`;

  // Read-only: show current access.
  if (args.show) {
    const r = await fetch(`${endpoint}?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`);
    console.log(JSON.stringify(await r.json(), null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  const body = { slug, token };

  if (args.public) {
    body.protected = false;
    body.allow = [];
  } else if (args.restricted) {
    // Restricted with no pre-approved emails: people use "Request access".
    body.protected = true;
    body.allow = args.allow
      ? String(args.allow).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  } else if (args.allow) {
    body.allow = String(args.allow).split(',').map((s) => s.trim()).filter(Boolean);
    body.protected = true;
  }

  if (args['html-file']) {
    body.html = fs.readFileSync(args['html-file'], 'utf-8');
  } else if (args.html) {
    body.html = String(args.html);
  }

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  console.log(JSON.stringify(data, null, 2));
  process.exit(r.ok && data.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
