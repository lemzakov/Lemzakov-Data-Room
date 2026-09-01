#!/usr/bin/env node
// Attach images to a Lemzakov Data Room page (and list / remove them).
//
// A published page is one HTML document, so images used to have to be inlined
// as data: URIs. Upload them instead: each image gets a stable path under the
// page's own URL (/<slug>/<name>) that the HTML references with a normal
// <img src="…">, and the image is served under the page's own access — restrict
// the page and its images are restricted with it.
//
// Calls the admin API (/api/admin/asset) with the admin token. Files are sent
// as raw bytes, not base64, so the 4 MB per-image limit is 4 MB of actual image.
//
// Config (env or flags):
//   LDR_BASE_URL / --base-url   e.g. https://data-room.example.com
//   LDR_ADMIN_TOKEN / --token   ADMIN_TOKEN (or SYNC_SECRET) set in Vercel
//
// Examples:
//   node upload-image.js --slug investor-deck --file ./chart.png
//   node upload-image.js --slug investor-deck --file ./chart.png --name hero.png
//   node upload-image.js --slug investor-deck --file ./a.png --file ./b.jpg
//   node upload-image.js --slug investor-deck --list
//   node upload-image.js --slug investor-deck --delete hero.png

const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp'
};

// Collects repeated flags into an array so several --file values work.
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : next;
    if (value !== true) i++;
    if (args[key] === undefined) args[key] = value;
    else if (Array.isArray(args[key])) args[key].push(value);
    else args[key] = [args[key], value];
  }
  return args;
}

function asList(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
  }
  return data;
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
  if (!slug || slug === true) {
    console.error('Missing --slug.');
    process.exit(2);
  }

  const endpoint = `${baseUrl}/api/admin/asset`;
  const auth = { 'X-Admin-Token': token };

  if (args.list) {
    const res = await fetch(`${endpoint}?slug=${encodeURIComponent(slug)}`, { headers: auth });
    console.log(JSON.stringify(await readJson(res), null, 2));
    return;
  }

  if (args.delete && args.delete !== true) {
    const res = await fetch(
      `${endpoint}?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(args.delete)}`,
      { method: 'DELETE', headers: auth }
    );
    console.log(JSON.stringify(await readJson(res), null, 2));
    return;
  }

  const files = asList(args.file);
  if (!files.length) {
    console.error('Nothing to do: pass --file <path> (repeatable), --list, or --delete <name>.');
    process.exit(2);
  }
  // --name renames a single upload; with several files each keeps its own name.
  const names = asList(args.name);
  if (names.length && names.length !== files.length) {
    console.error('--name must be given once per --file, or not at all.');
    process.exit(2);
  }

  const results = [];
  for (const [index, file] of files.entries()) {
    const body = fs.readFileSync(file);
    const name = names[index] || path.basename(file);
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const res = await fetch(
      `${endpoint}?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: Object.assign({ 'Content-Type': contentType }, auth), body }
    );
    const data = await readJson(res);
    results.push(data);
    console.error(`uploaded ${file} -> ${data.path}`);
  }
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
