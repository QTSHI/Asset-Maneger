import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-attention-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(directory, 'attention.sqlite');
process.env.NODE_ENV = 'test';

let db: any;
let attention: any;
let trading212: any;
let server: any;
let baseUrl: string;
let accountId: number;
let cashType: number;
let fundType: number;
let cny: number;
let sequence = 0;
const now = new Date('2026-10-19T15:59:59Z');
const unusedIntegration = {
  configured: false, state: 'idle', lastErrorCode: null, lastSuccessAt: null, details: null,
};

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  attention = require('../src/services/attentionService.cjs');
  trading212 = require('../src/services/trading212Service.cjs');
  cashType = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
  fundType = db.prepare("SELECT id FROM asset_types WHERE name = 'fund'").get().id;
  cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
  const express = require('express');
  const app = express();
  app.use('/api/v2/attention', require('../src/routes/attention.cjs'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v2/attention`;
});

beforeEach(() => {
  db.prepare('DELETE FROM assets').run();
  db.prepare('DELETE FROM platforms').run();
  db.prepare('DELETE FROM quote_cache').run();
  db.prepare('DELETE FROM integration_status').run();
  accountId = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES (?, 'investment')").run(`Attention ${++sequence}`).lastInsertRowid);
  vi.spyOn(trading212, 'getStatus').mockReturnValue(unusedIntegration);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(resolve));
  db?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function asset(overrides: Record<string, unknown> = {}) {
  const values = {
    code: `ATT-${++sequence}`, name: '待核对资产', shares: 10, cost_price: 1,
    asset_type_id: fundType, platform_id: accountId, currency_id: cny, ...overrides,
  };
  const columns = Object.keys(values);
  const result = db.prepare(`INSERT INTO assets (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
  return { ...values, id: Number(result.lastInsertRowid) };
}

function quote(record: any, status = 'fresh', price: number | null = 2, fetchedAt = '2026-10-19 00:00:00') {
  db.prepare(`INSERT INTO quote_cache (cache_key, code, asset_type, price, status, fetched_at)
    VALUES (?, ?, 'fund', ?, ?, ?)`).run(`${record.quote_code || record.code}_fund`, record.quote_code || record.code, price, status, fetchedAt);
}

function get() { return attention.getAttention({ now }); }

describe('household attention checklist', () => {
  it('keeps the endpoint available when valuation is blocked by a missing FX rate', async () => {
    const currencyId = Number(db.prepare("INSERT INTO currencies (code) VALUES ('QXZ')").run().lastInsertRowid);
    const record = asset({ asset_type_id: cashType, currency_id: currencyId, cash_confirmed_at: '2026-10-19' });
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { data } = await response.json();
    expect(data.items).toEqual(expect.arrayContaining([expect.objectContaining({
      assetId: record.id, kind: 'missing_fx', severity: 'high', href: '/status',
    })]));
    expect(data.total).toBe(data.items.length);
    expect(data.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('excludes archived assets and every asset in an archived account', () => {
    asset({ archived_at: '2026-10-18 12:00:00' });
    const archivedAccount = Number(db.prepare("INSERT INTO platforms (name, archived_at, external_source) VALUES ('Archived Trading212', CURRENT_TIMESTAMP, 'trading212')").run().lastInsertRowid);
    asset({ platform_id: archivedAccount, external_source: 'trading212' });
    db.prepare("INSERT INTO integration_status (integration_key, state, message) VALUES ('trading212', 'error', 'An old failure')").run();
    expect(get().items).toEqual([]);
  });

  it('uses the same quote identity as valuation for imported holdings', () => {
    const imported = asset({ code: 'IMPORT-ROW', quote_code: '000218', external_source: 'manual_import', quantity_status: 'estimated' });
    quote(imported);
    expect(get().items).toEqual([expect.objectContaining({ kind: 'estimated_quantity', assetId: imported.id })]);
  });

  it('reports missing and estimated quantities and prioritizes blocked data', () => {
    const missing = asset({ quantity_status: 'missing', shares: 0 });
    const estimated = asset({ quantity_status: 'estimated' });
    quote(estimated);
    const result = get();
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: missing.id, kind: 'missing_quantity', severity: 'high' }),
      expect.objectContaining({ assetId: missing.id, kind: 'quote_missing', severity: 'high' }),
      expect.objectContaining({ assetId: estimated.id, kind: 'estimated_quantity', severity: 'medium' }),
    ]));
    expect(result.counts).toEqual({ high: 2, medium: 1, low: 0 });
    expect(result.items.at(-1).severity).toBe('medium');
  });

  it('distinguishes missing, stale and failed quotes without aging a fresh holiday quote', () => {
    const missing = asset();
    const stale = asset(); quote(stale, 'stale');
    const failed = asset(); quote(failed, 'error');
    const holiday = asset(); quote(holiday, 'fresh', 2, '2026-10-01 00:00:00');
    expect(get().items.map((item: any) => [item.assetId, item.kind])).toEqual(expect.arrayContaining([
      [missing.id, 'quote_missing'], [stale.id, 'quote_stale'], [failed.id, 'quote_error'],
    ]));
    expect(get().items.some((item: any) => item.assetId === holiday.id)).toBe(false);
  });

  it('flags cash only after 30 Shanghai calendar days and excludes synced cash', () => {
    const thirtyDays = asset({ asset_type_id: cashType, cash_confirmed_at: '2026-09-19' });
    const overdue = asset({ asset_type_id: cashType, cash_confirmed_at: '2026-09-18' });
    const unconfirmed = asset({ asset_type_id: cashType });
    const synced = asset({ asset_type_id: cashType, external_source: 'trading212', external_id: 'cash' });
    const today = asset({ asset_type_id: cashType, cash_confirmed_at: '2026-10-19' });
    const result = get();
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: overdue.id, kind: 'cash_stale' }),
      expect.objectContaining({ assetId: unconfirmed.id, kind: 'cash_unconfirmed' }),
    ]));
    for (const record of [thirtyDays, synced, today]) {
      expect(result.items.some((item: any) => item.assetId === record.id)).toBe(false);
    }
    const nextDay = attention.getAttention({ now: new Date('2026-10-19T16:00:00Z') });
    expect(nextDay.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: thirtyDays.id, kind: 'cash_stale' }),
    ]));
  });

  it('interprets legacy cash timestamps in UTC then converts to Shanghai dates', () => {
    const boundary = asset({ asset_type_id: cashType, cash_confirmed_at: '2026-09-18 16:00:00' });
    const beforeBoundary = asset({ asset_type_id: cashType, cash_confirmed_at: '2026-09-18 15:59:59' });
    const future = asset({ asset_type_id: cashType, cash_confirmed_at: '2026-10-20' });
    expect(get().items.some((item: any) => item.assetId === boundary.id)).toBe(false);
    expect(get().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: beforeBoundary.id, kind: 'cash_stale' }),
      expect.objectContaining({ assetId: future.id, kind: 'cash_confirmation_invalid' }),
    ]));
  });

  it('does not list an unconfigured unused integration, even with old failed status', () => {
    vi.mocked(trading212.getStatus).mockReturnValue({ ...unusedIntegration, state: 'error', lastErrorCode: 'AUTH_FAILED' });
    expect(get().total).toBe(0);
  });

  it('reports Trading212 stale sync once per active account at strictly more than 72 hours', () => {
    db.prepare("UPDATE platforms SET external_source = 'trading212' WHERE id = ?").run(accountId);
    const one = asset({ external_source: 'trading212', external_id: 'one' }); quote(one, 'stale');
    const two = asset({ external_source: 'trading212', external_id: 'two' }); quote(two, 'stale');
    vi.mocked(trading212.getStatus).mockReturnValue({ ...unusedIntegration, configured: true, state: 'success', lastSuccessAt: '2026-10-16 15:59:59' });
    expect(get().items).toEqual([]);
    const overdue = attention.getAttention({ now: new Date('2026-10-19T16:00:00Z') });
    expect(overdue.items).toEqual([expect.objectContaining({ kind: 'sync_stale', accountId, href: '/status' })]);
  });

  it('reports relevant integration failure and reconciliation mismatch without leaking raw details', () => {
    db.prepare("UPDATE platforms SET external_source = 'trading212' WHERE id = ?").run(accountId);
    vi.mocked(trading212.getStatus).mockReturnValue({
      ...unusedIntegration, configured: true, state: 'error', lastErrorCode: 'AUTH_FAILED',
      message: 'private-token-sentinel', details: { total: 987654.32, credentialFingerprint: 'private-token-sentinel' },
    });
    expect(get().items).toEqual([expect.objectContaining({ kind: 'sync_error', accountId, severity: 'high' })]);
    vi.mocked(trading212.getStatus).mockReturnValue({
      ...unusedIntegration, configured: true, state: 'error', lastErrorCode: 'RECONCILIATION_FAILED',
      details: { total: 987654.32, difference: 50, tolerance: 5, credentialFingerprint: 'private-token-sentinel' },
    });
    const result = get();
    expect(result.items).toEqual([expect.objectContaining({ kind: 'reconciliation_mismatch', accountId, severity: 'high' })]);
    expect(JSON.stringify(result)).not.toMatch(/987654|private-token-sentinel/);
  });
});
