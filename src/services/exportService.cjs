const db = require('./database.cjs');

// Keep text as text when a CSV is opened in a spreadsheet. Quoting alone does
// not stop spreadsheet formula execution, including after ignored prefixes.
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '""';
  let text = String(value);
  if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  return '\uFEFF' + [
    columns.map(([label]) => csvCell(label)).join(','),
    ...rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(',')),
  ].join('\r\n') + '\r\n';
}

const accountColumns = [
  ['账户ID', 'id'], ['账户名称', 'name'], ['账户类型', 'account_type'],
  ['分类', 'category'], ['默认币种ID', 'default_currency_id'], ['默认币种', 'currency_code'],
  ['数据来源', 'external_source'], ['更新时间', 'updated_at'],
];

const assetColumns = [
  ['资产ID', 'id'], ['账户ID', 'platform_id'], ['账户名称', 'account_name'],
  ['资产代码', 'code'], ['资产名称', 'name'], ['资产类型ID', 'asset_type_id'],
  ['资产类型', 'asset_type_name'], ['资产大类', 'asset_class_code'], ['资产子类', 'asset_subtype_code'],
  ['币种ID', 'currency_id'], ['币种', 'currency_code'], ['数量', 'shares'],
  ['单位成本(原币)', 'cost_price'], ['数量确认状态', 'quantity_status'], ['估值模式', 'valuation_mode'],
  ['导入市值(原币参考值)', 'imported_market_value'], ['导入成本(原币参考值)', 'imported_cost_value'],
  ['参考估值日期', 'valuation_as_of'], ['行情代码', 'quote_code'],
  ['缓存单位行情(原币,缺失留空)', 'cached_price'], ['行情状态', 'quote_status'],
  ['行情来源', 'quote_source'], ['行情更新时间', 'quote_fetched_at'],
  ['缓存兑人民币汇率(缺失留空)', 'cached_fx_rate'], ['汇率状态', 'fx_status'],
  ['汇率更新时间', 'fx_fetched_at'], ['现金余额确认时间', 'cash_confirmed_at'],
  ['数据来源', 'external_source'], ['外部记录ID', 'external_id'],
  ['创建时间', 'created_at'], ['更新时间', 'updated_at'],
];

const transactionColumns = [
  ['收支ID', 'id'], ['收支类型', 'kind'], ['发生日期', 'occurred_on'],
  ['金额(原币)', 'amount'], ['币种ID', 'currency_id'], ['币种', 'currency_code'],
  ['记账时兑人民币汇率', 'fx_rate_to_cny'], ['记账金额(人民币)', 'amount_cny'],
  ['分类ID', 'category_id'], ['分类名称', 'category_name'],
  ['账户ID', 'account_id'], ['账户名称', 'account_name'], ['账户归档时间', 'account_archived_at'],
  ['项目ID', 'project_id'], ['备注', 'note'], ['关联资金流ID', 'linked_cash_flow_id'],
  ['关联资金流归档时间', 'linked_flow_archived_at'], ['创建时间', 'created_at'], ['更新时间', 'updated_at'],
];

function exportAccounts() {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.account_type, p.category, p.default_currency_id,
           c.code AS currency_code, p.external_source, p.updated_at
    FROM platforms p
    LEFT JOIN currencies c ON c.id = p.default_currency_id
    WHERE p.archived_at IS NULL ORDER BY p.id
  `).all();
  return toCsv(accountColumns, rows);
}

function exportAssets() {
  // Export stored original-currency fields even when valuations are incomplete.
  // Never call valueAssets(): a missing FX rate must not prevent a data backup.
  const rows = db.prepare(`
    SELECT a.*, p.name AS account_name, c.code AS currency_code,
           at.name AS asset_type_name, at.asset_class_code, at.asset_subtype_code,
           COALESCE(live_q.price, imported_q.price) AS cached_price,
           COALESCE(live_q.status, imported_q.status, 'missing') AS quote_status,
           COALESCE(live_q.source, imported_q.source) AS quote_source,
           COALESCE(live_q.fetched_at, imported_q.fetched_at) AS quote_fetched_at,
           CASE WHEN c.code = 'CNY' THEN 1 WHEN fx.rate_to_cny > 0 THEN fx.rate_to_cny END AS cached_fx_rate,
           CASE WHEN c.code = 'CNY' THEN 'fixed' WHEN fx.rate_to_cny > 0 THEN fx.status ELSE 'missing' END AS fx_status,
           CASE WHEN c.code <> 'CNY' THEN fx.fetched_at END AS fx_fetched_at
    FROM assets a
    JOIN platforms p ON p.id = a.platform_id
    LEFT JOIN currencies c ON c.id = a.currency_id
    LEFT JOIN asset_types at ON at.id = a.asset_type_id
    LEFT JOIN quote_cache live_q
      ON live_q.cache_key = COALESCE(NULLIF(a.quote_code, ''), a.code) || '_' ||
         CASE WHEN a.external_source = 'manual_import' AND at.name IN ('纸黄金', 'gold_paper')
                   AND length(COALESCE(a.quote_code, '')) = 6 THEN 'fund' ELSE at.name END
     AND (a.external_source IS NULL OR a.external_source <> 'manual_import' OR NULLIF(a.quote_code, '') IS NOT NULL)
    LEFT JOIN quote_cache imported_q
      ON imported_q.cache_key = a.code || '_' || at.name
     AND (a.external_source IS NULL OR a.external_source <> 'manual_import')
    LEFT JOIN exchange_rate_cache fx ON fx.currency_code = c.code
    WHERE a.archived_at IS NULL AND p.archived_at IS NULL
    ORDER BY a.id
  `).all();
  return toCsv(assetColumns, rows);
}

function exportTransactions(month) {
  const rows = db.prepare(`
    SELECT t.*, c.code AS currency_code, hc.name AS category_name,
           p.name AS account_name, p.archived_at AS account_archived_at,
           cf.archived_at AS linked_flow_archived_at
    FROM household_transactions t
    LEFT JOIN currencies c ON c.id = t.currency_id
    LEFT JOIN household_categories hc ON hc.id = t.category_id
    LEFT JOIN platforms p ON p.id = t.account_id
    LEFT JOIN cash_flows cf ON cf.id = t.linked_cash_flow_id
    WHERE t.archived_at IS NULL ${month ? "AND substr(t.occurred_on, 1, 7) = ?" : ''}
    ORDER BY t.occurred_on, t.id
  `).all(...(month ? [month] : []));
  return toCsv(transactionColumns, rows);
}

module.exports = { csvCell, toCsv, exportAccounts, exportAssets, exportTransactions };
