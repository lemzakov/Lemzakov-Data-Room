// Lemzakov Data Room — in-process MCP core (for the REMOTE/HTTP server).
//
// The stdio server in `mcp/data-room-mcp.js` drives the same tools by calling
// the admin HTTP API. This module is the counterpart used by the remote
// Streamable-HTTP endpoint (`api/mcp/index.js`): it implements the tools
// IN PROCESS, calling the storage/access layer directly — no self-HTTP round
// trip, no admin token shuffling. Authorization for the remote server is
// enforced at the transport layer (OAuth bearer token), so the tools here trust
// that they only run for an authenticated caller.
//
// It exposes a JSON-RPC dispatcher (`handleMcpMessage`) compatible with the MCP
// Streamable HTTP transport: one request object in, one response object out
// (or null for notifications).

const { getRuntimeConfig, pageUrls } = require('./config');
const { saveHtml, listSlugs } = require('./storage');
const { getAcl, setAcl, normalizeSlug } = require('./access');
const { getCategory, setPageCategory } = require('./page-meta');
const telegram = require('./telegram');

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
// Protocol versions we know how to speak; we echo back the client's requested
// version when it's one of these, otherwise fall back to our default.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
]);
const SERVER_INFO = { name: 'lemzakov-data-room', version: '1.0.0' };

const INSTRUCTIONS =
  'Publish HTML pages to the Lemzakov Data Room. Use `publish_page` to push a ' +
  'full HTML document (inline) to a slug; it is served at /<slug>. Set ' +
  '`access` to "public" (anyone with the link) or "restricted" (Google ' +
  'sign-in + allow list). Use `set_page_access` to change access without ' +
  'replacing HTML, `get_page` to read a page\'s access, and `list_pages` to ' +
  'list everything.';

// Remote tools: HTML must be provided inline (the server has no access to the
// caller's local filesystem, so there is no `htmlFile` here).
const TOOLS = [
  {
    name: 'publish_page',
    description:
      "Publish or replace a Data Room page's HTML (provided inline) and " +
      'optionally set its access. Served at /<slug>.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Page name without .html; served at /<slug>.'
        },
        html: { type: 'string', description: 'Full HTML document to publish.' },
        access: {
          type: 'string',
          enum: ['public', 'restricted'],
          description:
            'public = anyone with the link; restricted = Google sign-in + allow list.'
        },
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Emails pre-approved for a restricted page.'
        },
        category: {
          type: 'string',
          description: 'Optional category label used to organize pages in /admin and the Telegram bot.'
        }
      },
      required: ['slug', 'html']
    }
  },
  {
    name: 'set_page_access',
    description:
      'Set an existing page public or restricted, and update its pre-approved ' +
      'allow list. Does not change the page HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        access: { type: 'string', enum: ['public', 'restricted'] },
        allow: { type: 'array', items: { type: 'string' } }
      },
      required: ['slug', 'access']
    }
  },
  {
    name: 'get_page',
    description: "Read a page's current access record (protected flag + allow list).",
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug']
    }
  },
  {
    name: 'list_pages',
    description: 'List every stored page and its access state.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// Maps the tool's `access`/`allow` args to an ACL record shape, mirroring
// api/admin/page.js so the remote and admin flows behave identically.
function resolveAccess(args) {
  const allow = Array.isArray(args.allow) ? args.allow : [];
  let isProtected;
  if (args.access === 'public') isProtected = false;
  else if (args.access === 'restricted') isProtected = true;
  else if (typeof args.protected === 'boolean') isProtected = args.protected;
  return { isProtected, allow };
}

const TOOL_IMPLS = {
  async publish_page(args, deps = {}) {
    const slug = normalizeSlug(args.slug || '');
    if (!slug) throw new Error('slug is required.');
    if (typeof args.html !== 'string' || !args.html.length) {
      throw new Error('html is required (the full HTML document to publish).');
    }

    const { storagePrefix } = (deps.getRuntimeConfig || getRuntimeConfig)();
    await (deps.saveHtml || saveHtml)(storagePrefix, slug, args.html);

    let category;
    if (args.category !== undefined) {
      const rec = await (deps.setPageCategory || setPageCategory)(slug, args.category);
      category = rec.category;
    } else {
      category = await (deps.getCategory || getCategory)(slug);
    }

    const { isProtected, allow } = resolveAccess(args);
    // Default to public when access is unspecified, but never silently demote a
    // page that the caller is making restricted via `allow`.
    const wantsProtected = isProtected === undefined ? allow.length > 0 : isProtected;
    const record = await (deps.setAcl || setAcl)(slug, { protected: wantsProtected, allow });

    // Best-effort publish notification to the owner's Telegram (no-op when
    // unconfigured; never throws).
    await (deps.notifyPagePublished || telegram.notifyPagePublished)({
      slug,
      urls: (deps.pageUrls || pageUrls)(slug),
      protected: record.protected,
      category
    });

    return {
      ok: true,
      slug,
      published: true,
      protected: record.protected,
      allow: record.allow,
      category,
      note: record.protected
        ? 'Restricted: visitors sign in with Google; approved emails get in, others Request access (you approve in Telegram).'
        : 'Page is public.'
    };
  },

  async set_page_access(args, deps = {}) {
    const slug = normalizeSlug(args.slug || '');
    if (!slug) throw new Error('slug is required.');
    if (args.access !== 'public' && args.access !== 'restricted') {
      throw new Error("access must be 'public' or 'restricted'.");
    }
    const allow = Array.isArray(args.allow) ? args.allow : [];
    const record = await (deps.setAcl || setAcl)(slug, {
      protected: args.access === 'restricted',
      allow
    });
    return { ok: true, slug, protected: record.protected, allow: record.allow };
  },

  async get_page(args, deps = {}) {
    const slug = normalizeSlug(args.slug || '');
    if (!slug) throw new Error('slug is required.');
    const acl = await (deps.getAcl || getAcl)(slug);
    return {
      ok: true,
      slug,
      protected: Boolean(acl && acl.protected),
      allow: (acl && acl.allow) || []
    };
  },

  async list_pages(_args, deps = {}) {
    const { storagePrefix } = (deps.getRuntimeConfig || getRuntimeConfig)();
    const slugs = await (deps.listSlugs || listSlugs)(storagePrefix);
    const getAclImpl = deps.getAcl || getAcl;
    const getCategoryImpl = deps.getCategory || getCategory;
    const pages = await Promise.all(
      slugs.map(async (slug) => {
        const [acl, category] = await Promise.all([getAclImpl(slug), getCategoryImpl(slug)]);
        return {
          slug,
          protected: Boolean(acl && acl.protected),
          allow: (acl && acl.allow) || [],
          category: category || ''
        };
      })
    );
    return { ok: true, pages };
  }
};

// Runs a named tool and shapes the MCP tools/call result.
async function callTool(name, args = {}, deps = {}) {
  const impl = TOOL_IMPLS[name];
  if (!impl) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  try {
    const result = await impl(args, deps);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${error.message || String(error)}` }]
    };
  }
}

// --- JSON-RPC dispatch (Streamable HTTP transport) -------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function negotiateProtocol(requested) {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

// Handles one JSON-RPC message. Returns a response object, or null for
// notifications (which get no reply). `deps` is injectable for tests.
async function handleMcpMessage(msg, deps = {}) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateProtocol(params && params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const result = await callTool(name, args, deps);
      return rpcResult(id, result);
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

module.exports = {
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INFO,
  INSTRUCTIONS,
  TOOLS,
  resolveAccess,
  callTool,
  negotiateProtocol,
  handleMcpMessage
};
