import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-fx-consistency-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(testDir, 'test.sqlite');
process.env.NODE_ENV = 'test';

let db: any;
let wealth: any;
let priceFetcher: any;
let initialServiceRates: Record<string, number>;

function currencyId(code: string): number {
  return db.prepare('SELECT id FROM currencies WHERE code = ?').get(code).id;
}

function setRate(code: string, rate: number): void {
  db.prepare(`
    INSERT INTO exchange_rate_cache (currency_code, rate_to_cny)
    VALUES (?, ?)
    ON CONFLICT(currency_code) DO UPDATE SET rate_to_cny = excluded.rate_to_cny
  `).run(code, rate);
}

function setPlan(month: string): void {
  db.prepare(`
    UPDATE household_plan_settings
    SET opening_amount = 1000, opening_currency_id = ?, planning_rate_to_cny = 1,
        start_month = ?, end_month = ?
    WHERE id = 1
  `).run(currencyId('CNY'), month, month);
}

beforeAll(() => {
  db = require('../src/services/database.cjs');
  wealth = require('../src/services/wealthService.cjs');
  priceFetcher = require('../src/services/priceFetcher.cjs');
  initialServiceRates = { ...priceFetcher.getExchangeRates() };
});

afterEach(() => {
  vi.restoreAllMocks();
  const rates = priceFetcher.getExchangeRates();
  for (const code of Object.keys(rates)) delete rates[code];
  Object.assign(rates, initialServiceRates);
});

afterAll(() => {
  db?.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('CNY conversion consistency', () => {
  it('converts plan memos with cached or service rates and always treats CNY as 1', () => {
    setPlan('2034-01');
    setRate('CNY', 99);
    setRate('USD', 7.25);
    db.prepare("DELETE FROM exchange_rate_cache WHERE currency_code = 'GBP'").run();
    const insert = db.prepare(`
      INSERT INTO financial_memos (kind, title, expected_amount, currency_id, due_date)
      VALUES (?, ?, ?, ?, '2034-01-15')
    `);
    insert.run('income', 'CNY income', 100, currencyId('CNY'));
    insert.run('expense', 'USD expense', 10, currencyId('USD'));
    insert.run('expense', 'GBP expense', 1, currencyId('GBP'));

    const gbpRate = priceFetcher.getExchangeRates().GBP_TO_CNY;
    const plan = wealth.getHouseholdPlan();
    expect(plan.months[0].memoIncomeCny).toBe(100);
    expect(plan.months[0].memoExpenseCny).toBeCloseTo(72.5 + gbpRate, 2);
    expect(plan.totals.projectedClosingBalanceCny).toBeCloseTo(1027.5 - gbpRate, 2);
  });

  it('rejects an unpriced foreign memo instead of counting its amount as CNY', () => {
    const unknown = db.prepare("INSERT INTO currencies (code) VALUES ('ZZZ')").run().lastInsertRowid;
    setPlan('2035-02');
    db.prepare(`
      INSERT INTO financial_memos (kind, title, expected_amount, currency_id, due_date)
      VALUES ('expense', 'Unknown currency', 5, ?, '2035-02-10')
    `).run(Number(unknown));

    let error: any;
    try { wealth.getHouseholdPlan(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 422, code: 'FX_RATE_UNAVAILABLE' });
    expect(error.message).toMatch(/大额事项计划.*ZZZ.*有效汇率/);
    setRate('ZZZ', 4.25);
    expect(wealth.getHouseholdPlan().months[0].memoExpenseCny).toBe(21.25);
  });

  it('includes CNY and foreign flows in the daily snapshot net amount', () => {
    setRate('CNY', 99);
    setRate('USD', 7.2);
    const insert = db.prepare(`
      INSERT INTO cash_flows (flow_type, amount, currency_id, occurred_on)
      VALUES (?, ?, ?, '2036-03-20')
    `);
    insert.run('deposit', 200, currencyId('CNY'));
    insert.run('withdrawal', 10, currencyId('USD'));
    insert.run('dividend', 2, currencyId('USD'));

    wealth.saveDailySnapshot('2036-03-20');
    const snapshot = db.prepare("SELECT net_cash_flow_cny FROM portfolio_snapshots WHERE snapshot_date = '2036-03-20'").get();
    expect(snapshot.net_cash_flow_cny).toBe(142.4);
  });

  it('refuses to save a partial flow snapshot when a foreign rate is invalid', () => {
    setRate('ZZZ', 0);
    db.prepare(`
      INSERT INTO cash_flows (flow_type, amount, currency_id, occurred_on)
      VALUES ('deposit', 5, ?, '2036-03-21')
    `).run(currencyId('ZZZ'));

    expect(() => wealth.saveDailySnapshot('2036-03-21')).toThrow(/每日资金净流量.*ZZZ.*有效汇率/);
    expect(db.prepare("SELECT id FROM portfolio_snapshots WHERE snapshot_date = '2036-03-21'").get()).toBeUndefined();
    setRate('ZZZ', 4);
    wealth.saveDailySnapshot('2036-03-21');
    expect(db.prepare("SELECT net_cash_flow_cny FROM portfolio_snapshots WHERE snapshot_date = '2036-03-21'").get().net_cash_flow_cny).toBe(20);
  });

  it('refuses to value a foreign asset without a valid rate', () => {
    const unknown = db.prepare("INSERT INTO currencies (code) VALUES ('QZX')").run().lastInsertRowid;
    const account = db.prepare("INSERT INTO platforms (name, account_type) VALUES ('FX Test Account', 'bank')").run().lastInsertRowid;
    const cashType = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
    const asset = db.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id)
      VALUES ('CASH-QZX-TEST', 'Unpriced cash', 10, 1, ?, ?, ?)
    `).run(cashType, Number(account), Number(unknown)).lastInsertRowid;

    expect(() => wealth.valueAssets()).toThrow(/资产价值.*QZX.*有效汇率/);
    setRate('QZX', 3);
    expect(wealth.valueAssets().find((item: any) => item.id === Number(asset)).marketValueCny).toBe(30);
  });

  it('values cash balance and cost equally even if a legacy cost price is zero', () => {
    const account = db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Cash Cost Test Account', 'bank')").run().lastInsertRowid;
    const cashType = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
    const assetId = Number(db.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id)
      VALUES ('CASH-COST-TEST', 'Cash cost test', 100, 0, ?, ?, ?)
    `).run(cashType, Number(account), currencyId('CNY')).lastInsertRowid);

    expect(wealth.valueAssets().find((item: any) => item.id === assetId)).toMatchObject({
      marketValueCny: 100, costValueCny: 100, profitCny: 0, profitPercent: 0, costPrice: 1,
    });
    db.prepare('UPDATE assets SET shares = -25.5 WHERE id = ?').run(assetId);
    expect(wealth.valueAssets().find((item: any) => item.id === assetId)).toMatchObject({
      marketValueCny: -25.5, costValueCny: -25.5, profitCny: 0,
    });
  });

  it('loads a real HKD rate from the provider and refuses partial FX responses', async () => {
    const axios = require('axios');
    const rates = priceFetcher.getExchangeRates();
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ data: { rates: {
      CNY: 9, USD: 1.25, EUR: 1.15, AED: 4.5, JPY: 190, HKD: 9.8,
    } } }).mockResolvedValueOnce({ data: { rates: { CNY: 8, USD: 1.2 } } });

    expect(await priceFetcher.updateExchangeRates()).toBe(true);
    expect(rates.HKD_TO_CNY).toBeCloseTo(9 / 9.8, 8);
    const valid = { ...rates };
    expect(await priceFetcher.updateExchangeRates()).toBe(false);
    expect(rates).toEqual(valid);
  });

  it('retains the old HKD rate without marking it freshly fetched when FX refresh fails', async () => {
    const axios = require('axios');
    setRate('HKD', 0.88);
    db.prepare("UPDATE exchange_rate_cache SET status = 'fresh', fetched_at = '2020-01-01 00:00:00' WHERE currency_code = 'HKD'").run();
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));

    const status = await wealth.refreshMarket();
    const hkd = db.prepare("SELECT rate_to_cny, status, fetched_at FROM exchange_rate_cache WHERE currency_code = 'HKD'").get();
    expect(status).toMatchObject({ state: 'error', message: '汇率更新失败，已保留上次有效汇率' });
    expect(hkd).toEqual({ rate_to_cny: 0.88, status: 'stale', fetched_at: '2020-01-01 00:00:00' });
  });
});
