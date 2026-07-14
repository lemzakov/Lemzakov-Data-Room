#!/usr/bin/env node
// Lemzakov Data Room — MCP server (stdio)
//
// Upload/publish HTML pages to the Data Room WITHOUT Google Drive. This is the
// "direct upload" alternative to the Drive-sync flow: it pushes HTML straight
// into the site's store and sets per-page access, by calling the existing
// admin API (POST/GET /api/admin/page and GET /api/admin/pages).
//
// It speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC
// 2.0), so any MCP client (Claude Code / Claude Desktop / the publish-page
// skill) can drive it. Zero runtime dependencies — uses only Node built-ins.
//
// Configuration (environment):
//   LDR_BASE_URL    — deployed site, e.g. https://data-room.example.com
//   LDR_ADMIN_TOKEN — ADMIN_TOKEN (or SYNC_SECRET) configured in Vercel
//
// Tools exposed:
//   publish_page      — publish/replace a page's HTML and/or set its access
//   set_page_access   — set a page public or restricted (+ allow list)
//   get_page          — read a page's current access record
//   list_pages        — list every stored page and its access state
//
// Run directly for stdio:  node mcp/data-room-mcp.js
// The handler/tool logic is exported for unit testing.

const fs = require('fs');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'lemzakov-data-room', version: '1.0.0' };

// ---------------------------------------------------------------------------
// Config & HTTP helpers
// ---------------------------------------------------------------------------

function resolveConfig(env = process.env) {
  const baseUrl = String(env.LDR_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.LDR_ADMIN_TOKEN || '').trim();
  return { baseUrl, token };
}

function requireConfig(env) {
  const { baseUrl, token } = resolveConfig(env);
  if (!baseUrl || !token) {
    throw new Error(
      'Missing config: set LDR_BASE_URL and LDR_ADMIN_TOKEN in the MCP server environment.'
    );
  }
  return { baseUrl, token };
}

// Posts to the admin API. `deps.fetch` is injectable for tests.
async function apiPost(path, body, deps) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const { baseUrl, token } = requireConfig(deps.env);
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request to ${path} failed (HTTP ${res.status}).`);
  }
  return data;
}

async function apiGet(path, deps) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const { baseUrl, token } = requireConfig(deps.env);
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { 'X-Admin-Token': token }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request to ${path} failed (HTTP ${res.status}).`);
  }
  return data;
}

// Resolves the HTML payload from either inline `html` or a local `htmlFile`.
function resolveHtml(args, deps) {
  if (typeof args.html === 'string' && args.html.length) return args.html;
  if (typeof args.htmlFile === 'string' && args.htmlFile.length) {
    const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf-8'));
    return readFile(args.htmlFile);
  }
  return undefined;
}

function normalizeAccess(args) {
  const allow = Array.isArray(args.allow)
    ? args.allow.map((s) => String(s).trim()).filter(Boolean)
    : [];
  let isProtected;
  if (args.access === 'public') isProtected = false;
  else if (args.access === 'restricted') isProtected = true;
  else if (typeof args.protected === 'boolean') isProtected = args.protected;
  else if (allow.length) isProtected = true;
  return { isProtected, allow };
}

// ---------------------------------------------------------------------------
// Tool definitions & implementations
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'publish_page',
    description:
      "Publish or replace a Data Room page's HTML directly (no Google Drive) and " +
      'optionally set its access. Served at /<slug>. Provide HTML inline via `html` ' +
      'or from a local path via `htmlFile`.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page name without .html; served at /<slug>.' },
        html: { type: 'string', description: 'Full HTML document to publish.' },
        htmlFile: { type: 'string', description: 'Local path to an .html file to publish.' },
        access: {
          type: 'string',
          enum: ['public', 'restricted'],
          description: 'public = anyone with the link; restricted = Google sign-in + allow list.'
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
      required: ['slug']
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

const TOOL_IMPLS = {
  async publish_page(args, deps) {
    if (!args.slug) throw new Error('slug is required.');
    const html = resolveHtml(args, deps);
    const { isProtected, allow } = normalizeAccess(args);
    const body = { slug: args.slug };
    if (html !== undefined) body.html = html;
    if (isProtected !== undefined) {
      body.protected = isProtected;
      body.allow = allow;
    }
    if (typeof args.category === 'string') body.category = args.category;
    return apiPost('/api/admin/page', body, deps);
  },

  async set_page_access(args, deps) {
    if (!args.slug) throw new Error('slug is required.');
    if (args.access !== 'public' && args.access !== 'restricted') {
      throw new Error("access must be 'public' or 'restricted'.");
    }
    const { isProtected, allow } = normalizeAccess(args);
    return apiPost('/api/admin/page', { slug: args.slug, protected: isProtected, allow }, deps);
  },

  async get_page(args, deps) {
    if (!args.slug) throw new Error('slug is required.');
    return apiGet(`/api/admin/page?slug=${encodeURIComponent(args.slug)}`, deps);
  },

  async list_pages(_args, deps) {
    return apiGet('/api/admin/pages', deps);
  }
};

// Runs a named tool and shapes the MCP tools/call result.
async function callTool(name, args = {}, deps = {}) {
  const impl = TOOL_IMPLS[name];
  if (!impl) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }]
    };
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

// ---------------------------------------------------------------------------
// JSON-RPC message handling
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Handles one JSON-RPC message. Returns a response object, or null for
// notifications (which get no reply).
async function handleMessage(msg, deps = {}) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });

    case 'notifications/initialized':
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

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function startStdioServer(deps = {}) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send(rpcError(null, -32700, 'Parse error'));
      return;
    }
    try {
      const response = await handleMessage(msg, deps);
      if (response) send(response);
    } catch (error) {
      send(rpcError(msg && msg.id != null ? msg.id : null, -32603, error.message || 'Internal error'));
    }
  });
}

if (require.main === module) {
  startStdioServer();
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS,
  callTool,
  handleMessage,
  resolveConfig,
  normalizeAccess,
  startStdioServer
};
