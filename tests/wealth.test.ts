import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const testDb = path.join('/tmp', `stone-wealth-${process.pid}.sqlite`);
process.env.ASSET_TRACKER_DB_PATH = testDb;
process.env.NODE_ENV = 'test';

let db: any;
let wealth: any;
let trading212: any;
let priceFetcher: any;
let apiServer: any;
let apiBaseUrl: string;

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  wealth = require('../src/services/wealthService.cjs');
  trading212 = require('../src/services/trading212Service.cjs');
  priceFetcher = require('../src/services/priceFetcher.cjs');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { username: 'route-test' };
    next();
  });
  app.use('/api/v2', require('../src/routes/v2.cjs'));
  await new Promise<void>((resolve) => {
    apiServer = app.listen(0, '127.0.0.1', resolve);
  });
  const address = apiServer.address();
  apiBaseUrl = `http://127.0.0.1:${address.port}/api/v2`;
});

afterAll(async () => {
  if (apiServer) {
    await new Promise<void>((resolve, reject) =>
      apiServer.close((error: Error | undefined) => error ? reject(error) : resolve()),
    );
  }
  db?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${testDb}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

describe('asset classification', () => {
  it('normalizes the mainland stock fallback quote', () => {
    expect(priceFetcher.normalizeEastmoneyStockPrice({ data: { f43: 2363 } })).toBe(23.63);
    expect(priceFetcher.normalizeEastmoneyStockPrice({ data: { f43: '-' } })).toBeNull();
  });

  it('selects the latest available historical fund NAV on or before the record date', () => {
    expect(priceFetcher.normalizeHistoricalFundPrice({ Data: { LSJZList: [
      { FSRQ: '2026-07-27', DWJZ: '1.9795' },
      { FSRQ: '2026-07-26', DWJZ: '1.9500' },
    ] } }, '2026-07-27')).toBe(1.9795);
    expect(priceFetcher.normalizeHistoricalFundPrice({ Data: { LSJZList: [] } }, '2026-07-27')).toBeNull();
  });

  it('maps Trading212 ETFs and stocks without treating unknown instruments as cash', () => {
    expect(trading212.typeForInstrument({ type: 'ETF', ticker: 'VUSA_GB_EQ', currencyCode: 'GBP' })).toBe('etf');
    expect(trading212.typeForInstrument({ type: 'EQUITY', ticker: 'AAPL_US_EQ', currencyCode: 'USD' })).toBe('stock_us');
    expect(trading212.typeForInstrument({ type: 'UNKNOWN', ticker: 'MYSTERY' })).toBe('unclassified');
  });

  it('normalizes account summary variants', () => {
    expect(trading212.accountSummaryValues({ cash: { free: 120 }, totalValue: 500, currency: 'GBP' }))
      .toEqual({ cash: 120, total: 500, currency: 'GBP' });
  });
});

describe('Stone Wealth data model', () => {
  it('applies migrations and seeds household categories', () => {
    expect(db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count).toBeGreaterThanOrEqual(6);
    expect(db.prepare('SELECT COUNT(*) count FROM household_categories').get().count).toBeGreaterThan(5);
    const columns = db.prepare('PRAGMA table_info(assets)').all().map((row: any) => row.name);
    expect(columns).toEqual(expect.arrayContaining([
      'quote_code', 'quantity_status', 'valuation_mode', 'imported_market_value',
      'imported_cost_value', 'valuation_as_of', 'cash_confirmed_at',
    ]));
  });

  it('builds a cross-month household cash plan from budgets and large memos', () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const category = db.prepare("SELECT id FROM household_categories WHERE name='家庭生活费'").get().id;
    db.prepare(`
      UPDATE household_plan_settings
      SET opening_amount = 10000, opening_currency_id = ?, planning_rate_to_cny = 1,
          start_month = '2032-01', end_month = '2032-02'
      WHERE id = 1
    `).run(cny);
    db.prepare(`INSERT INTO monthly_budgets (month, category_id, planned_amount_cny) VALUES ('2032-01', ?, 1000)`).run(category);
    expect(wealth.getHouseholdSummary('2031-12').navigation).toMatchObject({ nextPlannedMonth: '2032-01' });
    const memo = db.prepare(`
      INSERT INTO financial_memos (kind, title, expected_amount, currency_id, due_date, status)
      VALUES ('expense', 'Plan test memo', 500, ?, '2032-02-10', 'pending')
    `).run(cny);

    const plan = wealth.getHouseholdPlan();
    expect(plan.totals).toMatchObject({ openingBalanceCny: 10000, plannedExpenseCny: 1000, memoExpenseCny: 500, projectedClosingBalanceCny: 8500 });
    expect(plan.months.map((row: any) => row.closingBalanceCny)).toEqual([9000, 8500]);
    expect(plan.livingExpenseBasis).toMatchObject({
      categoryName: '家庭生活费', monthlyAmountCny: 1000,
      monthlyAmountInOpeningCurrency: 1000, plannedMonths: 1, source: 'monthly_budget',
    });

    db.prepare('DELETE FROM financial_memos WHERE id = ?').run(Number(memo.lastInsertRowid));
    db.prepare("DELETE FROM monthly_budgets WHERE month IN ('2032-01', '2032-02')").run();
  });

  it('uses Europe/London for daily snapshot boundaries', () => {
    expect(wealth.londonDate(new Date('2026-08-27T23:30:00Z'))).toBe('2026-08-28');
  });

  it('counts an empty active account in the household dashboard', () => {
    const accountId = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('New Empty Account', 'bank')").run().lastInsertRowid);
    try {
      expect(wealth.getDashboard().totals).toMatchObject({ accountCount: 1, assetCount: 0 });
      db.prepare('UPDATE platforms SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(accountId);
      expect(wealth.getDashboard().totals.accountCount).toBe(0);
    } finally {
      db.prepare('DELETE FROM platforms WHERE id = ?').run(accountId);
    }
  });

  it('refreshes imported instruments only when they have a real quote code', () => {
    expect(wealth.quoteCodeForAsset({ code: 'SQT-XLSX-9', quote_code: '000218' })).toBe('000218');
    expect(wealth.isMarketRefreshCandidate({
      code: 'SQT-XLSX-9', quote_code: '000218', asset_type_name: 'fund', external_source: 'manual_import',
    })).toBe(true);
    expect(wealth.isMarketRefreshCandidate({
      code: 'SQT-XLSX-9', quote_code: null, asset_type_name: 'fund', external_source: 'manual_import',
    })).toBe(false);
    expect(wealth.isMarketRefreshCandidate({
      code: 'AAPL', quote_code: 'AAPL', asset_type_name: 'stock_us', external_source: 'trading212',
    })).toBe(false);
    expect(wealth.quoteTypeForAsset({
      quote_code: '009478', asset_type_name: '纸黄金', external_source: 'manual_import',
    })).toBe('fund');
  });

  it('uses one valuation service for class and account totals', () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const cashType = db.prepare("SELECT id FROM asset_types WHERE name='cash'").get().id;
    const account = db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Test Bank', 'bank')").run();
    db.prepare('INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('CASH-TEST', 'Test Cash', 1000, 1, cashType, Number(account.lastInsertRowid), cny);
    const dashboard = wealth.getDashboard({ month: '2026-08', range: 'ALL' });
    const byClass = dashboard.allocations.byClass.reduce((sum: number, row: any) => sum + row.valueCny, 0);
    const byAccount = dashboard.allocations.byAccount.reduce((sum: number, row: any) => sum + row.valueCny, 0);
    expect(dashboard.totals.marketValueCny).toBe(1000);
    expect(byClass).toBe(byAccount);
  });

  it('keeps household spending separate from asset value', () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const category = db.prepare("SELECT id FROM household_categories WHERE kind='expense' LIMIT 1").get().id;
    const account = db.prepare("SELECT id FROM platforms WHERE name='Test Bank'").get().id;
    db.prepare(`INSERT INTO household_transactions (kind, amount, currency_id, fx_rate_to_cny, amount_cny, category_id, account_id, occurred_on) VALUES ('expense', 80, ?, 1, 80, ?, ?, '2026-08-10')`)
      .run(cny, category, account);
    const dashboard = wealth.getDashboard({ range: 'ALL' });
    expect(dashboard.totals.marketValueCny).toBe(1000);
    expect(dashboard.household).toBeUndefined();
    const summary = wealth.getHouseholdSummary('2026-08');
    expect(summary.totals.expense).toBe(80);
    const categorySummary = summary.budgets.find((row: any) => row.categoryId === category);
    expect(categorySummary).toMatchObject({ planned: 0, actual: 80, remaining: -80 });
  });

  it('reports investment profit inside the fund allocation', () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const fundType = db.prepare("SELECT id FROM asset_types WHERE name='fund'").get().id;
    const account = db.prepare("SELECT id FROM platforms WHERE name='Test Bank'").get().id;
    const asset = db.prepare('INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('TEST-FUND', 'Test Fund', 10, 8, fundType, account, cny);
    db.prepare(`INSERT INTO quote_cache (cache_key, code, asset_type, price, currency_code, status) VALUES ('TEST-FUND_fund', 'TEST-FUND', 'fund', 10, 'CNY', 'fresh')`).run();

    const dashboard = wealth.getDashboard({ month: '2026-08', range: 'ALL' });
    const fund = dashboard.allocations.byClass.find((row: any) => row.code === 'fund');
    expect(fund).toMatchObject({ valueCny: 100, costValueCny: 80, profitCny: 20, profitPercent: 25 });

    db.prepare('DELETE FROM assets WHERE id = ?').run(Number(asset.lastInsertRowid));
    db.prepare("DELETE FROM quote_cache WHERE cache_key = 'TEST-FUND_fund'").run();
  });

  it('uses a live quote and quantity instead of a spreadsheet position value', () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const fundType = db.prepare("SELECT id FROM asset_types WHERE name='fund'").get().id;
    const account = db.prepare("SELECT id FROM platforms WHERE name='Test Bank'").get().id;
    const asset = db.prepare(`
      INSERT INTO assets (
        code, name, shares, cost_price, asset_type_id, platform_id, currency_id,
        external_source, quote_code, valuation_mode, quantity_status, imported_market_value, imported_cost_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_import', '001234', 'position_value', 'estimated', 125, 100)
    `).run('LEGACY-POSITION', 'Legacy Position', 50, 2, fundType, account, cny);
    db.prepare(`
      INSERT INTO quote_cache (cache_key, code, asset_type, price, currency_code, source, status)
      VALUES ('001234_fund', '001234', 'fund', 3, 'CNY', 'market-provider', 'fresh')
    `).run();

    const valued = wealth.valueAssets().find((row: any) => row.id === Number(asset.lastInsertRowid));
    expect(valued).toMatchObject({
      currentPrice: 3,
      marketValueCny: 150,
      costValueCny: 100,
      quantityStatus: 'estimated',
      valuationMode: 'position_value',
      valuationBasis: 'unit_price',
      quote: { status: 'fresh' },
      dataQuality: {
        status: 'attention',
        label: '份额为估算值',
        issues: expect.arrayContaining(['estimated_quantity']),
      },
    });

    db.prepare('DELETE FROM assets WHERE id = ?').run(Number(asset.lastInsertRowid));
    db.prepare("DELETE FROM quote_cache WHERE cache_key = '001234_fund'").run();
  });

  it('keeps an unidentifiable spreadsheet position as reference only', () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const fundType = db.prepare("SELECT id FROM asset_types WHERE name='fund'").get().id;
    const account = db.prepare("SELECT id FROM platforms WHERE name='Test Bank'").get().id;
    const inserted = db.prepare(`
      INSERT INTO assets (
        code, name, shares, cost_price, asset_type_id, platform_id, currency_id,
        external_source, valuation_mode, quantity_status, imported_market_value, imported_cost_value
      ) VALUES ('NO-CODE-POSITION', 'No code position', 1, 100, ?, ?, ?, 'manual_import', 'position_value', 'missing', 125, 100)
    `).run(fundType, account, cny);
    const valued = wealth.valueAssets().find((row: any) => row.id === Number(inserted.lastInsertRowid));
    expect(valued).toMatchObject({
      currentPrice: null, marketValueCny: 0, costValueCny: 0,
      importedMarketValue: 125, valuationBasis: 'reference_only',
      dataQuality: { status: 'blocked', label: '缺少行情代码' },
    });
    db.prepare('DELETE FROM assets WHERE id = ?').run(Number(inserted.lastInsertRowid));
  });

  it('deletes a household transaction through the API and removes it from the month list', async () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const category = db.prepare("SELECT id FROM household_categories WHERE kind='expense' LIMIT 1").get().id;
    const inserted = db.prepare(`
      INSERT INTO household_transactions
        (kind, amount, currency_id, fx_rate_to_cny, amount_cny, category_id, occurred_on, note)
      VALUES ('expense', 12.34, ?, 1, 12.34, ?, '2031-04-18', 'DELETE-ROUTE-TEST')
    `).run(cny, category);
    const id = Number(inserted.lastInsertRowid);

    const deleted = await fetch(`${apiBaseUrl}/household/transactions/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(deleted.status).toBe(204);

    const response = await fetch(`${apiBaseUrl}/household/transactions?month=2031-04`);
    const payload = await response.json();
    expect(payload.data.some((row: any) => row.id === id)).toBe(false);
    expect(db.prepare('SELECT archived_at FROM household_transactions WHERE id = ?').get(id).archived_at).toBeTruthy();
  });

  it('edits and archives an existing account without changing its identity', async () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const created = await fetch(`${apiBaseUrl}/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Maintenance account', account_type: 'bank', default_currency_id: cny }),
    });
    expect(created.status).toBe(201);
    const account = (await created.json()).data;
    const updated = await fetch(`${apiBaseUrl}/accounts/${account.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Maintenance account · savings', account_type: 'cash' }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ id: account.id, name: 'Maintenance account · savings', account_type: 'cash' });

    const duplicate = await fetch(`${apiBaseUrl}/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Maintenance account · savings', account_type: 'cash', default_currency_id: cny }),
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('ACCOUNT_NAME_EXISTS');

    const archived = await fetch(`${apiBaseUrl}/accounts/${account.id}`, { method: 'DELETE' });
    expect(archived.status).toBe(204);
    expect(db.prepare('SELECT archived_at FROM platforms WHERE id = ?').get(account.id).archived_at).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) count FROM platforms WHERE id = ?').get(account.id).count).toBe(1);

    const archivedList = await fetch(`${apiBaseUrl}/accounts?archived=1`);
    expect((await archivedList.json()).data.some((row: any) => row.id === account.id)).toBe(true);
    const restored = await fetch(`${apiBaseUrl}/accounts/${account.id}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data).toMatchObject({ id: account.id, archived_at: null });
  });

  it('confirms cash balance on the same asset without adding a second position', async () => {
    const cny = db.prepare("SELECT id FROM currencies WHERE code='CNY'").get().id;
    const cashType = db.prepare("SELECT id FROM asset_types WHERE name='cash'").get().id;
    const fundType = db.prepare("SELECT id FROM asset_types WHERE name='fund'").get().id;
    const accountId = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Balance test account', 'bank')").run().lastInsertRowid);
    const cashId = Number(db.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id)
      VALUES ('CASH-BALANCE-TEST', 'Balance test cash', 100, 1, ?, ?, ?)
    `).run(cashType, accountId, cny).lastInsertRowid);
    const fundId = Number(db.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id)
      VALUES ('FUND-BALANCE-TEST', 'Balance test fund', 1, 10, ?, ?, ?)
    `).run(fundType, accountId, cny).lastInsertRowid);
    const beforeCount = db.prepare('SELECT COUNT(*) count FROM assets WHERE platform_id = ?').get(accountId).count;

    const archiveWithAssets = await fetch(`${apiBaseUrl}/accounts/${accountId}`, { method: 'DELETE' });
    expect(archiveWithAssets.status).toBe(409);
    expect(db.prepare('SELECT archived_at FROM platforms WHERE id = ?').get(accountId).archived_at).toBeNull();

    const rejected = await fetch(`${apiBaseUrl}/assets/${fundId}/cash-balance`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: 900, confirmed_on: '2026-09-01' }),
    });
    expect(rejected.status).toBe(400);

    db.prepare("UPDATE assets SET external_source = 'trading212' WHERE id = ?").run(cashId);
    const syncManaged = await fetch(`${apiBaseUrl}/assets/${cashId}/cash-balance`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: 900, confirmed_on: '2026-09-01' }),
    });
    expect(syncManaged.status).toBe(409);
    db.prepare('UPDATE assets SET external_source = NULL WHERE id = ?').run(cashId);

    const confirmed = await fetch(`${apiBaseUrl}/assets/${cashId}/cash-balance`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: 120.35, confirmed_on: '2026-09-01' }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).data).toMatchObject({ id: cashId, shares: 120.35, cash_confirmed_at: '2026-09-01' });
    expect(db.prepare('SELECT COUNT(*) count FROM assets WHERE platform_id = ?').get(accountId).count).toBe(beforeCount);
    expect(wealth.valueAssets().find((row: any) => row.id === cashId)).toMatchObject({
      marketValueCny: 120.35, costValueCny: 120.35, cashConfirmedAt: '2026-09-01',
    });
    const accounts = await fetch(`${apiBaseUrl}/accounts`);
    const account = (await accounts.json()).data.find((row: any) => row.id === accountId);
    expect(account.market_value_cny).toBe(120.35);

    // A negative cash balance represents an overdraft and reduces total wealth.
    const overdraft = await fetch(`${apiBaseUrl}/assets/${cashId}/cash-balance`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: -25.5, confirmed_on: '2026-09-02' }),
    });
    expect(overdraft.status).toBe(200);
    expect(wealth.valueAssets().find((row: any) => row.id === cashId).marketValueCny).toBe(-25.5);

    const editedElsewhere = await fetch(`${apiBaseUrl}/assets/${cashId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cost_price: 0.99 }),
    });
    expect(editedElsewhere.status).toBe(200);
    expect((await editedElsewhere.json()).data.cash_confirmed_at).toBeNull();
  });
});
