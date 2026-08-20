// Frees Redis memory by moving the bulk payloads it still holds into Blob.
//
// Redis at `maxmemory` with a noeviction policy rejects every command flagged
// denyoom — SET, HSET, SADD, LPUSH, INCR — while reads and DEL keep working.
// That is exactly the shape of the outage this module clears: it only ever
// reads and deletes on the Redis side, so it runs while the store is full.
//
// Three independent passes, each opt-in:
//   html      copy html:<slug>            -> Blob html/<slug>.html, then DEL
//   projfile  copy projfile:<slug>:<path> -> Blob projfile/<slug>/<path>, DEL
//   events    DEL stat:ev:* analytics detail records (no copy — they carry a
//             ~6-month TTL and are derived data, not content)
//
// ORDERING MATTERS. The dual-read code in lib/storage.js and
// lib/project-storage.js must be deployed BEFORE any content pass runs. Until
// it is, readers only consult Redis, and deleting a key there takes the page
// offline. The `events` pass has no such dependency.
//
// Nothing is deleted until its Blob copy has been read back and byte-compared,
// so a failed upload can never cost content.

const DEFAULT_BATCH = 50;

function noopLog() {}

// MEMORY USAGE is the honest per-key number (payload + overhead) but is not on
// every managed Redis; fall back to the value length, which still ranks keys
// correctly even if it understates overhead.
async function keyBytes(client, key) {
  try {
    if (typeof client.memoryUsage === 'function') {
      const bytes = await client.memoryUsage(key);
      if (typeof bytes === 'number' && bytes >= 0) return bytes;
    }
  } catch {}
  try {
    if (typeof client.strLen === 'function') return await client.strLen(key);
  } catch {}
  return 0;
}

async function scanAll(client, match, count = 200) {
  const keys = [];
  for await (const batch of client.scanIterator({ MATCH: match, COUNT: count })) {
    const found = Array.isArray(batch) ? batch : [batch];
    for (const k of found) keys.push(String(k));
  }
  return Array.from(new Set(keys));
}

// Groups every key by the class it belongs to, so a report can say which class
// is actually holding the memory instead of guessing.
function classifyKey(key) {
  const s = String(key);
  if (s.startsWith('projfile:')) return 'projfile';
  if (s.startsWith('stat:ev:')) return 'analytics-events';
  if (s.startsWith('stat:')) return 'analytics-agg';
  if (s.startsWith('session:')) return 'sessions';
  if (s.startsWith('acl:')) return 'acl';
  if (s.startsWith('pagemeta:')) return 'pagemeta';
  if (s.startsWith('project:') || s === 'projects:index' || s.startsWith('projectlog:')) return 'projects';
  if (s.startsWith('mcp:')) return 'mcp-oauth';
  if (s.startsWith('accessreq:') || s.startsWith('oauthstate:')) return 'ephemeral';
  if (s.includes(':')) return s.slice(0, s.indexOf(':'));
  return 'other';
}

// Read-only census: how many keys per class and how many bytes they hold.
async function report(client, { log = noopLog } = {}) {
  const keys = await scanAll(client, '*');
  const classes = {};
  for (const key of keys) {
    const cls = classifyKey(key);
    if (!classes[cls]) classes[cls] = { keys: 0, bytes: 0 };
    classes[cls].keys += 1;
    classes[cls].bytes += await keyBytes(client, key);
  }
  const total = Object.values(classes).reduce((n, c) => n + c.bytes, 0);
  log(`[report] ${keys.length} keys, ${(total / 1048576).toFixed(1)} MB accounted for`);
  return { totalKeys: keys.length, totalBytes: total, classes };
}

// --- Content passes ---------------------------------------------------------

function asBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(String(value), 'utf-8');
}

// Copies one value to Blob, reads it back, and only then deletes the Redis key.
// Returns 'moved', 'verify-failed' or 'missing'.
//
// `sourceBytes` extracts the comparable bytes from whatever readSource returned
// — the project-file pass hands back a { body, contentType } envelope rather
// than a raw value, and stringifying that would compare "[object Object]".
async function moveOne({
  client, key, readSource, writeBlob, readBlob, dryRun, log,
  sourceBytes = asBuffer
}) {
  const value = await readSource();
  if (value == null) return 'missing';

  const bytes = await keyBytes(client, key);
  if (dryRun) {
    log(`[dry-run] would move ${key} (${bytes} bytes)`);
    return 'moved';
  }

  await writeBlob(value);

  // Byte-compare the round-trip. A silent truncation here would otherwise be
  // discovered only after the Redis copy was already gone.
  const expected = sourceBytes(value);
  const actual = asBuffer(await readBlob());
  if (!expected || !actual || !expected.equals(actual)) {
    log(`[skip] ${key} did not verify in Blob — leaving the Redis copy in place`);
    return 'verify-failed';
  }

  await client.del(key);
  return 'moved';
}

async function drainHtml({ client, blob, prefix = 'html', dryRun = true, log = noopLog } = {}) {
  const keys = await scanAll(client, `${prefix}:*`);
  const result = { scanned: keys.length, moved: 0, failed: 0, missing: 0, bytesFreed: 0 };

  for (const key of keys) {
    const slug = key.slice(prefix.length + 1);
    const bytes = await keyBytes(client, key);
    const outcome = await moveOne({
      client,
      key,
      dryRun,
      log,
      readSource: () => client.get(key),
      writeBlob: (value) => blob.saveHtml(prefix, slug, value),
      readBlob: () => blob.readHtml(prefix, slug)
    });
    if (outcome === 'moved') { result.moved += 1; result.bytesFreed += bytes; }
    else if (outcome === 'verify-failed') result.failed += 1;
    else result.missing += 1;
  }

  log(`[html] ${result.moved}/${result.scanned} moved, ${result.failed} failed, ${(result.bytesFreed / 1048576).toFixed(1)} MB freed${dryRun ? ' (dry run)' : ''}`);
  return result;
}

async function drainProjectFiles({ client, blob, dryRun = true, log = noopLog } = {}) {
  const keys = await scanAll(client, 'projfile:*');
  const result = { scanned: keys.length, moved: 0, failed: 0, missing: 0, bytesFreed: 0 };

  for (const key of keys) {
    // projfile:<slug>:<relPath> — relPath itself contains colons only if a
    // Drive filename did, so split on the first two separators only.
    const rest = key.slice('projfile:'.length);
    const sep = rest.indexOf(':');
    if (sep === -1) { result.missing += 1; continue; }
    const slug = rest.slice(0, sep);
    const relPath = rest.slice(sep + 1);
    const bytes = await keyBytes(client, key);

    const outcome = await moveOne({
      client,
      key,
      dryRun,
      log,
      readSource: async () => {
        const raw = await client.get(key);
        if (!raw) return null;
        let record;
        try { record = JSON.parse(raw); } catch { return null; }
        if (!record || typeof record.b64 !== 'string') return null;
        return { body: Buffer.from(record.b64, 'base64'), contentType: record.contentType || '' };
      },
      writeBlob: (v) => blob.saveProjectFile(slug, relPath, v.body, v.contentType),
      readBlob: async () => {
        const got = await blob.readProjectFile(slug, relPath);
        return got ? got.body : null;
      },
      sourceBytes: (v) => v.body
    });

    if (outcome === 'moved') { result.moved += 1; result.bytesFreed += bytes; }
    else if (outcome === 'verify-failed') result.failed += 1;
    else result.missing += 1;
  }

  log(`[projfile] ${result.moved}/${result.scanned} moved, ${result.failed} failed, ${(result.bytesFreed / 1048576).toFixed(1)} MB freed${dryRun ? ' (dry run)' : ''}`);
  return result;
}

// Analytics detail records are derived, TTL'd data — dropped outright rather
// than copied. Aggregate counters (stat:agg, stat:by:*) are left alone: they
// are small and back the /admin dashboard.
async function purgeAnalyticsEvents({ client, dryRun = true, log = noopLog, batchSize = DEFAULT_BATCH } = {}) {
  const keys = await scanAll(client, 'stat:ev:*');
  const result = { scanned: keys.length, deleted: 0, bytesFreed: 0 };

  for (const key of keys) result.bytesFreed += await keyBytes(client, key);

  if (dryRun) {
    log(`[dry-run] would delete ${keys.length} analytics event records (${(result.bytesFreed / 1048576).toFixed(1)} MB)`);
    return result;
  }

  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await client.del(batch);
    result.deleted += batch.length;
  }

  log(`[events] deleted ${result.deleted} records, ${(result.bytesFreed / 1048576).toFixed(1)} MB freed`);
  return result;
}

module.exports = {
  classifyKey,
  scanAll,
  keyBytes,
  report,
  moveOne,
  drainHtml,
  drainProjectFiles,
  purgeAnalyticsEvents
};
