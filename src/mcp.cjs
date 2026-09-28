const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const DEFAULT_ALLOWED_HOSTS = ['asset.stoneking.top', 'localhost', '127.0.0.1', '[::1]'];

function allowedHosts() {
  const configured = process.env.ASSET_TRACKER_MCP_ALLOWED_HOSTS;
  return new Set((configured ? configured.split(',') : DEFAULT_ALLOWED_HOSTS)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean));
}

function hostname(req) {
  try {
    return new URL(`http://${req.get('host')}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function toolError(error) {
  const known = error?.status >= 400 && error?.status < 500;
  if (!known) console.error('[mcp]', error);
  return {
    content: [{ type: 'text', text: known ? error.message : 'Asset service is temporarily unavailable' }],
    isError: true
  };
}

function createServer(agentService, agentKey) {
  const owner = agentKey.ownerUsername;
  const agentKeyId = agentKey.id;
  const server = new McpServer({ name: 'stone-wealth-assets', version: '1.0.0' });

  server.registerTool('list_assets', {
    description: 'List the owner-accessible assets, optionally searching by code, name or account. This does not modify data.',
    inputSchema: z.object({
      q: z.string().trim().max(120).optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional()
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ q, page = 1, pageSize = 25 }) => {
    try {
      let assets = await agentService.listAgentAssets(owner);
      if (q) {
        const query = q.toLocaleLowerCase();
        assets = assets.filter((asset) =>
          `${asset.code ?? ''} ${asset.name ?? ''} ${asset.accountName ?? ''}`.toLocaleLowerCase().includes(query));
      }
      const total = assets.length;
      assets.sort((a, b) => Number(b.marketValueCny || 0) - Number(a.marketValueCny || 0));
      return result({ assets: assets.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('get_asset', {
    description: 'Get one owner-accessible asset by its numeric ID. This does not modify data.',
    inputSchema: z.object({ assetId: z.number().int().positive() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ assetId }) => {
    try {
      return result({ asset: await agentService.getAgentAsset(assetId, owner) });
    } catch (error) {
      return toolError(error);
    }
  });

  const patchSchema = z.object({
    platform_id: z.number().int().positive().optional(),
    asset_type_id: z.number().int().positive().optional(),
    code: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().max(120).optional(),
    shares: z.number().finite().optional(),
    cost_price: z.number().finite().nonnegative().nullable().optional(),
    currency_id: z.number().int().positive().optional(),
    quote_code: z.string().trim().max(40).nullable().optional(),
    quantity_status: z.enum(['missing', 'estimated', 'verified']).optional(),
    valuation_mode: z.enum(['units', 'position_value']).optional(),
    imported_market_value: z.number().finite().nonnegative().nullable().optional(),
    imported_cost_value: z.number().finite().nonnegative().nullable().optional(),
    valuation_as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
  }).strict().refine((patch) => Object.keys(patch).length > 0, 'At least one field is required');

  server.registerTool('propose_asset_change', {
    description: 'Submit an asset edit proposal for review in the website. This never changes the asset; the owner must approve it separately in the website.',
    inputSchema: z.object({
      assetId: z.number().int().positive(),
      patch: patchSchema,
      idempotencyKey: z.string().trim().min(8).max(120).describe('Caller-generated stable ID for one logical proposal, for example a UUID. Reuse the same ID only on retries of that proposal.')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ assetId, patch, idempotencyKey }) => {
    try {
      const proposal = await agentService.proposeAssetPatch({ assetId, patch, owner, agentKeyId, idempotencyKey });
      return result({ proposal, assetChanged: false, requiresWebsiteApproval: true });
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

function createMcpRouter(agentService) {
  const router = express.Router();
  const hosts = allowedHosts();

  router.use((req, res, next) => {
    // Browser origins and unrecognised hosts cannot call this server-to-server endpoint.
    if (!hosts.has(hostname(req)) || req.get('origin')) {
      return res.status(403).json({ error: 'MCP origin or host is not allowed' });
    }
    const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '');
    let key = null;
    try {
      if (match) key = agentService.verifyAgentToken(match[1]);
    } catch (error) {
      console.error('[mcp] token verification', error);
      return res.status(503).json({ error: 'Agent authentication is temporarily unavailable' });
    }
    if (!key?.ownerUsername || !Number.isSafeInteger(key.id) || key.id <= 0) {
      res.set('WWW-Authenticate', 'Bearer realm="stone-wealth-mcp"');
      return res.status(401).json({ error: 'Invalid or expired agent token' });
    }
    req.agentKey = key;
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/', async (req, res) => {
    const server = createServer(agentService, req.agentKey);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] transport', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    } finally {
      await server.close();
    }
  });

  router.all('/', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' }));
  router.use((_req, res) => res.status(404).json({ error: 'MCP endpoint not found' }));
  return router;
}

module.exports = { createMcpRouter };
