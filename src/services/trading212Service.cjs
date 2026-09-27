const https = require('https');
const crypto = require('crypto');
const db = require('./database.cjs');
const { getStoredRates } = require('./wealthService.cjs');
const { T212_KEY, T212_SECRET } = require('../config/constants.cjs');

const HOST = 'live.trading212.com';
const BASE = '/api/v0';
const STALE_RUNNING_MS = 2 * 60 * 1000;

function syncError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function configured() {
  return Boolean(T212_KEY && T212_SECRET);
}

function credentialFingerprint() {
  if (!configured()) return null;
  return crypto.createHash('sha256').update(T212_KEY).update('\0').update(T212_SECRET).digest('hex');
}

function request(apiPath) {
  if (!configured()) return Promise.reject(syncError('NOT_CONFIGURED', 'Trading212 API 凭据未配置', 400));
  const authorization = `Basic ${Buffer.from(`${T212_KEY}:${T212_SECRET}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, path: `${BASE}${apiPath}`, method: 'GET', timeout: 12_000, headers: { Authorization: authorization, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(syncError('AUTH_FAILED', 'Trading212 凭据验证失败，请检查 API Key 和 Secret'));
        }
        if (res.statusCode === 429) return reject(syncError('RATE_LIMITED', 'Trading212 请求过于频繁，请稍后重试', 503));
        if (res.statusCode === 404) return reject(syncError('ENDPOINT_NOT_FOUND', 'Trading212 接口不可用'));
        if (res.statusCode >= 500) return reject(syncError('SERVICE_UNAVAILABLE', 'Trading212 服务暂时不可用，请稍后重试', 503));
        if (res.statusCode !== 200) return reject(syncError('HTTP_ERROR', `Trading212 请求失败（HTTP ${res.statusCode}）`));
        try { resolve(JSON.parse(body)); } catch { reject(syncError('INVALID_RESPONSE', 'Trading212 响应无法解析')); }
      });
    });
    req.on('timeout', () => req.destroy(syncError('TIMEOUT', 'Trading212 请求超时，请稍后重试', 503)));
    req.on('error', (error) => reject(error.code === 'TIMEOUT'
      ? error
      : syncError('NETWORK_ERROR', '无法连接 Trading212，请检查网络后重试', 503)));
    req.end();
  });
}

function requestWithFallback(primary, fallback) {
  return request(primary).catch((error) => {
    if (error.code !== 'ENDPOINT_NOT_FOUND') throw error;
    return request(fallback);
  });
}

function setStatus(state, message, details = null, success = false) {
  // Keep enough information to invalidate an old status after credentials rotate,
  // without storing either credential in the integration status record.
  const storedDetails = { ...(details || {}), credentialFingerprint: credentialFingerprint() };
  db.prepare(`
    INSERT INTO integration_status (integration_key, state, last_started_at, last_success_at, message, details_json)
    VALUES ('trading212', ?, CURRENT_TIMESTAMP, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?)
    ON CONFLICT(integration_key) DO UPDATE SET
      state = excluded.state,
      last_started_at = CASE WHEN excluded.state = 'running' THEN CURRENT_TIMESTAMP ELSE integration_status.last_started_at END,
      last_success_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE integration_status.last_success_at END,
      message = excluded.message,
      details_json = excluded.details_json
  `).run(state, success ? 1 : 0, message, JSON.stringify(storedDetails), success ? 1 : 0);
}

function getStatus() {
  const row = db.prepare("SELECT * FROM integration_status WHERE integration_key = 'trading212'").get();
  const aggregate = db.prepare("SELECT id, updated_at FROM assets WHERE code = 'T212-TOTAL' AND archived_at IS NULL").get();
  let details = null;
  try { details = row?.details_json ? JSON.parse(row.details_json) : null; } catch { /* Legacy status may be malformed. */ }
  const recordedFingerprint = details?.credentialFingerprint;
  if (details && typeof details === 'object') {
    const { credentialFingerprint: _privateFingerprint, ...publicDetails } = details;
    details = Object.keys(publicDetails).length ? publicDetails : null;
  }
  const isConfigured = configured();
  const legacyAuthError = /^Trading212 HTTP 40[13]$/.test(row?.message || '');
  const errorCode = row?.state === 'error' ? details?.errorCode || (legacyAuthError ? 'AUTH_FAILED' : 'SYNC_FAILED') : null;
  const checkedCurrentCredentials = Boolean(recordedFingerprint && recordedFingerprint === credentialFingerprint());
  const authenticationState = !isConfigured ? 'not_configured'
    : !checkedCurrentCredentials ? 'unknown'
      : errorCode === 'AUTH_FAILED' ? 'invalid'
        : row?.state === 'success' ? 'valid' : 'unknown';
  return {
    configured: isConfigured,
    authenticationState,
    lastErrorCode: errorCode,
    detailedSyncAvailable: authenticationState === 'valid',
    aggregateFallback: Boolean(aggregate),
    state: row?.state || 'idle',
    message: row?.message || null,
    lastStartedAt: row?.last_started_at || null,
    lastSuccessAt: row?.last_success_at || null,
    details
  };
}

function pickNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function parsePositions(value) {
  const positions = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(positions)) throw syncError('INVALID_RESPONSE', 'Trading212 持仓响应格式不正确');
  return positions;
}

function accountSummaryValues(summary) {
  const cash = pickNumber(summary?.cash?.free, summary?.cash?.availableToTrade, summary?.cash?.available, summary?.free, summary?.cashBalance);
  const total = pickNumber(summary?.totalValue, summary?.total, summary?.accountValue);
  const currency = summary?.currency || summary?.currencyCode || summary?.account?.currency || 'GBP';
  if (cash === null || total === null) throw syncError('INVALID_RESPONSE', 'Trading212 账户摘要字段不完整');
  return { cash, total, currency };
}

function normalizeCurrencyCode(code) {
  return String(code || 'GBP').trim().toUpperCase();
}

function requireValuationRates(codes) {
  const rates = getStoredRates();
  const missing = [...new Set(codes.map(normalizeCurrencyCode))]
    .filter((code) => code !== 'CNY' && (!Number.isFinite(rates[code]) || rates[code] <= 0));
  if (missing.length) {
    throw syncError('FX_RATE_UNAVAILABLE', `Trading212 币种 ${missing.join('、')} 缺少有效兑人民币汇率，已保留原有资产数据`, 422);
  }
}

function ensureCurrency(code) {
  const normalized = normalizeCurrencyCode(code);
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
  if (!configured()) throw syncError('NOT_CONFIGURED', 'Trading212 API 凭据未配置', 400);
  const existing = getStatus();
  const startedAt = existing.lastStartedAt && Date.parse(`${existing.lastStartedAt.replace(' ', 'T')}Z`);
  if (existing.state === 'running' && startedAt && Date.now() - startedAt < STALE_RUNNING_MS) return existing;
  setStatus('running', '正在获取账户摘要与持仓');

  try {
    const [summaryRaw, positionsRaw] = await Promise.all([
      requestWithFallback('/equity/account/summary', '/equity/account/cash'),
      requestWithFallback('/equity/positions', '/equity/portfolio')
    ]);
    const summary = accountSummaryValues(summaryRaw);
    const positions = parsePositions(positionsRaw);

    const normalized = positions.map((position) => {
      const instrument = position.instrument || {};
      const ticker = instrument.ticker || position.ticker;
      if (!ticker) throw syncError('INVALID_RESPONSE', 'Trading212 持仓缺少 ticker');
      const externalId = String(ticker);
      if (externalId === 'cash' || externalId === 'T212-TOTAL') {
        throw syncError('INVALID_RESPONSE', 'Trading212 持仓标识与保留资产冲突');
      }
      const quantity = pickNumber(position.quantity);
      const current = pickNumber(position.currentPrice, position.price);
      if (quantity === null || current === null) {
        throw syncError('INVALID_RESPONSE', 'Trading212 持仓数量或价格缺失');
      }
      const average = pickNumber(position.averagePricePaid, position.averagePrice, 0) || 0;
      const walletValue = pickNumber(position.walletImpact?.currentValue, position.walletImpact?.totalValue, position.currentValue);
      const currencyCode = instrument.currencyCode || instrument.currency || summary.currency;
      return {
        externalId,
        code: externalId,
        name: instrument.name || instrument.shortName || position.name || externalId,
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
      const error = syncError('RECONCILIATION_FAILED', 'Trading212 详细持仓与账户总值不一致，已保留原有资产数据', 422);
      error.details = details;
      throw error;
    }
    requireValuationRates([summary.currency, ...normalized.map((item) => item.currencyCode)]);

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
      const accountCurrency = ensureCurrency(summary.currency);
      const platform = ensurePlatform(accountCurrency.id, actor);
      const seen = new Set();
      for (const item of normalized) {
        if (seen.has(item.externalId)) throw syncError('INVALID_RESPONSE', 'Trading212 持仓含重复标识');
        const currency = ensureCurrency(item.currencyCode);
        const type = findType.get(item.typeName) || findType.get('unclassified');
        upsertAsset.run(item.code, item.name, item.quantity, item.average, type.id, platform.id, currency.id, item.externalId, actor, actor);
        upsertQuote.run(`${item.code}_${item.typeName}`, item.code, item.typeName, item.current, currency.code);
        seen.add(item.externalId);
      }

      const cashType = findType.get('cash');
      upsertAsset.run('T212-CASH', 'Trading212 现金', summary.cash, 1, cashType.id, platform.id, accountCurrency.id, 'cash', actor, actor);
      upsertQuote.run('T212-CASH_cash', 'T212-CASH', 'cash', 1, accountCurrency.code);
      seen.add('cash');

      const externalAssets = db.prepare("SELECT id, external_id FROM assets WHERE external_source = 'trading212' AND archived_at IS NULL").all();
      const archive = db.prepare('UPDATE assets SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      for (const asset of externalAssets) if (!seen.has(asset.external_id)) archive.run(actor, asset.id);
      db.prepare("UPDATE assets SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE code = 'T212-TOTAL' AND archived_at IS NULL").run(actor);
      const details = { total: summary.total, cash: summary.cash, positions: normalized.length, calculated, difference, tolerance };
      setStatus('success', `已同步 ${normalized.length} 项持仓与现金余额`, details, true);
    })();

    return getStatus();
  } catch (error) {
    const known = Boolean(error.code && error.status);
    const message = known ? error.message : 'Trading212 同步失败，已保留原有资产数据';
    setStatus('error', message, { ...(error.details || {}), errorCode: known ? error.code : 'SYNC_FAILED' });
    throw error;
  }
}

module.exports = { configured, getStatus, sync, typeForInstrument, accountSummaryValues };
