import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testDb = path.join('/tmp', `stone-wealth-transaction-routes-${process.pid}.sqlite`);
process.env.ASSET_TRACKER_DB_PATH = testDb;
process.env.NODE_ENV = 'test';

let db: any;
let server: any;
let baseUrl: string;

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { username: 'transaction-test' };
    next();
  });
  app.use('/api/v2', require('../src/routes/v2.cjs'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v2`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(resolve));
  db?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${testDb}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

async function request(route: string, method: string, body: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

describe('household transaction and asset cash-flow consistency', () => {
  it('updates linked flow direction and retains it when a transaction is unlinked', async () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
    const expense = db.prepare("SELECT id FROM household_categories WHERE kind = 'expense' LIMIT 1").get().id;
    const income = db.prepare("SELECT id FROM household_categories WHERE kind = 'income' LIMIT 1").get().id;
    const account = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Cash-flow test', 'bank')").run().lastInsertRowid);
    const created = await request('/household/transactions', 'POST', {
      kind: 'expense', amount: 12, currency_id: cny, category_id: expense,
      account_id: account, occurred_on: '2033-03-01', note: 'Linked flow test',
    });
    expect(created.status).toBe(201);
    const id = created.payload.data.id;
    const linked = await request(`/household/transactions/${id}/link-cash-flow`, 'POST', {});
    expect(linked.status).toBe(200);
    const flowId = linked.payload.data.cashFlowId;

    const updated = await request(`/household/transactions/${id}`, 'PATCH', {
      kind: 'income', amount: 27, category_id: income, linked_action: 'sync',
    });
    expect(updated.status).toBe(200);
    expect(updated.payload.data.amount_cny).toBe(27);
    expect(db.prepare('SELECT flow_type, amount FROM cash_flows WHERE id = ?').get(flowId))
      .toMatchObject({ flow_type: 'deposit', amount: 27 });

    const unlinked = await request(`/household/transactions/${id}`, 'PATCH', {
      amount: 32, linked_action: 'unlink',
    });
    expect(unlinked.status).toBe(200);
    expect(unlinked.payload.data.linked_cash_flow_id).toBeNull();
    expect(db.prepare('SELECT amount, source_transaction_id, archived_at FROM cash_flows WHERE id = ?').get(flowId))
      .toMatchObject({ amount: 27, source_transaction_id: null, archived_at: null });
    expect(db.prepare("SELECT username FROM audit_log WHERE entity_type = 'household_transaction' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(id).username)
      .toBe('transaction-test');
  });

  it('rejects invalid category and currency conversions before saving', async () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
    const expense = db.prepare("SELECT id FROM household_categories WHERE kind = 'expense' LIMIT 1").get().id;
    const income = db.prepare("SELECT id FROM household_categories WHERE kind = 'income' LIMIT 1").get().id;
    const unknown = Number(db.prepare("INSERT INTO currencies (code) VALUES ('ZZZ')").run().lastInsertRowid);
    const base = { kind: 'expense', amount: 5, category_id: expense, occurred_on: '2033-04-01' };

    expect((await request('/household/transactions', 'POST', { ...base, category_id: income, currency_id: cny })).status).toBe(400);
    expect((await request('/household/transactions', 'POST', { ...base, currency_id: cny, fx_rate_to_cny: 2 })).status).toBe(400);
    expect((await request('/household/transactions', 'POST', { ...base, currency_id: cny, occurred_on: '2033-02-30' })).status).toBe(400);
    const noRate = await request('/household/transactions', 'POST', { ...base, currency_id: unknown });
    expect(noRate.status).toBe(400);
    expect(noRate.payload.error.code).toBe('FX_RATE_REQUIRED');

    const valid = await request('/household/transactions', 'POST', { ...base, currency_id: unknown, fx_rate_to_cny: 3 });
    expect(valid.status).toBe(201);
    expect(valid.payload.data.amount_cny).toBe(15);
    const badPatch = await request(`/household/transactions/${valid.payload.data.id}`, 'PATCH', {
      kind: 'income', category_id: expense,
    });
    expect(badPatch.status).toBe(400);
    expect(db.prepare('SELECT kind, amount_cny FROM household_transactions WHERE id = ?').get(valid.payload.data.id))
      .toMatchObject({ kind: 'expense', amount_cny: 15 });
  });

  it('removes a direct cash-flow link without deleting the recorded flow', async () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
    const expense = db.prepare("SELECT id FROM household_categories WHERE kind = 'expense' LIMIT 1").get().id;
    const account = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Direct unlink test', 'bank')").run().lastInsertRowid);
    const created = await request('/household/transactions', 'POST', {
      kind: 'expense', amount: 24, currency_id: cny, category_id: expense,
      account_id: account, occurred_on: '2033-06-01', note: 'Keep flow',
    });
    const id = created.payload.data.id;
    const linked = await request(`/household/transactions/${id}/link-cash-flow`, 'POST', {});
    const flowId = linked.payload.data.cashFlowId;

    const unlinked = await fetch(`${baseUrl}/household/transactions/${id}/cash-flow-link`, { method: 'DELETE' });
    expect(unlinked.status).toBe(204);
    expect(db.prepare('SELECT linked_cash_flow_id FROM household_transactions WHERE id = ?').get(id).linked_cash_flow_id).toBeNull();
    expect(db.prepare('SELECT amount, source_transaction_id, archived_at FROM cash_flows WHERE id = ?').get(flowId))
      .toMatchObject({ amount: 24, source_transaction_id: null, archived_at: null });
  });
});
