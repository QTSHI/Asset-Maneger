const db = require('./database.cjs');
const wealth = require('./wealthService.cjs');
const trading212 = require('./trading212Service.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITY = { high: 0, medium: 1, low: 2 };

function timestamp(value) {
  if (!value || typeof value !== 'string') return null;
  // SQLite CURRENT_TIMESTAMP stores UTC without a suffix; browser/server local
  // time zones must not shift the age of an imported quote or sync.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function shanghaiDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
}

function confirmationDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    const parsed = timestamp(value);
    return parsed !== null && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
  }
  const parsed = timestamp(value);
  return parsed === null ? null : shanghaiDate(new Date(parsed));
}

function assetIssue(asset, kind, severity, title, description, actionLabel = '核对资产') {
  return {
    id: `asset:${asset.id}:${kind}`, kind, severity, title, description, actionLabel,
    href: `/assets?asset=${asset.id}`, assetId: asset.id, accountId: asset.platform_id,
    assetName: asset.name || asset.code, accountName: asset.account_name
  };
}

function getAttention({ now = new Date() } = {}) {
  const current = new Date(now);
  const currentMs = current.getTime();
  if (!Number.isFinite(currentMs)) throw new Error('Invalid attention check date');
  const today = shanghaiDate(current);
  const rates = wealth.getStoredRates();
  // Use the same active-record and quote-identity query as portfolio valuation.
  // Do not call valueAssets(): a missing FX rate is an issue to report here.
  const assets = wealth.getActiveAssets();
  const items = [];

  for (const asset of assets) {
    const currency = asset.currency_code || (asset.currency_id == null ? 'CNY' : null);
    if (currency !== 'CNY' && !(Number.isFinite(rates[currency]) && rates[currency] > 0)) {
      const issue = assetIssue(asset, 'missing_fx', 'high', '缺少有效汇率',
        currency ? `缺少 ${currency} 兑人民币汇率，当前无法完整计算资产价值。请在数据状态中更新汇率。`
          : '资产币种无法识别，请先核对币种设置。', '查看汇率状态');
      issue.href = '/status';
      items.push(issue);
    }

    const isCash = asset.asset_type_name === 'cash' || String(asset.code).startsWith('CASH-');
    const isAggregate = asset.code === 'T212-TOTAL';
    const isSynced = asset.external_source === 'trading212';
    if (isCash) {
      if (!isSynced) {
        const confirmed = confirmationDate(asset.cash_confirmed_at);
        if (!confirmed) {
          items.push(assetIssue(asset, 'cash_unconfirmed', 'medium', '现金余额尚未确认',
            '与银行或钱包核对余额后，填写余额确认日期。', '确认现金余额'));
        } else if (confirmed > today) {
          items.push(assetIssue(asset, 'cash_confirmation_invalid', 'medium', '现金确认日期需核对',
            '余额确认日期晚于今天，请核对实际余额及日期。', '确认现金余额'));
        } else if ((Date.parse(today) - Date.parse(confirmed)) / DAY_MS > 30) {
          items.push(assetIssue(asset, 'cash_stale', 'medium', '现金余额超过 30 天未确认',
            `最近确认日期为 ${confirmed}，请再次核对实际余额。`, '确认现金余额'));
        }
      }
      continue;
    }

    const priceAvailable = asset.cached_price !== null && asset.cached_price !== undefined &&
      Number.isFinite(Number(asset.cached_price)) && Number(asset.cached_price) > 0;
    let quoteStatus = asset.quote_status || 'missing';
    if (!priceAvailable && quoteStatus !== 'error') quoteStatus = 'missing';
    const hasQuantity = asset.quantity_status !== 'missing' && Number(asset.shares) > 0;
    const quality = wealth.getAssetDataQuality(asset, quoteStatus,
      isAggregate && asset.valuation_mode === 'position_value', !isAggregate && (!hasQuantity || !priceAvailable));
    if (quality.issues.includes('missing_quote_code')) {
      items.push(assetIssue(asset, 'missing_quote_code', 'high', '缺少行情代码',
        '导入记录尚未匹配真实行情代码，请核对标的后补充。'));
    }
    if (quality.issues.includes('missing_quantity') || !isAggregate && !hasQuantity) {
      items.push(assetIssue(asset, 'missing_quantity', 'high', '持仓数量需核对',
        '缺少可用于估值的持仓数量，请按账户实际持仓补充。'));
    } else if (quality.issues.includes('estimated_quantity')) {
      items.push(assetIssue(asset, 'estimated_quantity', 'medium', '持仓数量为估算值',
        '目前按历史价格估算份额，请与账户的实际份额核对。'));
    }
    if (isAggregate && asset.valuation_mode === 'position_value') {
      // The legacy total is a static fallback, not a quote-driven instrument.
      items.push(assetIssue(asset, 'static_valuation', 'medium', '账户仍使用静态汇总值',
        '请在数据状态中同步并对账，确认详细持仓后再替换汇总备用值。', '查看汇总资产'));
    } else if (!quality.issues.includes('missing_quote_code')) {
      if (quoteStatus === 'error') {
        items.push(assetIssue(asset, 'quote_error', 'high', '行情读取失败',
          '本次未获取有效行情，请在数据状态中重试更新；已有价格可能仍为旧值。'));
      } else if (quoteStatus === 'missing') {
        items.push(assetIssue(asset, 'quote_missing', 'high', '行情尚未获取',
          '缺少可用于估值的行情，请核对标的代码并更新行情。'));
      } else if (quoteStatus === 'stale' && !isSynced) {
        items.push(assetIssue(asset, 'quote_stale', 'medium', '行情需要更新',
          '行情更新未完成，当前保留的价格已标记过期。请在数据状态中更新。'));
      }
    }
  }

  addTrading212Issues(items, assets, currentMs);
  items.sort((a, b) => PRIORITY[a.severity] - PRIORITY[b.severity] || a.id.localeCompare(b.id, 'en'));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const item of items) counts[item.severity] += 1;
  return { asOf: current.toISOString(), total: items.length, counts, items };
}

function addTrading212Issues(items, assets, nowMs) {
  const accounts = db.prepare("SELECT id, name FROM platforms WHERE archived_at IS NULL AND external_source = 'trading212'").all();
  const relevant = new Map(accounts.map((account) => [account.id, account.name]));
  for (const asset of assets) {
    if (asset.external_source === 'trading212' || asset.code === 'T212-TOTAL') relevant.set(asset.platform_id, asset.account_name);
  }
  const status = trading212.getStatus();
  if (!relevant.size && !status.configured) return;
  const subjects = relevant.size ? [...relevant].map(([id, name]) => ({ id, name })) : [{ id: null, name: 'Trading212' }];
  const add = (kind, severity, title, description) => {
    for (const account of subjects) items.push({
      id: `account:${account.id ?? 'trading212'}:${kind}`, kind, severity, title, description,
      actionLabel: '查看同步状态', href: '/status', ...(account.id === null ? {} : { accountId: account.id }), accountName: account.name
    });
  };
  if (!status.configured) {
    add('sync_unconfigured', 'medium', 'Trading212 同步配置需恢复', '已有同步账户，但当前未配置同步凭据，请在服务器恢复配置后核对数据。');
    return;
  }
  const details = status.details;
  const mismatch = status.lastErrorCode === 'RECONCILIATION_FAILED' ||
    Number.isFinite(details?.difference) && Number.isFinite(details?.tolerance) && Math.abs(details.difference) > details.tolerance;
  if (mismatch) {
    add('reconciliation_mismatch', 'high', 'Trading212 账户对账存在差异', '详细持仓与账户总值未对齐，现有资产已保留。请查看同步状态后重新对账。');
  } else if (status.state === 'error') {
    add('sync_error', 'high', 'Trading212 最近同步失败', '现有资产已保留，请在数据状态中检查配置并重试同步。');
  }
  const succeeded = timestamp(status.lastSuccessAt);
  if (succeeded === null) {
    if (!mismatch && status.state !== 'error' && status.state !== 'running') {
      add('sync_never_succeeded', 'medium', 'Trading212 尚未完成首次同步', '请同步并核对账户摘要与详细持仓。');
    }
  } else if (nowMs - succeeded > 3 * DAY_MS) {
    add('sync_stale', 'medium', 'Trading212 超过 3 天未同步', '请更新账户数据，确认最近持仓与现金余额。');
  }
}

module.exports = { getAttention };
