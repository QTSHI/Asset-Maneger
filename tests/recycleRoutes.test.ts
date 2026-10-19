import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-recycle-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(directory, 'test.sqlite');
process.env.NODE_ENV = 'test';

let db: any;
let server: any;
let baseUrl: string;
let cny: number;
let cash: number;
let expense: number;
let sequence = 0;

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
  cash = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
  expense = db.prepare("SELECT id FROM household_categories WHERE kind = 'expense' LIMIT 1").get().id;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.user = { username: 'recycle-test' }; next(); });
  app.use('/api/v2', require('../src/routes/v2.cjs'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v2`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(resolve));
  db?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: new URL(baseUrl).origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: response.status === 204 ? null : await response.json() };
}

function account() {
  return Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES (?, 'bank')").run(`Recycle account ${++sequence}`).lastInsertRowid);
}

async function asset(accountId = account(), overrides = {}) {
  const created = await request('/assets', 'POST', {
    platform_id: accountId, asset_type_id: cash, code: `RECYCLE-${++sequence}`, name: 'Recoverable cash',
    shares: 230, cost_price: 1, currency_id: cny, ...overrides,
  });
  expect(created.status).toBe(201);
  return created.payload.data;
}

async function transaction(accountId = account()) {
  const created = await request('/household/transactions', 'POST', {
    kind: 'expense', amount: 38, currency_id: cny, category_id: expense,
    account_id: accountId, occurred_on: '2033-05-01', note: 'Recoverable expense',
  });
  expect(created.status).toBe(201);
  return created.payload.data;
}

async function linkedTransaction() {
  const record = await transaction();
  const linked = await request(`/household/transactions/${record.id}/link-cash-flow`, 'POST', {});
  expect(linked.status).toBe(200);
  return { record, flowId: linked.payload.data.cashFlowId };
}

function row(table: string, id: number) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

describe('asset recycle bin', () => {
  it('restores the original asset and records the actor without inserting a duplicate', async () => {
    const before = await asset();
    expect((await request(`/assets/${before.id}`, 'DELETE')).status).toBe(204);
    const archived = (await request('/assets/archived')).payload.data.find((item: any) => item.id === before.id);
    expect(archived).toMatchObject({ can_restore: true, restore_blocked_reason: null, currency_code: 'CNY', asset_type_name: 'cash' });
    expect(archived.account_name).toMatch(/^Recycle account/);
    const count = db.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
    const restored = await request(`/assets/${before.id}/restore`, 'POST', {});
    expect(restored.status).toBe(200);
    expect(restored.payload.data).toMatchObject({ id: before.id, shares: 230, archived_at: null, updated_by: 'recycle-test' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count).toBe(count);
    expect(db.prepare("SELECT username, action FROM audit_log WHERE entity_type = 'asset' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(before.id))
      .toMatchObject({ username: 'recycle-test', action: 'restore' });
    expect((await request(`/assets/${before.id}/restore`, 'POST', {})).status).toBe(404);
  });

  it('blocks recovery until the original account is active', async () => {
    const before = await asset();
    await request(`/assets/${before.id}`, 'DELETE');
    db.prepare('UPDATE platforms SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(before.platform_id);
    const archived = (await request('/assets/archived')).payload.data.find((item: any) => item.id === before.id);
    expect(archived.can_restore).toBe(false);
    expect(archived.restore_blocked_reason).toContain('账户');
    expect((await request(`/assets/${before.id}/restore`, 'POST', {})).status).toBe(409);
    expect(row('assets', before.id).archived_at).not.toBeNull();
    await request(`/accounts/${before.platform_id}/restore`, 'POST', {});
    expect((await request(`/assets/${before.id}/restore`, 'POST', {})).status).toBe(200);
  });

  it('restores a manually imported holding with its original valuation fields', async () => {
    const before = await asset(undefined, {
      shares: 12.5, cost_price: 8.7, quantity_status: 'estimated', valuation_mode: 'position_value',
      imported_market_value: 123.45, imported_cost_value: 108.75, valuation_as_of: '2033-04-30', quote_code: 'IMPORTED-FUND',
    });
    db.prepare("UPDATE assets SET external_source = 'manual_import', external_id = ? WHERE id = ?").run(`import-${before.id}`, before.id);
    await request(`/assets/${before.id}`, 'DELETE');
    const archived = (await request('/assets/archived')).payload.data.find((item: any) => item.id === before.id);
    expect(archived).toMatchObject({ can_restore: true, restore_blocked_reason: null });
    const restored = await request(`/assets/${before.id}/restore`, 'POST', {});
    expect(restored.status).toBe(200);
    expect(restored.payload.data).toMatchObject({
      id: before.id, external_source: 'manual_import', external_id: `import-${before.id}`, archived_at: null,
      shares: 12.5, cost_price: 8.7, quantity_status: 'estimated', valuation_mode: 'position_value',
      imported_market_value: 123.45, imported_cost_value: 108.75, valuation_as_of: '2033-04-30', quote_code: 'IMPORTED-FUND',
    });
  });

  it('does not revive sync-managed positions or the legacy Trading212 aggregate', async () => {
    for (const legacyAggregate of [false, true]) {
      const before = await asset(undefined, legacyAggregate ? { code: 'T212-TOTAL' } : {});
      if (!legacyAggregate) db.prepare("UPDATE assets SET external_source = 'trading212', external_id = ? WHERE id = ?").run(`external-${before.id}`, before.id);
      await request(`/assets/${before.id}`, 'DELETE');
      const restored = await request(`/assets/${before.id}/restore`, 'POST', {});
      expect(restored.status).toBe(409);
      expect(restored.payload.error.code).toBe('RESTORE_BLOCKED');
      expect(row('assets', before.id).archived_at).not.toBeNull();
    }
  });
});

describe('household transaction recycle bin', () => {
  it('restores an unlinked record with its original ID, amount and historical exchange rate', async () => {
    const before = await transaction();
    await request(`/household/transactions/${before.id}`, 'DELETE');
    const archived = (await request('/household/transactions/archived')).payload.data.find((item: any) => item.id === before.id);
    expect(archived).toMatchObject({ can_restore: true, restore_blocked_reason: null, flow_restore_blocked_reason: null, currency_code: 'CNY' });
    expect(archived.category_name).toBeTruthy();
    const restored = await request(`/household/transactions/${before.id}/restore`, 'POST', {});
    expect(restored.status).toBe(200);
    expect(restored.payload.data).toMatchObject({ id: before.id, amount: 38, amount_cny: 38, fx_rate_to_cny: 1, archived_at: null });
    expect(db.prepare("SELECT username, action FROM audit_log WHERE entity_type = 'household_transaction' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(before.id))
      .toMatchObject({ username: 'recycle-test', action: 'restore' });
    expect((await request(`/household/transactions/${before.id}/restore`, 'POST', {})).status).toBe(404);
  });

  it('atomically restores only the original flow archived by the transaction deletion', async () => {
    const { record, flowId } = await linkedTransaction();
    expect((await request(`/household/transactions/${record.id}`, 'DELETE', { linked_action: 'sync' })).status).toBe(204);
    expect(row('cash_flows', flowId).archived_at).toBe(row('household_transactions', record.id).archived_at);
    const archived = (await request('/household/transactions/archived')).payload.data.find((item: any) => item.id === record.id);
    expect(archived.flow_restore_blocked_reason).toBeNull();
    const flowCount = db.prepare('SELECT COUNT(*) AS count FROM cash_flows').get().count;
    const restored = await request(`/household/transactions/${record.id}/restore`, 'POST', {});
    expect(restored.status).toBe(200);
    expect(restored.payload.data.linked_cash_flow_id).toBe(flowId);
    expect(row('cash_flows', flowId)).toMatchObject({ archived_at: null, amount: 38, source_transaction_id: record.id });
    expect(db.prepare('SELECT COUNT(*) AS count FROM cash_flows').get().count).toBe(flowCount);
    expect(db.prepare("SELECT action, username FROM audit_log WHERE entity_type = 'cash_flow' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(flowId))
      .toMatchObject({ action: 'restore_with_transaction', username: 'recycle-test' });
  });

  it('requires record-only recovery when the historical flow archive has no reliable provenance', async () => {
    const { record, flowId } = await linkedTransaction();
    db.prepare("UPDATE household_transactions SET archived_at = '2020-01-01' WHERE id = ?").run(record.id);
    db.prepare("UPDATE cash_flows SET archived_at = '2020-01-01' WHERE id = ?").run(flowId);
    const archived = (await request('/household/transactions/archived')).payload.data.find((item: any) => item.id === record.id);
    expect(archived.can_restore).toBe(true);
    expect(archived.flow_restore_blocked_reason).toBeTruthy();
    expect((await request(`/household/transactions/${record.id}/restore`, 'POST', {})).status).toBe(409);
    expect(row('household_transactions', record.id).archived_at).toBe('2020-01-01');
    expect(row('cash_flows', flowId).archived_at).toBe('2020-01-01');
    const restored = await request(`/household/transactions/${record.id}/restore`, 'POST', { linked_action: 'unlink' });
    expect(restored.status).toBe(200);
    expect(restored.payload.data.linked_cash_flow_id).toBeNull();
    expect(row('cash_flows', flowId)).toMatchObject({ archived_at: '2020-01-01', source_transaction_id: null });
  });

  it('detects a flow changed since deletion and never revives it during record-only recovery', async () => {
    const { record, flowId } = await linkedTransaction();
    await request(`/household/transactions/${record.id}`, 'DELETE', { linked_action: 'sync' });
    db.prepare("UPDATE cash_flows SET note = 'Independently reviewed' WHERE id = ?").run(flowId);
    expect((await request(`/household/transactions/${record.id}/restore`, 'POST', {})).payload.error.code).toBe('LINKED_FLOW_RESTORE_BLOCKED');
    expect(row('household_transactions', record.id).archived_at).not.toBeNull();
    await request(`/household/transactions/${record.id}/restore`, 'POST', { linked_action: 'unlink' });
    expect(row('cash_flows', flowId)).toMatchObject({ note: 'Independently reviewed', source_transaction_id: null });
    expect(row('cash_flows', flowId).archived_at).not.toBeNull();
  });

  it('leaves an unrelated flow untouched when the transaction has a stale link', async () => {
    const owner = await linkedTransaction();
    const other = await transaction();
    db.prepare("UPDATE household_transactions SET linked_cash_flow_id = ?, archived_at = '2020-01-01' WHERE id = ?").run(owner.flowId, other.id);
    const originalFlow = row('cash_flows', owner.flowId);
    expect((await request(`/household/transactions/${other.id}/restore`, 'POST', {})).status).toBe(409);
    const restored = await request(`/household/transactions/${other.id}/restore`, 'POST', { linked_action: 'unlink' });
    expect(restored.status).toBe(200);
    expect(restored.payload.data.linked_cash_flow_id).toBeNull();
    expect(row('cash_flows', owner.flowId)).toEqual(originalFlow);
    expect(row('household_transactions', owner.record.id).linked_cash_flow_id).toBe(owner.flowId);
  });

  it('retains a currently active flow when only the historical transaction is restored', async () => {
    const { record, flowId } = await linkedTransaction();
    db.prepare("UPDATE household_transactions SET archived_at = '2020-01-01' WHERE id = ?").run(record.id);
    expect((await request(`/household/transactions/${record.id}/restore`, 'POST', {})).status).toBe(409);
    expect((await request(`/household/transactions/${record.id}/restore`, 'POST', { linked_action: 'unlink' })).status).toBe(200);
    expect(row('cash_flows', flowId)).toMatchObject({ archived_at: null, amount: 38, source_transaction_id: null });
  });

  it('blocks both restore modes when the original category or account is archived', async () => {
    const category = Number(db.prepare("INSERT INTO household_categories (name, kind) VALUES ('Archived recycle category', 'expense')").run().lastInsertRowid);
    const first = await transaction();
    db.prepare('UPDATE household_transactions SET category_id = ? WHERE id = ?').run(category, first.id);
    await request(`/household/transactions/${first.id}`, 'DELETE');
    db.prepare('UPDATE household_categories SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(category);
    const second = await transaction();
    await request(`/household/transactions/${second.id}`, 'DELETE');
    db.prepare('UPDATE platforms SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(second.account_id);
    for (const record of [first, second]) {
      const archived = (await request('/household/transactions/archived')).payload.data.find((item: any) => item.id === record.id);
      expect(archived.can_restore).toBe(false);
      expect(archived.restore_blocked_reason).toBeTruthy();
      expect((await request(`/household/transactions/${record.id}/restore`, 'POST', { linked_action: 'unlink' })).status).toBe(409);
      expect(row('household_transactions', record.id).archived_at).not.toBeNull();
    }
  });

  it('rejects synchronized deletion of a stale link while allowing safe detachment', async () => {
    const owner = await linkedTransaction();
    const other = await transaction();
    db.prepare('UPDATE household_transactions SET linked_cash_flow_id = ? WHERE id = ?').run(owner.flowId, other.id);
    const originalFlow = row('cash_flows', owner.flowId);
    expect((await request(`/household/transactions/${other.id}`, 'DELETE', { linked_action: 'sync' })).status).toBe(409);
    expect(row('household_transactions', other.id).archived_at).toBeNull();
    expect((await request(`/household/transactions/${other.id}`, 'DELETE', { linked_action: 'unlink' })).status).toBe(204);
    expect(row('cash_flows', owner.flowId)).toEqual(originalFlow);
  });
});
