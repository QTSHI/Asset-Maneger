// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const express = require('express');
const { createMcpRouter } = require('../src/mcp.cjs');

let server: any;
let baseUrl: string;
let tokenActive = true;
let proposalCalls = 0;
const assets = [
  { id: 1, code: 'CASH-CNY', name: '现金', accountName: '主账户', marketValueCny: 100 },
  { id: 2, code: 'ETF-001', name: '基金', accountName: '投资账户', marketValueCny: 200 }
];

const service = {
  verifyAgentToken(raw: string) {
    return raw === 'agent-key' && tokenActive ? { id: 42, ownerUsername: 'asset-owner' } : null;
  },
  listAgentAssets(owner: string) {
    if (owner !== 'asset-owner') throw new Error('wrong owner');
    return assets;
  },
  getAgentAsset(id: number, owner: string) {
    if (owner !== 'asset-owner') throw new Error('wrong owner');
    const asset = assets.find((item) => item.id === id);
    if (!asset) throw Object.assign(new Error('Asset not found'), { status: 404 });
    return asset;
  },
  proposeAssetPatch({ assetId, patch, owner, agentKeyId, idempotencyKey }: any) {
    if (owner !== 'asset-owner') throw new Error('wrong owner');
    if (agentKeyId !== 42) throw new Error('wrong agent key');
    proposalCalls++;
    return { id: 'proposal-1', assetId, patch, owner, agentKeyId, idempotencyKey, status: 'pending' };
  }
};

async function client() {
  const instance = new Client({ name: 'mcp-test', version: '1.0.0' });
  await instance.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer agent-key' } }
  }));
  return instance;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(service));
  server = await new Promise<any>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('agent MCP access', () => {
  it('rejects missing, malformed and untrusted bearer credentials before tool discovery', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    for (const authorization of [undefined, 'Bearer bad-key', 'Basic agent-key']) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(authorization ? { Authorization: authorization } : {})
        },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('list_assets');
    }
  });

  it('exposes only reads and pending change proposals through the official MCP client', async () => {
    const mcp = await client();
    try {
      const discovered = await mcp.listTools();
      expect(discovered.tools.map((tool) => tool.name)).toEqual([
        'list_assets', 'get_asset', 'propose_asset_change'
      ]);

      const listed: any = await mcp.callTool({ name: 'list_assets', arguments: { q: '基金', pageSize: 1 } });
      expect(listed.structuredContent).toMatchObject({ total: 1, assets: [{ id: 2 }] });

      const found: any = await mcp.callTool({ name: 'get_asset', arguments: { assetId: 1 } });
      expect(found.structuredContent).toMatchObject({ asset: { id: 1 } });

      const proposed: any = await mcp.callTool({ name: 'propose_asset_change', arguments: {
        assetId: 1, patch: { shares: 120 }, idempotencyKey: 'change-12345678'
      } });
      expect(proposed.structuredContent).toMatchObject({
        proposal: { status: 'pending', owner: 'asset-owner', agentKeyId: 42, patch: { shares: 120 } },
        assetChanged: false,
        requiresWebsiteApproval: true
      });
      expect(assets[0].marketValueCny).toBe(100);
      expect(proposalCalls).toBe(1);

      const invalid: any = await mcp.callTool({ name: 'propose_asset_change', arguments: {
        assetId: 1, patch: { unknown_column: 10 }, idempotencyKey: 'change-12345679'
      } });
      expect(invalid.isError).toBe(true);
      expect(proposalCalls).toBe(1);
    } finally {
      await mcp.close();
    }
  });

  it('rechecks revocation on each request', async () => {
    const mcp = await client();
    try {
      expect((await mcp.listTools()).tools).toHaveLength(3);
      tokenActive = false;
      await expect(mcp.listTools()).rejects.toThrow();
    } finally {
      tokenActive = true;
      await mcp.close();
    }
  });

  it('rejects browser origins and unknown hosts', async () => {
    const originResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Authorization: 'Bearer agent-key' }
    });
    expect(originResponse.status).toBe(403);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { Host: 'evil.example', Authorization: 'Bearer agent-key' }
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
