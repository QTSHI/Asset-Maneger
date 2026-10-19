import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-csv-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(temporaryDirectory, 'export-test.sqlite');
let db: any;
let server: any;
let baseUrl: string;
let accountId: number;
let assetId: number;
let transactionId: number;
let flowId: number;

// A parser independent of the serializer, including quoted multiline records.
function parseCsv(csv: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = csv.startsWith('\uFEFF') ? 1 : 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { record.push(field); field = ''; }
    else if (char === '\r' && csv[i + 1] === '\n' && !quoted) {
      record.push(field); records.push(record); record = []; field = ''; i++;
    } else field += char;
  }
  return records;
}

async function csvRequest(route: string) {
  const response = await fetch(`${baseUrl}${route}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const csv = bytes.toString('utf8');
  const [headers, ...rows] = parseCsv(csv);
  return {
    response, bytes, csv, rows,
    records: rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]]))),
  };
}

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  const currencyId = Number(db.prepare("INSERT INTO currencies (code) VALUES ('ZZZ')").run().lastInsertRowid);
  const cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
  const typeId = db.prepare("SELECT id FROM asset_types WHERE name = 'stock_us'").get().id;
  const categoryId = db.prepare("SELECT id FROM household_categories WHERE kind = 'expense' LIMIT 1").get().id;
  accountId = Number(db.prepare('INSERT INTO platforms (name, account_type, default_currency_id, created_by) VALUES (?, ?, ?, ?)')
    .run(' \t\u200B=HYPERLINK("https://example.test")', 'bank', currencyId, 'private-sso-user').lastInsertRowid);
  const archivedAccount = Number(db.prepare('INSERT INTO platforms (name, archived_at) VALUES (?, ?)')
    .run('不导出的归档账户', '2033-01-01').lastInsertRowid);
  const insertAsset = db.prepare(`INSERT INTO assets
    (platform_id, asset_type_id, currency_id, code, name, shares, cost_price, archived_at, quote_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  assetId = Number(insertAsset.run(accountId, typeId, currencyId, '-ASSET', '中文"资产,\n多行名称', -12.5, null, null, null).lastInsertRowid);
  insertAsset.run(accountId, typeId, cny, 'ARCHIVED-ASSET', '已归档资产', 2, 4, '2033-01-01', null);
  insertAsset.run(archivedAccount, typeId, cny, 'ARCHIVED-ACCOUNT-ASSET', '归档账户持仓', 1, 3, null, null);
  insertAsset.run(accountId, typeId, cny, 'QUOTED', '有行情', 2, 3, null, 'QUOTE');
  db.prepare(`INSERT INTO quote_cache (cache_key, code, asset_type, price, currency_code, source, status, fetched_at)
    VALUES ('QUOTE_stock_us', 'QUOTE', 'stock_us', 4.25, 'CNY', 'fixture', 'stale', '2033-03-01')`).run();
  flowId = Number(db.prepare(`INSERT INTO cash_flows
    (flow_type, amount, currency_id, account_id, occurred_on, note) VALUES ('withdrawal', 7, ?, ?, '2033-03-02', 'linked flow')`)
    .run(currencyId, accountId).lastInsertRowid);
  const insertTransaction = db.prepare(`INSERT INTO household_transactions
    (kind, amount, currency_id, fx_rate_to_cny, amount_cny, category_id, account_id, occurred_on, note, archived_at, linked_cash_flow_id)
    VALUES ('expense', 7, ?, 2.5, 17.5, ?, ?, ?, ?, ?, ?)`);
  transactionId = Number(insertTransaction.run(currencyId, categoryId, accountId, '2033-03-02', '\r\n=SUM(1,2) 中文"备注', null, flowId).lastInsertRowid);
  insertTransaction.run(currencyId, categoryId, archivedAccount, '2033-03-03', '保留归档账户历史收支', null, null);
  insertTransaction.run(currencyId, categoryId, accountId, '2033-04-01', '另一个月', null, null);
  insertTransaction.run(currencyId, categoryId, accountId, '2033-03-04', '已归档收支', '2033-03-05', null);
  const express = require('express');
  const app = express();
  app.use('/api/v2/exports', require('../src/routes/exports.cjs'));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v2/exports`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(resolve));
  db?.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('portable authenticated CSV export payloads', () => {
  it('sets UTF-8 BOM, Chinese headers, CRLF and private download headers without auth fields', async () => {
    const result = await csvRequest('/accounts.csv');
    expect(result.response.status).toBe(200);
    expect([...result.bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
    expect(result.response.headers.get('content-type')).toMatch(/^text\/csv; charset=utf-8/);
    expect(result.response.headers.get('cache-control')).toContain('no-store');
    expect(result.response.headers.get('content-disposition')).toBe('attachment; filename="stone-wealth-accounts-active.csv"');
    expect(result.csv).toContain('"账户ID","账户名称"');
    expect(result.csv.endsWith('\r\n')).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ 账户ID: String(accountId), 默认币种: 'ZZZ', 账户名称: '\' \t\u200B=HYPERLINK("https://example.test")' });
    expect(result.csv).not.toMatch(/password|token|private-sso-user|归档账户/);
  });

  it('exports raw quantities with numeric negatives and blank missing quote/FX instead of failing or claiming zero', async () => {
    const result = await csvRequest('/assets.csv');
    expect(result.response.status).toBe(200);
    expect(result.records).toHaveLength(2);
    const missing = result.records.find((record) => record.资产ID === String(assetId))!;
    expect(missing).toMatchObject({
      资产代码: "'-ASSET", 资产名称: '中文"资产,\n多行名称', 数量: '-12.5', 币种: 'ZZZ',
      '单位成本(原币)': '', '缓存单位行情(原币,缺失留空)': '', 行情状态: 'missing',
      '缓存兑人民币汇率(缺失留空)': '', 汇率状态: 'missing',
    });
    expect(result.csv).toContain(',-12.5,');
    expect(result.csv).not.toContain('ARCHIVED-');
    expect(result.records.find((record) => record.资产代码 === 'QUOTED')).toMatchObject({
      '缓存单位行情(原币,缺失留空)': '4.25', 行情状态: 'stale',
      '缓存兑人民币汇率(缺失留空)': '1', 汇率状态: 'fixed',
    });
  });

  it('filters transactions by month, retains historical rates/links and excludes deleted entries', async () => {
    const result = await csvRequest('/transactions.csv?month=2033-03');
    expect(result.response.status).toBe(200);
    expect(result.records).toHaveLength(2);
    expect(result.records.find((row) => row.收支ID === String(transactionId))).toMatchObject({
      '记账时兑人民币汇率': '2.5', '记账金额(人民币)': '17.5', 关联资金流ID: String(flowId),
      备注: "'\r\n=SUM(1,2) 中文\"备注",
    });
    expect(result.csv).not.toMatch(/已归档收支|另一个月/);
    expect(result.records[1]).toMatchObject({ 账户归档时间: '2033-01-01', 备注: '保留归档账户历史收支' });
    expect((await csvRequest('/transactions.csv')).records).toHaveLength(3);
    expect((await csvRequest('/transactions.csv?month=2033-05')).records).toHaveLength(0);
  });

  it('rejects malformed/duplicate months as structured errors with no-store', async () => {
    for (const query of ['2033-13', '2033-00', '2033-3', '=1', '2033-03&month=2033-04']) {
      const response = await fetch(`${baseUrl}/transactions.csv?month=${query}`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_MONTH');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('content-disposition')).toBeNull();
    }
  });

  it('neutralizes formulas after whitespace/control characters and preserves actual numbers', () => {
    const { csvCell } = require('../src/services/exportService.cjs');
    for (const text of ['=2', '+2', '-2', '@SUM(2)', ' \t=2', '\uFEFF\u0000\u200B-2', '\r\n+2']) {
      expect(csvCell(text).startsWith('"\'')).toBe(true);
    }
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell('plain "text", 中文')).toBe('"plain ""text"", 中文"');
    expect(csvCell(null)).toBe('""');
  });
});
