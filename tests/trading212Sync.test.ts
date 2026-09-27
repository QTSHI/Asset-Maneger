import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-t212-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(testDir, 'test.sqlite');
process.env.T212_API_KEY = 'test-key';
process.env.T212_API_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const https = require('node:https');
let db: any;
let trading212: any;

type StubResponse = { status: number; body?: unknown };

function stubRequests(responses: Record<string, StubResponse>) {
  const paths: string[] = [];
  vi.spyOn(https, 'request').mockImplementation(((options: any, callback: any) => {
    paths.push(options.path);
    const request = new EventEmitter() as any;
    request.end = () => queueMicrotask(() => {
      const response = responses[options.path];
      if (!response) {
        request.emit('error', new Error(`Unexpected test request: ${options.path}`));
        return;
      }
      const stream = new EventEmitter() as any;
      stream.statusCode = response.status;
      callback(stream);
      stream.emit('data', JSON.stringify(response.body ?? {}));
      stream.emit('end');
    });
    request.destroy = (error: Error) => request.emit('error', error);
    return request;
  }) as any);
  return paths;
}

function seedAggregate() {
  const currency = db.prepare("SELECT id FROM currencies WHERE code = 'GBP'").get().id;
  const type = db.prepare("SELECT id FROM asset_types WHERE name = 'unclassified'").get().id;
  const platform = db.prepare("INSERT INTO platforms (name, default_currency_id) VALUES ('Trading212', ?)").run(currency);
  db.prepare(`
    INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id)
    VALUES ('T212-TOTAL', 'Trading212 account', 500, 1, ?, ?, ?)
  `).run(type, Number(platform.lastInsertRowid), currency);
}

const validSummary = { cash: { free: 20 }, totalValue: 120, currency: 'GBP' };
const validPositions = [{
  instrument: { ticker: 'TEST_US_EQ', name: 'Test share', type: 'EQUITY', currencyCode: 'GBP' },
  quantity: 2,
  averagePricePaid: 40,
  currentPrice: 50,
  walletImpact: { currentValue: 100 }
}];

beforeAll(() => {
  db = require('../src/services/database.cjs');
  trading212 = require('../src/services/trading212Service.cjs');
});

beforeEach(() => {
  db.prepare("DELETE FROM integration_status WHERE integration_key = 'trading212'").run();
  db.prepare("DELETE FROM assets WHERE code = 'T212-TOTAL' OR external_source = 'trading212'").run();
  db.prepare("DELETE FROM quote_cache WHERE source = 'trading212'").run();
  db.prepare("DELETE FROM platforms WHERE name = 'Trading212'").run();
  db.prepare("DELETE FROM exchange_rate_cache WHERE currency_code = 'CHF'").run();
  db.prepare("DELETE FROM currencies WHERE code = 'CHF'").run();
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
  db?.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('Trading212 sync safety', () => {
  it('treats 401 as invalid credentials without a fallback request or asset changes', async () => {
    seedAggregate();
    const paths = stubRequests({
      '/api/v0/equity/account/summary': { status: 401 },
      '/api/v0/equity/positions': { status: 200, body: validPositions }
    });

    await expect(trading212.sync('test')).rejects.toMatchObject({ code: 'AUTH_FAILED', status: 502 });

    expect(paths).toHaveLength(2);
    expect(paths).not.toContain('/api/v0/equity/account/cash');
    expect(db.prepare("SELECT shares FROM assets WHERE code = 'T212-TOTAL' AND archived_at IS NULL").get().shares).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE external_source = 'trading212'").get().count).toBe(0);
    expect(trading212.getStatus()).toMatchObject({
      configured: true,
      authenticationState: 'invalid',
      detailedSyncAvailable: false,
      lastErrorCode: 'AUTH_FAILED',
      aggregateFallback: true,
      state: 'error'
    });
  });

  it('rejects malformed positions before creating currencies or replacing the aggregate', async () => {
    seedAggregate();
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: { cash: { free: 20 }, totalValue: 120, currency: 'CAD' } },
      '/api/v0/equity/positions': { status: 200, body: { unexpected: [] } }
    });

    await expect(trading212.sync('test')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    expect(db.prepare("SELECT id FROM currencies WHERE code = 'CAD'").get()).toBeUndefined();
    expect(db.prepare("SELECT archived_at FROM assets WHERE code = 'T212-TOTAL'").get().archived_at).toBeNull();
    expect(trading212.getStatus()).toMatchObject({ authenticationState: 'unknown', lastErrorCode: 'INVALID_RESPONSE' });
  });

  it('does not report success when account value reconciles but a position has no usable price', async () => {
    seedAggregate();
    const positionWithoutPrice = { ...validPositions[0], currentPrice: undefined };
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 200, body: [positionWithoutPrice] }
    });

    await expect(trading212.sync('test')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE external_source = 'trading212'").get().count).toBe(0);
    expect(db.prepare("SELECT archived_at FROM assets WHERE code = 'T212-TOTAL'").get().archived_at).toBeNull();
  });

  it('keeps the old aggregate when account totals fail reconciliation', async () => {
    seedAggregate();
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: { ...validSummary, totalValue: 999 } },
      '/api/v0/equity/positions': { status: 200, body: validPositions }
    });

    await expect(trading212.sync('test')).rejects.toMatchObject({ code: 'RECONCILIATION_FAILED' });

    expect(db.prepare("SELECT archived_at FROM assets WHERE code = 'T212-TOTAL'").get().archived_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE external_source = 'trading212'").get().count).toBe(0);
    expect(trading212.getStatus()).toMatchObject({
      lastErrorCode: 'RECONCILIATION_FAILED',
      details: { total: 999, cash: 20, positions: 1 }
    });
  });

  it('keeps existing assets when a position currency has no valuation rate', async () => {
    seedAggregate();
    const chfPosition = {
      ...validPositions[0],
      instrument: { ...validPositions[0].instrument, currencyCode: 'CHF' }
    };
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 200, body: [chfPosition] }
    });

    await expect(trading212.sync('test')).rejects.toMatchObject({
      code: 'FX_RATE_UNAVAILABLE', status: 422,
      message: expect.stringContaining('CHF')
    });
    expect(db.prepare("SELECT id FROM currencies WHERE code = 'CHF'").get()).toBeUndefined();
    expect(db.prepare("SELECT archived_at FROM assets WHERE code = 'T212-TOTAL'").get().archived_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE external_source = 'trading212'").get().count).toBe(0);
    expect(trading212.getStatus()).toMatchObject({ state: 'error', lastErrorCode: 'FX_RATE_UNAVAILABLE' });
  });

  it('checks the account cash currency even when there are no positions', async () => {
    seedAggregate();
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: { cash: { free: 20 }, totalValue: 20, currency: 'CHF' } },
      '/api/v0/equity/positions': { status: 200, body: [] }
    });

    await expect(trading212.sync('test')).rejects.toMatchObject({ code: 'FX_RATE_UNAVAILABLE', status: 422 });
    expect(db.prepare("SELECT id FROM currencies WHERE code = 'CHF'").get()).toBeUndefined();
    expect(db.prepare("SELECT archived_at FROM assets WHERE code = 'T212-TOTAL'").get().archived_at).toBeNull();
  });

  it('accepts a newly seen position currency when a valid cached rate exists', async () => {
    seedAggregate();
    db.prepare("INSERT INTO exchange_rate_cache (currency_code, rate_to_cny) VALUES ('CHF', 8)").run();
    const chfPosition = {
      ...validPositions[0],
      instrument: { ...validPositions[0].instrument, currencyCode: 'CHF' }
    };
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 200, body: [chfPosition] }
    });

    expect(await trading212.sync('test')).toMatchObject({ state: 'success' });
    expect(db.prepare("SELECT code FROM currencies WHERE code = 'CHF'").get()).toEqual({ code: 'CHF' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets WHERE external_source = 'trading212' AND archived_at IS NULL").get().count).toBe(2);
  });

  it('uses legacy endpoints only when primary endpoints are absent', async () => {
    const paths = stubRequests({
      '/api/v0/equity/account/summary': { status: 404 },
      '/api/v0/equity/account/cash': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 404 },
      '/api/v0/equity/portfolio': { status: 200, body: validPositions }
    });

    const status = await trading212.sync('test');

    expect(status).toMatchObject({ state: 'success', authenticationState: 'valid' });
    expect(paths).toEqual(expect.arrayContaining([
      '/api/v0/equity/account/cash', '/api/v0/equity/portfolio'
    ]));
  });

  it('recovers a sync left running by a stopped server process', async () => {
    db.prepare(`
      INSERT INTO integration_status (integration_key, state, last_started_at, message)
      VALUES ('trading212', 'running', datetime('now', '-5 minutes'), 'stale request')
    `).run();
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 200, body: validPositions }
    });

    expect(await trading212.sync('test')).toMatchObject({ state: 'success', authenticationState: 'valid' });
  });

  it('atomically replaces the aggregate on success and preserves detailed data on later failure', async () => {
    seedAggregate();
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 200, body: validPositions }
    });

    const success = await trading212.sync('test');
    expect(success).toMatchObject({ state: 'success', authenticationState: 'valid', detailedSyncAvailable: true, aggregateFallback: false });
    expect(success.details).not.toHaveProperty('credentialFingerprint');
    expect(db.prepare("SELECT archived_at FROM assets WHERE code = 'T212-TOTAL'").get().archived_at).not.toBeNull();
    expect(db.prepare("SELECT code FROM assets WHERE external_source = 'trading212' AND archived_at IS NULL ORDER BY code").all())
      .toEqual([{ code: 'T212-CASH' }, { code: 'TEST_US_EQ' }]);

    vi.restoreAllMocks();
    stubRequests({
      '/api/v0/equity/account/summary': { status: 401 },
      '/api/v0/equity/positions': { status: 401 }
    });
    await expect(trading212.sync('test')).rejects.toMatchObject({ code: 'AUTH_FAILED' });

    const failed = trading212.getStatus();
    expect(failed).toMatchObject({ state: 'error', authenticationState: 'invalid', detailedSyncAvailable: false });
    expect(failed.lastSuccessAt).toBeTruthy();
    expect(db.prepare("SELECT code FROM assets WHERE external_source = 'trading212' AND archived_at IS NULL ORDER BY code").all())
      .toEqual([{ code: 'T212-CASH' }, { code: 'TEST_US_EQ' }]);
  });

  it('does not present a prior successful sync as verification of different credentials', async () => {
    stubRequests({
      '/api/v0/equity/account/summary': { status: 200, body: validSummary },
      '/api/v0/equity/positions': { status: 200, body: validPositions }
    });
    await trading212.sync('test');

    const row = db.prepare("SELECT details_json FROM integration_status WHERE integration_key = 'trading212'").get();
    const details = JSON.parse(row.details_json);
    expect(row.details_json).not.toContain('test-secret');
    db.prepare("UPDATE integration_status SET details_json = ? WHERE integration_key = 'trading212'")
      .run(JSON.stringify({ ...details, credentialFingerprint: 'previous-credentials' }));

    expect(trading212.getStatus()).toMatchObject({
      configured: true,
      state: 'success',
      authenticationState: 'unknown',
      detailedSyncAvailable: false
    });
  });
});
