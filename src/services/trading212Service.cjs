const https = require('https');
const db = require('./database.cjs');
const { T212_KEY, T212_SECRET } = require('../config/constants.cjs');

const HOST = 'live.trading212.com';
const BASE = '/api/v0';

function configured() {
  return Boolean(T212_KEY && T212_SECRET);
}

function request(apiPath) {
  if (!configured()) return Promise.reject(new Error('Trading212 API 凭据未配置'));
  const authorization = `Basic ${Buffer.from(`${T212_KEY}:${T212_SECRET}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, path: `${BASE}${apiPath}`, method: 'GET', timeout: 12_000, headers: { Authorization: authorization, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Trading212 HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Trading212 响应无法解析')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Trading212 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function setStatus(state, message, details = null, success = false) {
  db.prepare(`
    INSERT INTO integration_status (integration_key, state, last_started_at, last_success_at, message, details_json)
    VALUES ('trading212', ?, CURRENT_TIMESTAMP, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)
    ON CONFLICT(integration_key) DO UPDATE SET
      state = excluded.state,
      last_started_at = CASE WHEN excluded.state = 'running' THEN CURRENT_TIMESTAMP ELSE integration_status.last_started_at END,
      last_success_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE integration_status.last_success_at END,
      message = excluded.message,
      details_json = excluded.details_json
  `).run(state, success ? 1 : 0, message, details ? JSON.stringify(details) : null, success ? 1 : 0);
}

function getStatus() {
  const row = db.prepare("SELECT * FROM integration_status WHERE integration_key = 'trading212'").get();
  const aggregate = db.prepare("SELECT id, updated_at FROM assets WHERE code = 'T212-TOTAL' AND archived_at IS NULL").get();
  return {
    configured: configured(),
    detailedSyncAvailable: configured(),
    aggregateFallback: Boolean(aggregate),
    state: row?.state || 'idle',
    message: row?.message || null,
    lastStartedAt: row?.last_started_at || null,
    lastSuccessAt: row?.last_success_at || null,
    details: row?.details_json ? JSON.parse(row.details_json) : null
  };
}

function pickNumber(...values) {
  for (const value of values) if (Number.isFinite(Number(value))) return Number(value);
  return null;
}

function accountSummaryValues(summary) {
  const cash = pickNumber(summary?.cash?.free, summary?.cash?.availableToTrade, summary?.cash?.available, summary?.free, summary?.cashBalance);
  const total = pickNumber(summary?.totalValue, summary?.total, summary?.accountValue);
  const currency = summary?.currency || summary?.currencyCode || summary?.account?.currency || 'GBP';
  if (cash === null || total === null) throw new Error('Trading212 账户摘要字段不完整');
  return { cash, total, currency };
}

function ensureCurrency(code) {
  const normalized = String(code || 'GBP').toUpperCase();
  let row = db.prepare('SELECT id, code FROM currencies WHERE code = ?').get(normalized);
  if (!row) {
    const result = db.prepare('INSERT INTO currencies (code) VALUES (?)').run(normalized);
    row = { id: Number(result.lastInsertRowid), code: normalized };
  }
  return row;
}

function ensurePlatform(currencyId, actor) {
  let platform = db.prepare("SELECT * FROM platforms WHERE (external_source = 'trading212' OR name = 'Trading212') AND archived_at IS NULL ORDER BY external_source DESC LIMIT 1").get();
  if (!platform) {
    const result = db.prepare(`
      INSERT INTO platforms (name, category, default_currency_id, account_type, external_source, created_by, updated_by, updated_at)
      VALUES ('Trading212', '投资类', ?, 'investment', 'trading212', ?, ?, CURRENT_TIMESTAMP)
    `).run(currencyId, actor, actor);
    platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(Number(result.lastInsertRowid));
  } else {
    db.prepare("UPDATE platforms SET external_source = 'trading212', default_currency_id = COALESCE(default_currency_id, ?), updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(currencyId, actor, platform.id);
  }
  return platform;
}

function typeForInstrument(instrument = {}) {
  const rawType = String(instrument.type || '').toUpperCase();
  if (rawType.includes('ETF') || rawType.includes('ETC')) return 'etf';
  if (rawType.includes('EQUITY') || rawType.includes('STOCK') || rawType.includes('SHARE')) {
    const ticker = String(instrument.ticker || '');
    const currency = String(instrument.currencyCode || instrument.currency || '').toUpperCase();
    if (ticker.includes('_US_') || currency === 'USD') return 'stock_us';
    if (ticker.includes('_GB_') || currency === 'GBP') return 'stock_uk';
    return 'stock_us';
  }
  return 'unclassified';
}

async function sync(actor = 'system') {
  if (!configured()) throw new Error('Trading212 API 凭据未配置');
  const existing = getStatus();
  if (existing.state === 'running') return existing;
  setStatus('running', '正在获取账户摘要与持仓');

  try {
    const [summaryRaw, positionsRaw] = await Promise.all([
      request('/equity/account/summary').catch(() => request('/equity/account/cash')),
      request('/equity/positions').catch(() => request('/equity/portfolio'))
    ]);
    const summary = accountSummaryValues(summaryRaw);
    const positions = Array.isArray(positionsRaw) ? positionsRaw : (positionsRaw?.items || []);
    const accountCurrency = ensureCurrency(summary.currency);
    const platform = ensurePlatform(accountCurrency.id, actor);

    const normalized = positions.map((position) => {
      const instrument = position.instrument || {};
      const ticker = instrument.ticker || position.ticker;
      if (!ticker) throw new Error('Trading212 持仓缺少 ticker');
      const quantity = pickNumber(position.quantity, 0) || 0;
      const average = pickNumber(position.averagePricePaid, position.averagePrice, 0) || 0;
      const current = pickNumber(position.currentPrice, position.price, 0) || 0;
      const walletValue = pickNumber(position.walletImpact?.currentValue, position.walletImpact?.totalValue, position.currentValue);
      const currencyCode = instrument.currencyCode || instrument.currency || summary.currency;
      return {
        externalId: String(ticker),
        code: String(ticker),
        name: instrument.name || instrument.shortName || position.name || String(ticker),
        typeName: typeForInstrument(instrument),
        quantity,
        average,
        current,
        walletValue: walletValue ?? quantity * current,
        currencyCode
      };
    });

    const calculated = summary.cash + normalized.reduce((sum, item) => sum + item.walletValue, 0);
    const difference = calculated - summary.total;
    const tolerance = Math.max(5, Math.abs(summary.total) * 0.02);
    if (Math.abs(difference) > tolerance) {
      const details = { total: summary.total, cash: summary.cash, positions: normalized.length, calculated, difference, tolerance };
      setStatus('error', '账户总值对账未通过，已保留旧汇总项', details);
      throw new Error('Trading212 详细持仓与账户总值不一致');
    }

    const findType = db.prepare('SELECT id FROM asset_types WHERE name = ?');
    const upsertAsset = db.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id, currency_id, external_source, external_id, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'trading212', ?, ?, ?)
      ON CONFLICT(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL DO UPDATE SET
        code = excluded.code, name = excluded.name, shares = excluded.shares, cost_price = excluded.cost_price,
        asset_type_id = excluded.asset_type_id, platform_id = excluded.platform_id, currency_id = excluded.currency_id,
        archived_at = NULL, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
    `);
    const upsertQuote = db.prepare(`
      INSERT INTO quote_cache (cache_key, code, asset_type, price, currency_code, source, status, fetched_at)
      VALUES (?, ?, ?, ?, ?, 'trading212', 'fresh', CURRENT_TIMESTAMP)
      ON CONFLICT(cache_key) DO UPDATE SET price = excluded.price, currency_code = excluded.currency_code, source = 'trading212', status = 'fresh', error_message = NULL, fetched_at = CURRENT_TIMESTAMP
    `);

    db.transaction(() => {
      const seen = [];
      for (const item of normalized) {
        const currency = ensureCurrency(item.currencyCode);
        const type = findType.get(item.typeName) || findType.get('unclassified');
        upsertAsset.run(item.code, item.name, item.quantity, item.average, type.id, platform.id, currency.id, item.externalId, actor, actor);
        upsertQuote.run(`${item.code}_${item.typeName}`, item.code, item.typeName, item.current, currency.code);
        seen.push(item.externalId);
      }

      const cashType = findType.get('cash');
      upsertAsset.run('T212-CASH', 'Trading212 现金', summary.cash, 1, cashType.id, platform.id, accountCurrency.id, 'cash', actor, actor);
      upsertQuote.run('T212-CASH_cash', 'T212-CASH', 'cash', 1, accountCurrency.code);
      seen.push('cash');

      const externalAssets = db.prepare("SELECT id, external_id FROM assets WHERE external_source = 'trading212' AND archived_at IS NULL").all();
      const archive = db.prepare('UPDATE assets SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      for (const asset of externalAssets) if (!seen.includes(asset.external_id)) archive.run(actor, asset.id);
      db.prepare("UPDATE assets SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE code = 'T212-TOTAL' AND archived_at IS NULL").run(actor);
    })();

    const details = { total: summary.total, cash: summary.cash, positions: normalized.length, calculated, difference, tolerance };
    setStatus('success', `已同步 ${normalized.length} 项持仓与现金余额`, details, true);
    return getStatus();
  } catch (error) {
    if (getStatus().state !== 'error') setStatus('error', error.message);
    throw error;
  }
}

module.exports = { configured, getStatus, sync, typeForInstrument, accountSummaryValues };
