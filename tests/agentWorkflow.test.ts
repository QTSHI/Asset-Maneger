import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-agent-test-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(temporaryDirectory, 'database.sqlite');
process.env.NODE_ENV = 'test';

let db: any;
let agent: any;
let server: any;
let baseUrl: string;
let cashType: number;
let cny: number;
let account: number;

function insertAsset(code: string, extra: Record<string, unknown> = {}) {
  const inserted = db.prepare(`
    INSERT INTO assets (platform_id, asset_type_id, code, name, shares, cost_price,
      currency_id, cash_confirmed_at, external_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(account, cashType, code, code, 100, 1, cny,
    extra.cash_confirmed_at ?? '2026-09-01', extra.external_source ?? null);
  return Number(inserted.lastInsertRowid);
}

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  agent = require('../src/services/agentService.cjs');
  cashType = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
  cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
  account = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Agent Test Account', 'bank')").run().lastInsertRowid);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers['x-test-sso-user']) req.user = { username: req.headers['x-test-sso-user'] };
    next();
  });
  app.use('/api/v2', require('../src/routes/v2.cjs'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v2`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(resolve));
  db?.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Agent asset approval', () => {
  it('stores only hashed, expiring keys and revokes them by SSO owner', () => {
    const key = agent.createAgentKey('alice', 'Personal Agent', 7);
    expect(key.token).toMatch(/^swag_[A-Za-z0-9_-]{43}$/);
    expect(agent.verifyAgentToken(key.token)).toMatchObject({ ownerUsername: 'alice' });
    const row = db.prepare('SELECT * FROM agent_api_keys WHERE id = ?').get(key.id);
    expect(row.token_hash).not.toContain(key.token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(agent.listAgentKeys('alice')[0]).not.toHaveProperty('token');
    expect(agent.listAgentKeys('bob')).toEqual([]);
    expect(() => agent.revokeAgentKey(key.id, 'bob')).toThrow();
    agent.revokeAgentKey(key.id, 'alice');
    expect(agent.verifyAgentToken(key.token)).toBeNull();

    const expired = agent.createAgentKey('alice', 'Expired', 1);
    db.prepare('UPDATE agent_api_keys SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', expired.id);
    expect(agent.verifyAgentToken(expired.token)).toBeNull();
  });

  it('attributes proposals to an Agent key even after that key is revoked', () => {
    const columns = db.prepare('PRAGMA table_info(agent_asset_proposals)').all().map((row: any) => row.name);
    expect(columns).toContain('agent_key_id');
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = '008_agent_proposal_key_attribution'").get()).toBeTruthy();

    const id = insertAsset('ATTRIBUTED-CASH');
    const key = agent.createAgentKey('alice', 'Household Helper');
    const proposal = agent.proposeAssetPatch({
      assetId: id, patch: { shares: 115 }, owner: 'alice', agentKeyId: key.id, idempotencyKey: 'attributed-change'
    });
    expect(proposal).toMatchObject({ agentKeyId: key.id, agentLabel: 'Household Helper', status: 'pending' });
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(id).shares).toBe(100);
    expect(() => agent.proposeAssetPatch({ assetId: id, patch: { shares: 120 }, owner: 'bob', agentKeyId: key.id }))
      .toThrow(/不属于当前用户/);
    agent.revokeAgentKey(key.id, 'alice');
    expect(agent.listProposals('alice', 'pending').items.find((row: any) => row.id === proposal.id))
      .toMatchObject({ agentKeyId: key.id, agentLabel: 'Household Helper' });
    expect(() => agent.proposeAssetPatch({ assetId: id, patch: { shares: 120 }, owner: 'alice', agentKeyId: key.id }))
      .toThrow(/已失效/);
    expect(agent.approveProposal(proposal.id, 'alice')).toMatchObject({ status: 'approved', agentLabel: 'Household Helper' });
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(id).shares).toBe(115);
  });

  it('lets Agent read and propose, then changes an asset only after its SSO owner approves', () => {
    const id = insertAsset('AGENT-CASH');
    expect(agent.listAgentAssets('alice').some((asset: any) => asset.id === id)).toBe(true);
    expect(agent.getAgentAsset(id, 'alice').shares).toBe(100);
    const proposal = agent.proposeAssetPatch({ assetId: id, patch: { shares: 125, name: 'Updated Cash', code: 'AGENT-CASH' }, owner: 'alice', idempotencyKey: 'edit-1' });
    expect(proposal).toMatchObject({ assetId: id, status: 'pending', changes: [
      { field: 'name', before: 'AGENT-CASH', after: 'Updated Cash' },
      { field: 'shares', before: 100, after: 125 }
    ] });
    expect(db.prepare('SELECT shares, name FROM assets WHERE id = ?').get(id)).toMatchObject({ shares: 100, name: 'AGENT-CASH' });
    expect(agent.proposeAssetPatch({ assetId: id, patch: { name: 'Updated Cash', code: 'AGENT-CASH', shares: 125 }, owner: 'alice', idempotencyKey: 'edit-1' }).id).toBe(proposal.id);
    try {
      agent.proposeAssetPatch({ assetId: id, patch: { shares: 130 }, owner: 'alice', idempotencyKey: 'edit-1' });
      throw new Error('expected idempotency conflict');
    } catch (error: any) {
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
    try {
      agent.approveProposal(proposal.id, 'bob');
      throw new Error('expected owner rejection');
    } catch (error: any) {
      expect(error.status).toBe(404);
    }
    const approved = agent.approveProposal(proposal.id, 'alice');
    expect(approved.status).toBe('approved');
    expect(db.prepare('SELECT shares, name, cash_confirmed_at, updated_by FROM assets WHERE id = ?').get(id))
      .toMatchObject({ shares: 125, name: 'Updated Cash', cash_confirmed_at: null, updated_by: 'alice' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'agent_proposal_approved' AND entity_id = ?").get(id).count).toBe(1);
    expect(() => agent.approveProposal(proposal.id, 'alice')).toThrow();
  });

  it('rejects proposals and prevents stale approvals from overwriting later edits', () => {
    const id = insertAsset('STALE-CASH');
    const rejected = agent.proposeAssetPatch({ assetId: id, patch: { shares: 110 }, owner: 'alice' });
    expect(agent.rejectProposal(rejected.id, 'alice').status).toBe('rejected');
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(id).shares).toBe(100);

    const pending = agent.proposeAssetPatch({ assetId: id, patch: { shares: 130 }, owner: 'alice' });
    db.prepare('UPDATE assets SET shares = 120, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    try {
      agent.approveProposal(pending.id, 'alice');
      throw new Error('expected stale rejection');
    } catch (error: any) {
      expect(error.status).toBe(409);
      expect(error.code).toBe('STALE_PROPOSAL');
    }
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(id).shares).toBe(120);
    expect(agent.listProposals('alice', 'conflicted').items.find((row: any) => row.id === pending.id)).toBeTruthy();

    const newAccount = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Temporary Agent Account', 'bank')").run().lastInsertRowid);
    const moved = agent.proposeAssetPatch({ assetId: id, patch: { platform_id: newAccount }, owner: 'alice' });
    db.prepare('UPDATE platforms SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(newAccount);
    try {
      agent.approveProposal(moved.id, 'alice');
      throw new Error('expected account conflict');
    } catch (error: any) {
      expect(error.code).toBe('STALE_PROPOSAL');
    }
    expect(agent.listProposals('alice', 'conflicted').items.find((row: any) => row.id === moved.id)).toBeTruthy();
    const page = agent.listProposals('alice', undefined, { page: 1, pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
  });

  it('rejects archived, sync-managed, invalid, and no-op edits', () => {
    const synced = insertAsset('SYNC-CASH', { external_source: 'trading212' });
    expect(() => agent.proposeAssetPatch({ assetId: synced, patch: { shares: 1 }, owner: 'alice' }))
      .toThrow(/外部数据源/);
    const archived = insertAsset('ARCHIVED-CASH');
    db.prepare('UPDATE assets SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(archived);
    expect(() => agent.proposeAssetPatch({ assetId: archived, patch: { shares: 1 }, owner: 'alice' }))
      .toThrow(/不存在/);
    const id = insertAsset('VALIDATE-CASH');
    expect(() => agent.proposeAssetPatch({ assetId: id, patch: { archived_at: null }, owner: 'alice' }))
      .toThrow(/无效/);
    expect(() => agent.proposeAssetPatch({ assetId: id, patch: { shares: 100 }, owner: 'alice' }))
      .toThrow(/一致/);
    expect(() => agent.proposeAssetPatch({ assetId: id, patch: { platform_id: 999999 }, owner: 'alice' }))
      .toThrow(/账户不存在/);
  });

  it('bounds pending proposals so a looping Agent cannot flood review', () => {
    const id = insertAsset('CAP-CASH');
    const before = JSON.stringify(db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
    const insert = db.prepare(`
      INSERT INTO agent_asset_proposals
        (owner_username, asset_id, status, before_json, patch_json, idempotency_key, created_at)
      VALUES ('cap-user', ?, 'pending', ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run(id, before, JSON.stringify({ shares: index + 200 }), `cap-${index}`, new Date().toISOString());
      }
    })();
    try {
      agent.proposeAssetPatch({ assetId: id, patch: { shares: 999 }, owner: 'cap-user' });
      throw new Error('expected pending limit');
    } catch (error: any) {
      expect(error.status).toBe(429);
      expect(error.code).toBe('TOO_MANY_PENDING');
    }
    expect(agent.listProposals('cap-user').items).toHaveLength(25);
    expect(agent.listProposals('cap-user').total).toBe(100);
  });

  it('keeps SSO browser approval separate from an Agent key', async () => {
    const id = insertAsset('ROUTE-CASH');
    const key = agent.createAgentKey('alice', 'Route Agent');
    const proposal = agent.proposeAssetPatch({ assetId: id, patch: { shares: 140 }, owner: 'alice' });
    const bearerOnly = await fetch(`${baseUrl}/agent/proposals/${proposal.id}/approve`, {
      method: 'POST', headers: { 'x-auth-token': key.token, origin: baseUrl.replace('/api/v2', '') }
    });
    expect(bearerOnly.status).toBe(401);
    const noOrigin = await fetch(`${baseUrl}/agent/proposals/${proposal.id}/approve`, {
      method: 'POST', headers: { 'x-test-sso-user': 'alice' }
    });
    expect(noOrigin.status).toBe(403);
    const crossOrigin = await fetch(`${baseUrl}/agent/proposals/${proposal.id}/approve`, {
      method: 'POST', headers: { 'x-test-sso-user': 'alice', origin: 'https://attacker.example' }
    });
    expect(crossOrigin.status).toBe(403);
    const approved = await fetch(`${baseUrl}/agent/proposals/${proposal.id}/approve`, {
      method: 'POST', headers: { 'x-test-sso-user': 'alice', origin: baseUrl.replace('/api/v2', '') }
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()).data.status).toBe('approved');
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(id).shares).toBe(140);

    const origin = baseUrl.replace('/api/v2', '');
    const created = await fetch(`${baseUrl}/agent/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sso-user': 'alice', origin },
      body: JSON.stringify({ label: 'Browser Key', expiresInDays: 30 })
    });
    expect(created.status).toBe(201);
    const createdKey = (await created.json()).data;
    expect(agent.verifyAgentToken(createdKey.token)).toMatchObject({ ownerUsername: 'alice' });
    const proxied = await fetch(`${baseUrl}/agent/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sso-user': 'alice', origin: 'https://asset.stoneking.top' },
      body: JSON.stringify({ label: 'Proxy Origin' })
    });
    expect(proxied.status).toBe(201);
    const listed = await fetch(`${baseUrl}/agent/keys`, { headers: { 'x-test-sso-user': 'alice' } });
    expect(listed.status).toBe(200);
    const listData = (await listed.json()).data;
    expect(listData.find((row: any) => row.id === createdKey.id)).not.toHaveProperty('token');
    const revoked = await fetch(`${baseUrl}/agent/keys/${createdKey.id}`, {
      method: 'DELETE', headers: { 'x-test-sso-user': 'alice', origin }
    });
    expect(revoked.status).toBe(204);
    expect(agent.verifyAgentToken(createdKey.token)).toBeNull();
  });
});
