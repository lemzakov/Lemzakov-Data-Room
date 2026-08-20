const test = require('node:test');
const assert = require('node:assert');

const { resolveAccessForPublish } = require('../lib/access');
const core = require('../lib/mcp-core');

function withExisting(acl) {
  return { blob: { blobEnabled: () => false }, kvGetJson: async () => acl };
}

// The regression: publishing new HTML with no access argument used to reset the
// page to public, because an absent allow list read as "allow nobody".
test('publishing without access arguments preserves an existing restriction', async () => {
  const wanted = await resolveAccessForPublish(
    'memo',
    { isProtected: undefined, allow: [], allowProvided: false },
    withExisting({ protected: true, allow: ['a@x.com', 'b@y.com'] })
  );
  assert.equal(wanted.protected, true);
  assert.deepEqual(wanted.allow, ['a@x.com', 'b@y.com']);
});

test('a brand-new page with no access arguments is public', async () => {
  const wanted = await resolveAccessForPublish(
    'brand-new',
    { isProtected: undefined, allow: [], allowProvided: false },
    withExisting(null)
  );
  assert.equal(wanted.protected, false);
  assert.deepEqual(wanted.allow, []);
});

test('an already-public page stays public', async () => {
  const wanted = await resolveAccessForPublish(
    'memo',
    { isProtected: undefined, allow: [], allowProvided: false },
    withExisting({ protected: false, allow: [] })
  );
  assert.equal(wanted.protected, false);
});

test('an explicit request to go public still demotes', async () => {
  const wanted = await resolveAccessForPublish(
    'memo',
    { isProtected: false, allow: [], allowProvided: false },
    withExisting({ protected: true, allow: ['a@x.com'] })
  );
  assert.equal(wanted.protected, false, 'explicit intent must still win');
  assert.deepEqual(wanted.allow, []);
});

test('an explicit allow list replaces the existing one', async () => {
  const wanted = await resolveAccessForPublish(
    'memo',
    { isProtected: undefined, allow: ['new@x.com'], allowProvided: true },
    withExisting({ protected: true, allow: ['old@x.com'] })
  );
  assert.equal(wanted.protected, true);
  assert.deepEqual(wanted.allow, ['new@x.com']);
});

test('an explicitly empty allow list opens the page (caller said so)', async () => {
  const wanted = await resolveAccessForPublish(
    'memo',
    { isProtected: undefined, allow: [], allowProvided: true },
    withExisting({ protected: true, allow: ['a@x.com'] })
  );
  assert.equal(wanted.protected, false);
});

// End-to-end through the MCP tool that actually demoted the page in production.
test('publish_page no longer demotes a restricted page it is re-publishing', async () => {
  const written = [];
  const res = await core.callTool('publish_page', { slug: 'memo', html: '<p>v2</p>' }, {
    getRuntimeConfig: () => ({ storagePrefix: 'html' }),
    saveHtml: async () => {},
    getCategory: async () => '',
    getAcl: async () => ({ protected: true, allow: ['a@x.com'] }),
    resolveAccessForPublish: async (slug, opts) =>
      resolveAccessForPublish(slug, opts, withExisting({ protected: true, allow: ['a@x.com'] })),
    setAcl: async (slug, rec) => { written.push(rec); return rec; },
    notifyPagePublished: async () => {},
    pageUrls: () => []
  });

  assert.ok(!res.isError, `publish_page errored: ${res.content && res.content[0] && res.content[0].text}`);
  assert.deepEqual(written, [{ protected: true, allow: ['a@x.com'] }]);

  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.protected, true, 'the republished page must still be restricted');
  assert.deepEqual(payload.allow, ['a@x.com']);
});
