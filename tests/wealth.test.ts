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

beforeAll(() => {
  db = require('../src/services/database.cjs');
  wealth = require('../src/services/wealthService.cjs');
  trading212 = require('../src/services/trading212Service.cjs');
});

afterAll(() => {
  db?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${testDb}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

describe('asset classification', () => {
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
    expect(db.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count).toBeGreaterThanOrEqual(2);
    expect(db.prepare('SELECT COUNT(*) count FROM household_categories').get().count).toBeGreaterThan(5);
  });

  it('uses Europe/London for daily snapshot boundaries', () => {
    expect(wealth.londonDate(new Date('2026-08-27T23:30:00Z'))).toBe('2026-08-28');
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
    const dashboard = wealth.getDashboard({ month: '2026-08', range: 'ALL' });
    expect(dashboard.household.totals.expense).toBe(80);
    expect(dashboard.totals.marketValueCny).toBe(1000);
  });
});
