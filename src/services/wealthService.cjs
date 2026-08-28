const Decimal = require('decimal.js');
const db = require('./database.cjs');
const { getPrice, getHistoricalFundPrice, updateExchangeRates, getExchangeRates } = require('./priceFetcher.cjs');

const CLASS_META = {
  cash: { code: 'cash', label: '现金与现金等价物', shortLabel: '现金', color: '#0f766e' },
  fund: { code: 'fund', label: '基金', shortLabel: '基金', color: '#2563eb' },
  stock: { code: 'stock', label: '股票', shortLabel: '股票', color: '#d39b3b' },
  alternative: { code: 'alternative', label: '另类资产', shortLabel: '另类', color: '#7c3aed' },
  unclassified: { code: 'unclassified', label: '待分类', shortLabel: '待分类', color: '#64748b' }
};

const SUBTYPE_LABELS = {
  cash: '现金', bank_deposit: '银行存款', e_wallet: '电子钱包', physical_cash: '实体现金',
  mutual_fund: '场外基金', etf: 'ETF', lof: 'LOF', stock_cn: 'A股', stock_us: '美股',
  stock_uk: '英股', gold: '黄金', crypto: '虚拟货币', unclassified: '待人工确认'
};

let marketStatus = {
  state: 'idle',
  startedAt: null,
  finishedAt: null,
  updated: 0,
  failed: 0,
  message: null
};

function money(value) {
  return Number(new Decimal(value || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
}

function precise(value, places = 8) {
  return Number(new Decimal(value || 0).toDecimalPlaces(places, Decimal.ROUND_HALF_UP));
}

function getStoredRates() {
  const stored = Object.fromEntries(
    db.prepare('SELECT currency_code, rate_to_cny FROM exchange_rate_cache').all()
      .map((row) => [row.currency_code, Number(row.rate_to_cny)])
  );
  const fallback = getExchangeRates();
  return {
    CNY: 1,
    GBP: stored.GBP || fallback.GBP_TO_CNY || 1,
    USD: stored.USD || fallback.USD_TO_CNY || 1,
    EUR: stored.EUR || fallback.EUR_TO_CNY || 1,
    AED: stored.AED || fallback.AED_TO_CNY || 1,
    JPY: stored.JPY || fallback.JPY_TO_CNY || 1,
    HKD: stored.HKD || fallback.HKD_TO_CNY || 0.92
  };
}

function getActiveAssets() {
  return db.prepare(`
    SELECT a.*, p.name AS account_name, p.account_type, p.default_currency_id,
           c.code AS currency_code, at.name AS asset_type_name,
           COALESCE(at.asset_class_code, 'unclassified') AS asset_class_code,
           COALESCE(at.asset_subtype_code, 'unclassified') AS asset_subtype_code,
           CASE
             WHEN a.external_source = 'manual_import'
              AND at.name IN ('纸黄金', 'gold_paper')
              AND length(COALESCE(a.quote_code, '')) = 6
             THEN 'fund'
             ELSE at.name
           END AS quote_asset_type,
           live_q.price AS live_price,
           imported_q.price AS imported_price,
           COALESCE(live_q.price, imported_q.price) AS cached_price,
           COALESCE(live_q.status, imported_q.status) AS quote_status,
           COALESCE(live_q.fetched_at, imported_q.fetched_at) AS quote_fetched_at,
           COALESCE(live_q.source, imported_q.source) AS quote_source,
           COALESCE(live_q.error_message, imported_q.error_message) AS quote_error
    FROM assets a
    JOIN platforms p ON p.id = a.platform_id
    JOIN asset_types at ON at.id = a.asset_type_id
    LEFT JOIN currencies c ON c.id = a.currency_id
    LEFT JOIN quote_cache live_q
      ON live_q.cache_key = COALESCE(NULLIF(a.quote_code, ''), a.code) || '_' ||
        CASE
          WHEN a.external_source = 'manual_import'
           AND at.name IN ('纸黄金', 'gold_paper')
           AND length(COALESCE(a.quote_code, '')) = 6
          THEN 'fund'
          ELSE at.name
        END
     AND (a.external_source IS NULL OR a.external_source <> 'manual_import' OR NULLIF(a.quote_code, '') IS NOT NULL)
    LEFT JOIN quote_cache imported_q
      ON imported_q.cache_key = a.code || '_' || at.name
     AND (a.external_source IS NULL OR a.external_source <> 'manual_import')
    WHERE a.archived_at IS NULL AND p.archived_at IS NULL
    ORDER BY a.id DESC
  `).all();
}

function valueAssets() {
  const rates = getStoredRates();
  return getActiveAssets().map((asset) => {
    const currency = asset.currency_code || 'CNY';
    const rate = rates[currency] || 1;
    const isCash = asset.asset_type_name === 'cash' || String(asset.code).startsWith('CASH-');
    const isAggregateT212 = asset.code === 'T212-TOTAL';
    const usesImportedPosition = isAggregateT212 && asset.valuation_mode === 'position_value';
    const currentPrice = isCash || isAggregateT212
      ? 1
      : asset.cached_price == null
        ? null
        : Number(asset.cached_price);
    const classCode = isAggregateT212 ? 'unclassified' : (asset.asset_class_code || 'unclassified');
    const subtypeCode = isAggregateT212 ? 'unclassified' : (asset.asset_subtype_code || 'unclassified');
    const hasQuantity = isCash || isAggregateT212 || (
      asset.quantity_status !== 'missing' && Number(asset.shares) > 0
    );
    const referenceOnly = !isCash && !isAggregateT212 && (!hasQuantity || currentPrice == null);
    const marketOriginal = usesImportedPosition
      ? new Decimal(asset.imported_market_value ?? 0)
      : referenceOnly
        ? new Decimal(0)
        : new Decimal(asset.shares || 0).times(currentPrice || 0);
    const costOriginal = usesImportedPosition
      ? new Decimal(asset.imported_cost_value ?? 0)
      : referenceOnly
        ? new Decimal(0)
        : new Decimal(asset.shares || 0).times(asset.cost_price || 0);
    const marketCny = marketOriginal.times(rate);
    const costCny = costOriginal.times(rate);
    const profitCny = marketCny.minus(costCny);
    const profitPercent = costCny.gt(0) ? profitCny.div(costCny).times(100) : new Decimal(0);

    const rawQuoteStatus = isCash ? 'fresh' : (asset.quote_status || 'missing');
    const quoteStatus = rawQuoteStatus;
    const dataQuality = getAssetDataQuality(asset, quoteStatus, usesImportedPosition, referenceOnly);

    return {
      id: asset.id,
      code: asset.code,
      name: asset.name || asset.code,
      shares: precise(asset.shares),
      costPrice: precise(asset.cost_price),
      currentPrice: currentPrice == null ? null : precise(currentPrice),
      quoteCode: asset.quote_code || null,
      quantityStatus: asset.quantity_status || 'verified',
      valuationMode: asset.valuation_mode || 'units',
      importedMarketValue: asset.imported_market_value == null ? null : money(asset.imported_market_value),
      importedCostValue: asset.imported_cost_value == null ? null : money(asset.imported_cost_value),
      valuationAsOf: asset.valuation_as_of || null,
      valuationBasis: usesImportedPosition ? 'imported_position' : referenceOnly ? 'reference_only' : 'unit_price',
      currency,
      rateToCny: precise(rate),
      marketValue: money(marketOriginal),
      costValue: money(costOriginal),
      marketValueCny: money(marketCny),
      costValueCny: money(costCny),
      profitCny: money(profitCny),
      profitPercent: money(profitPercent),
      accountId: asset.platform_id,
      accountName: asset.account_name,
      accountType: asset.account_type || 'other',
      assetTypeId: asset.asset_type_id,
      assetType: asset.asset_type_name,
      classCode,
      classLabel: CLASS_META[classCode]?.label || CLASS_META.unclassified.label,
      subtypeCode,
      subtypeLabel: SUBTYPE_LABELS[subtypeCode] || SUBTYPE_LABELS.unclassified,
      quote: {
        status: quoteStatus,
        fetchedAt: asset.quote_fetched_at,
        source: asset.quote_source,
        error: asset.quote_error
      },
      dataQuality
    };
  });
}

function getAssetDataQuality(asset, quoteStatus, usesImportedPosition = false, referenceOnly = false) {
  const issues = [];
  const investmentClass = ['fund', 'stock', 'alternative'].includes(asset.asset_class_code);
  if (asset.external_source === 'manual_import' && ['fund', 'stock'].includes(asset.asset_class_code) && !asset.quote_code) {
    issues.push('missing_quote_code');
  }
  if (investmentClass && asset.quantity_status === 'missing') issues.push('missing_quantity');
  if (investmentClass && asset.quantity_status === 'estimated') issues.push('estimated_quantity');
  if (usesImportedPosition) issues.push('static_valuation');
  if (referenceOnly && asset.external_source === 'manual_import') issues.push('reference_only');
  if (['missing', 'error'].includes(quoteStatus)) issues.push('missing_quote');
  if (quoteStatus === 'stale') issues.push('stale_quote');

  const blocked = issues.some((issue) => ['missing_quote_code', 'missing_quantity', 'missing_quote'].includes(issue));
  const status = blocked ? 'blocked' : issues.length ? 'attention' : 'ready';
  let label = '数据完整';
  if (issues.includes('missing_quote_code')) label = '缺少行情代码';
  else if (issues.includes('missing_quantity')) label = '缺少持仓份额';
  else if (issues.includes('reference_only')) label = '仅保留历史参考';
  else if (issues.includes('static_valuation')) label = '静态持仓估值';
  else if (issues.includes('stale_quote')) label = '行情已过期';
  else if (issues.includes('estimated_quantity')) label = '份额为估算值';
  else if (issues.includes('missing_quote')) label = '行情待更新';
  return { status, label, issues };
}

function allocation(items, key, labelKey) {
  const grouped = new Map();
  for (const item of items) {
    const code = item[key];
    const entry = grouped.get(code) || {
      code,
      label: item[labelKey],
      valueCny: 0,
      costValueCny: 0,
      profitCny: 0,
      count: 0
    };
    entry.valueCny = money(new Decimal(entry.valueCny).plus(item.marketValueCny));
    entry.costValueCny = money(new Decimal(entry.costValueCny).plus(item.costValueCny));
    entry.profitCny = money(new Decimal(entry.profitCny).plus(item.profitCny));
    entry.count += 1;
    grouped.set(code, entry);
  }
  const total = items.reduce((sum, item) => sum.plus(item.marketValueCny), new Decimal(0));
  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      percent: total.gt(0) ? money(new Decimal(entry.valueCny).div(total).times(100)) : 0,
      profitPercent: entry.costValueCny > 0
        ? money(new Decimal(entry.profitCny).div(entry.costValueCny).times(100))
        : 0
    }))
    .sort((a, b) => b.valueCny - a.valueCny);
}

function monthBounds(month) {
  const valid = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toISOString().slice(0, 7);
  return valid;
}

function londonDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
}

function getHouseholdSummary(monthInput) {
  const month = monthBounds(monthInput);
  const transactions = db.prepare(`
    SELECT ht.*, hc.name AS category_name, hc.color AS category_color,
           p.name AS account_name, hp.name AS project_name
    FROM household_transactions ht
    JOIN household_categories hc ON hc.id = ht.category_id
    LEFT JOIN platforms p ON p.id = ht.account_id
    LEFT JOIN household_projects hp ON hp.id = ht.project_id
    WHERE substr(ht.occurred_on, 1, 7) = ? AND ht.archived_at IS NULL
    ORDER BY ht.occurred_on DESC, ht.id DESC
  `).all(month);

  const budgets = db.prepare(`
    SELECT mb.id AS budget_id, hc.id AS category_id,
           COALESCE(mb.planned_amount_cny, 0) AS planned_amount_cny,
           hc.name AS category_name, hc.kind, hc.color, hc.icon,
           COALESCE(SUM(CASE WHEN ht.archived_at IS NULL THEN ht.amount_cny ELSE 0 END), 0) AS actual_amount_cny
    FROM household_categories hc
    LEFT JOIN monthly_budgets mb ON mb.category_id = hc.id AND mb.month = ?
    LEFT JOIN household_transactions ht
      ON ht.category_id = hc.id AND substr(ht.occurred_on, 1, 7) = ?
    WHERE hc.archived_at IS NULL
    GROUP BY hc.id
    ORDER BY hc.kind DESC, hc.sort_order, hc.name
  `).all(month, month).map((row) => ({
    id: row.budget_id || -row.category_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    kind: row.kind,
    color: row.color,
    icon: row.icon,
    planned: money(row.planned_amount_cny),
    actual: money(row.actual_amount_cny),
    remaining: money(new Decimal(row.planned_amount_cny || 0).minus(row.actual_amount_cny || 0)),
    percent: Number(row.planned_amount_cny) > 0 ? money(new Decimal(row.actual_amount_cny || 0).div(row.planned_amount_cny).times(100)) : 0
  }));

  const income = transactions.filter((item) => item.kind === 'income').reduce((sum, item) => sum.plus(item.amount_cny), new Decimal(0));
  const expense = transactions.filter((item) => item.kind === 'expense').reduce((sum, item) => sum.plus(item.amount_cny), new Decimal(0));
  const plannedExpense = budgets.filter((item) => item.kind === 'expense').reduce((sum, item) => sum.plus(item.planned), new Decimal(0));

  const plannedMonthNavigation = db.prepare(`
    SELECT
      MAX(CASE WHEN mb.month < ? THEN mb.month END) AS previous_planned_month,
      MIN(CASE WHEN mb.month > ? THEN mb.month END) AS next_planned_month
    FROM monthly_budgets mb
    JOIN household_categories hc ON hc.id = mb.category_id
    WHERE hc.archived_at IS NULL AND mb.planned_amount_cny > 0
  `).get(month, month);

  const projects = db.prepare(`
    SELECT hp.*, COALESCE(SUM(CASE WHEN ht.kind = 'expense' AND ht.archived_at IS NULL THEN ht.amount_cny ELSE 0 END), 0) AS spent_cny
    FROM household_projects hp
    LEFT JOIN household_transactions ht ON ht.project_id = hp.id
    WHERE hp.archived_at IS NULL
    GROUP BY hp.id
    ORDER BY CASE hp.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, hp.end_date
  `).all().map((row) => ({
    ...row,
    target_amount_cny: money(row.target_amount_cny),
    spent_cny: money(row.spent_cny),
    remaining_cny: money(new Decimal(row.target_amount_cny || 0).minus(row.spent_cny || 0)),
    progress: Number(row.target_amount_cny) > 0 ? money(new Decimal(row.spent_cny || 0).div(row.target_amount_cny).times(100)) : 0
  }));

  const memos = db.prepare(`
    SELECT fm.*, c.code AS currency_code, p.name AS account_name, hc.name AS category_name
    FROM financial_memos fm
    JOIN currencies c ON c.id = fm.currency_id
    LEFT JOIN platforms p ON p.id = fm.account_id
    LEFT JOIN household_categories hc ON hc.id = fm.category_id
    WHERE fm.archived_at IS NULL AND fm.status = 'pending'
      AND date(fm.due_date) <= date('now', '+30 day')
    ORDER BY fm.due_date, fm.id
  `).all().map((row) => {
    const due = new Date(`${row.due_date}T00:00:00`);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const daysUntil = Math.ceil((due.getTime() - now.getTime()) / 86400000);
    return {
      ...row,
      expected_amount: money(row.expected_amount),
      display_status: daysUntil < 0 ? 'overdue' : daysUntil <= row.reminder_days ? 'upcoming' : 'pending',
      days_until: daysUntil
    };
  });

  return {
    month,
    totals: {
      income: money(income),
      expense: money(expense),
      net: money(income.minus(expense)),
      plannedExpense: money(plannedExpense),
      remainingBudget: money(plannedExpense.minus(expense))
    },
    navigation: {
      previousPlannedMonth: plannedMonthNavigation.previous_planned_month || null,
      nextPlannedMonth: plannedMonthNavigation.next_planned_month || null
    },
    budgets,
    recentTransactions: transactions.slice(0, 6),
    projects,
    memos
  };
}

function monthsBetween(startMonth, endMonth) {
  const months = [];
  const [startYear, startValue] = startMonth.split('-').map(Number);
  const [endYear, endValue] = endMonth.split('-').map(Number);
  const cursor = new Date(Date.UTC(startYear, startValue - 1, 1));
  const end = new Date(Date.UTC(endYear, endValue - 1, 1));
  while (cursor <= end && months.length < 120) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function getHouseholdPlan() {
  const settings = db.prepare(`
    SELECT hps.*, c.code AS opening_currency_code
    FROM household_plan_settings hps
    JOIN currencies c ON c.id = hps.opening_currency_id
    WHERE hps.id = 1
  `).get();
  if (!settings) return null;

  const budgets = new Map(db.prepare(`
    SELECT mb.month,
           SUM(CASE WHEN hc.kind = 'income' THEN mb.planned_amount_cny ELSE 0 END) AS planned_income,
           SUM(CASE WHEN hc.kind = 'expense' THEN mb.planned_amount_cny ELSE 0 END) AS planned_expense
    FROM monthly_budgets mb
    JOIN household_categories hc ON hc.id = mb.category_id
    WHERE mb.month BETWEEN ? AND ? AND hc.archived_at IS NULL
    GROUP BY mb.month
  `).all(settings.start_month, settings.end_month).map((row) => [row.month, row]));

  const livingExpense = db.prepare(`
    SELECT hc.id AS category_id, hc.name AS category_name,
           mb.planned_amount_cny AS monthly_amount_cny,
           COUNT(*) AS planned_months
    FROM monthly_budgets mb
    JOIN household_categories hc ON hc.id = mb.category_id
    WHERE hc.archived_at IS NULL AND hc.kind = 'expense'
      AND hc.name = '家庭生活费'
      AND mb.month BETWEEN ? AND ?
      AND mb.planned_amount_cny > 0
    GROUP BY hc.id, mb.planned_amount_cny
    ORDER BY COUNT(*) DESC, mb.planned_amount_cny DESC
    LIMIT 1
  `).get(settings.start_month, settings.end_month);

  const actuals = new Map(db.prepare(`
    SELECT substr(occurred_on, 1, 7) AS month,
           SUM(CASE WHEN kind = 'income' THEN amount_cny ELSE 0 END) AS actual_income,
           SUM(CASE WHEN kind = 'expense' THEN amount_cny ELSE 0 END) AS actual_expense
    FROM household_transactions
    WHERE archived_at IS NULL AND substr(occurred_on, 1, 7) BETWEEN ? AND ?
    GROUP BY substr(occurred_on, 1, 7)
  `).all(settings.start_month, settings.end_month).map((row) => [row.month, row]));

  const memos = new Map(db.prepare(`
    SELECT substr(fm.due_date, 1, 7) AS month,
           SUM(CASE WHEN fm.kind = 'income' THEN fm.expected_amount * COALESCE(er.rate_to_cny, 1) ELSE 0 END) AS memo_income,
           SUM(CASE WHEN fm.kind = 'expense' THEN fm.expected_amount * COALESCE(er.rate_to_cny, 1) ELSE 0 END) AS memo_expense
    FROM financial_memos fm
    JOIN currencies c ON c.id = fm.currency_id
    LEFT JOIN exchange_rate_cache er ON er.currency_code = c.code
    WHERE fm.archived_at IS NULL AND fm.status = 'pending'
      AND substr(fm.due_date, 1, 7) BETWEEN ? AND ?
    GROUP BY substr(fm.due_date, 1, 7)
  `).all(settings.start_month, settings.end_month).map((row) => [row.month, row]));

  const currentMonth = londonDate().slice(0, 7);
  let balance = new Decimal(settings.opening_amount).times(settings.planning_rate_to_cny);
  const rows = monthsBetween(settings.start_month, settings.end_month).map((month) => {
    const budget = budgets.get(month) || {};
    const actual = actuals.get(month) || {};
    const memo = memos.get(month) || {};
    const plannedIncome = new Decimal(budget.planned_income || 0);
    const plannedExpense = new Decimal(budget.planned_expense || 0);
    const actualIncome = new Decimal(actual.actual_income || 0);
    const actualExpense = new Decimal(actual.actual_expense || 0);
    const memoIncome = new Decimal(memo.memo_income || 0);
    const memoExpense = new Decimal(memo.memo_expense || 0);
    const usesActual = month < currentMonth;
    const forecastIncome = (usesActual ? actualIncome : plannedIncome).plus(memoIncome);
    const forecastExpense = (usesActual ? actualExpense : plannedExpense).plus(memoExpense);
    const openingBalance = balance;
    balance = balance.plus(forecastIncome).minus(forecastExpense);
    return {
      month,
      status: usesActual ? 'actual' : month === currentMonth ? 'current' : 'forecast',
      openingBalanceCny: money(openingBalance),
      plannedIncomeCny: money(plannedIncome),
      plannedExpenseCny: money(plannedExpense),
      actualIncomeCny: money(actualIncome),
      actualExpenseCny: money(actualExpense),
      memoIncomeCny: money(memoIncome),
      memoExpenseCny: money(memoExpense),
      projectedNetCny: money(forecastIncome.minus(forecastExpense)),
      closingBalanceCny: money(balance)
    };
  });

  const sum = (key) => money(rows.reduce((total, row) => total.plus(row[key] || 0), new Decimal(0)));
  const firstNegative = rows.find((row) => row.closingBalanceCny < 0)?.month || null;
  return {
    settings: {
      openingAmount: money(settings.opening_amount),
      openingCurrencyId: settings.opening_currency_id,
      openingCurrencyCode: settings.opening_currency_code,
      planningRateToCny: precise(settings.planning_rate_to_cny),
      startMonth: settings.start_month,
      endMonth: settings.end_month
    },
    livingExpenseBasis: livingExpense ? {
      categoryId: livingExpense.category_id,
      categoryName: livingExpense.category_name,
      basisCurrencyCode: 'CNY',
      monthlyAmountCny: money(livingExpense.monthly_amount_cny),
      monthlyAmountInOpeningCurrency: money(
        new Decimal(livingExpense.monthly_amount_cny).div(settings.planning_rate_to_cny)
      ),
      openingCurrencyCode: settings.opening_currency_code,
      plannedMonths: livingExpense.planned_months,
      source: 'monthly_budget'
    } : null,
    totals: {
      openingBalanceCny: money(new Decimal(settings.opening_amount).times(settings.planning_rate_to_cny)),
      plannedIncomeCny: sum('plannedIncomeCny'),
      plannedExpenseCny: sum('plannedExpenseCny'),
      memoIncomeCny: sum('memoIncomeCny'),
      memoExpenseCny: sum('memoExpenseCny'),
      projectedClosingBalanceCny: money(balance),
      firstNegativeMonth: firstNegative
    },
    months: rows
  };
}

function getTrend(range = '3M') {
  const days = { '1M': 31, '3M': 93, '1Y': 366, ALL: 36500 }[range] || 93;
  return db.prepare(`
    SELECT snapshot_date AS date, market_value_cny AS value,
           cost_value_cny AS cost, unrealized_profit_cny AS profit,
           net_cash_flow_cny AS cashFlow
    FROM portfolio_snapshots
    WHERE date(snapshot_date) >= date('now', ?)
    ORDER BY snapshot_date
  `).all(`-${days} day`).map((row) => ({
    date: row.date,
    value: money(row.value),
    cost: money(row.cost),
    profit: money(row.profit),
    cashFlow: money(row.cashFlow)
  }));
}

function getDashboard({ month, range } = {}) {
  const assets = valueAssets();
  const totalMarket = assets.reduce((sum, asset) => sum.plus(asset.marketValueCny), new Decimal(0));
  const totalCost = assets.reduce((sum, asset) => sum.plus(asset.costValueCny), new Decimal(0));
  const totalProfit = totalMarket.minus(totalCost);
  const classAllocation = allocation(assets, 'classCode', 'classLabel').map((entry) => ({
    ...entry,
    color: CLASS_META[entry.code]?.color || CLASS_META.unclassified.color
  }));
  const accountAllocation = allocation(assets, 'accountId', 'accountName');
  const staleCount = assets.filter((asset) => ['static', 'stale', 'error', 'missing'].includes(asset.quote.status)).length;

  return {
    asOf: new Date().toISOString(),
    baseCurrency: 'CNY',
    totals: {
      marketValueCny: money(totalMarket),
      costValueCny: money(totalCost),
      profitCny: money(totalProfit),
      profitPercent: totalCost.gt(0) ? money(totalProfit.div(totalCost).times(100)) : 0,
      assetCount: assets.length,
      accountCount: new Set(assets.map((asset) => asset.accountId)).size
    },
    allocations: { byClass: classAllocation, byAccount: accountAllocation },
    trend: getTrend(range),
    topAccounts: accountAllocation.slice(0, 6),
    recentAssets: assets.slice(0, 6),
    freshness: { staleCount, totalCount: assets.length, market: marketStatus },
    household: getHouseholdSummary(month)
  };
}

function saveDailySnapshot(date = londonDate()) {
  const assets = valueAssets();
  const totalMarket = assets.reduce((sum, asset) => sum.plus(asset.marketValueCny), new Decimal(0));
  const totalCost = assets.reduce((sum, asset) => sum.plus(asset.costValueCny), new Decimal(0));
  const profit = totalMarket.minus(totalCost);
  const flow = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN flow_type IN ('deposit','dividend','interest') THEN amount * er.rate_to_cny ELSE -amount * er.rate_to_cny END), 0) AS value
    FROM cash_flows cf
    JOIN currencies c ON c.id = cf.currency_id
    LEFT JOIN exchange_rate_cache er ON er.currency_code = c.code
    WHERE cf.occurred_on = ? AND cf.archived_at IS NULL
  `).get(date)?.value || 0;

  db.prepare(`
    INSERT INTO portfolio_snapshots (snapshot_date, market_value_cny, cost_value_cny, unrealized_profit_cny, net_cash_flow_cny)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      market_value_cny = excluded.market_value_cny,
      cost_value_cny = excluded.cost_value_cny,
      unrealized_profit_cny = excluded.unrealized_profit_cny,
      net_cash_flow_cny = excluded.net_cash_flow_cny
  `).run(date, money(totalMarket), money(totalCost), money(profit), money(flow));

  const savePosition = db.prepare(`
    INSERT INTO position_snapshots (snapshot_date, asset_id, price, market_value_cny, cost_value_cny, currency_code, rate_to_cny)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, asset_id) DO UPDATE SET
      price = excluded.price,
      market_value_cny = excluded.market_value_cny,
      cost_value_cny = excluded.cost_value_cny,
      currency_code = excluded.currency_code,
      rate_to_cny = excluded.rate_to_cny
  `);
  db.transaction(() => {
    for (const asset of assets) {
      savePosition.run(date, asset.id, asset.currentPrice, asset.marketValueCny, asset.costValueCny, asset.currency, asset.rateToCny);
    }
  })();
}

async function refreshMarket() {
  if (marketStatus.state === 'running') return marketStatus;
  marketStatus = { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, updated: 0, failed: 0, message: null };

  try {
    await repairImportedQuantities();
    await updateExchangeRates();
    const rates = getExchangeRates();
    const rateRows = [
      ['CNY', 1], ['GBP', rates.GBP_TO_CNY], ['USD', rates.USD_TO_CNY], ['EUR', rates.EUR_TO_CNY],
      ['AED', rates.AED_TO_CNY], ['JPY', rates.JPY_TO_CNY], ['HKD', rates.HKD_TO_CNY || 0.92]
    ];
    const upsertRate = db.prepare(`
      INSERT INTO exchange_rate_cache (currency_code, rate_to_cny, status, fetched_at)
      VALUES (?, ?, 'fresh', CURRENT_TIMESTAMP)
      ON CONFLICT(currency_code) DO UPDATE SET rate_to_cny = excluded.rate_to_cny, status = 'fresh', error_message = NULL, fetched_at = CURRENT_TIMESTAMP
    `);
    for (const [currency, rate] of rateRows) if (rate) upsertRate.run(currency, rate);

    const assets = getActiveAssets();
    const refreshableAssets = assets.filter(isMarketRefreshCandidate);
    const upsertQuote = db.prepare(`
      INSERT INTO quote_cache (cache_key, code, asset_type, price, currency_code, source, status, error_message, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(cache_key) DO UPDATE SET
        price = COALESCE(excluded.price, quote_cache.price),
        currency_code = excluded.currency_code,
        source = excluded.source,
        status = excluded.status,
        error_message = excluded.error_message,
        fetched_at = CASE WHEN excluded.price IS NOT NULL THEN CURRENT_TIMESTAMP ELSE quote_cache.fetched_at END
    `);

    for (let index = 0; index < refreshableAssets.length; index += 5) {
      const batch = refreshableAssets.slice(index, index + 5);
      const results = await Promise.all(batch.map(async (asset) => {
        const price = await getPrice({ code: quoteCodeForAsset(asset), type: quoteTypeForAsset(asset) });
        return { asset, price };
      }));
      for (const { asset, price } of results) {
        const success = Number(price) > 0;
        upsertQuote.run(
          `${quoteCodeForAsset(asset)}_${quoteTypeForAsset(asset)}`,
          quoteCodeForAsset(asset),
          quoteTypeForAsset(asset),
          success ? Number(price) : null,
          asset.currency_code || 'CNY',
          'market-provider',
          success ? 'fresh' : (asset.cached_price ? 'stale' : 'missing'),
          success ? null : '暂时无法获取行情'
        );
        if (success) {
          marketStatus.updated += 1;
          if (
            asset.external_source === 'manual_import' &&
            asset.quantity_status !== 'missing' &&
            asset.valuation_mode === 'position_value'
          ) {
            db.prepare(`
              UPDATE assets
              SET valuation_mode = 'units', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(asset.id);
          }
        }
        else marketStatus.failed += 1;
      }
    }
    saveDailySnapshot();
    marketStatus.state = 'success';
  } catch (error) {
    marketStatus.state = 'error';
    marketStatus.message = error.message;
  }
  marketStatus.finishedAt = new Date().toISOString();
  return marketStatus;
}

function quoteCodeForAsset(asset) {
  return String(asset.quote_code || asset.code || '').trim();
}

function quoteTypeForAsset(asset) {
  if (asset.quote_asset_type) return asset.quote_asset_type;
  if (
    asset.external_source === 'manual_import' &&
    ['纸黄金', 'gold_paper'].includes(asset.asset_type_name) &&
    /^\d{6}$/.test(String(asset.quote_code || ''))
  ) return 'fund';
  return asset.asset_type_name;
}

async function repairImportedQuantities() {
  db.prepare(`
    UPDATE assets
    SET valuation_mode = 'units', updated_at = CURRENT_TIMESTAMP
    WHERE external_source = 'manual_import'
      AND archived_at IS NULL
      AND quantity_status <> 'missing'
      AND shares > 0
      AND NULLIF(quote_code, '') IS NOT NULL
  `).run();

  const candidates = getActiveAssets().filter((asset) =>
    asset.external_source === 'manual_import' &&
    asset.quantity_status === 'missing' &&
    Number(asset.imported_market_value) > 0 &&
    Boolean(asset.valuation_as_of) &&
    Boolean(asset.quote_code) &&
    ['fund', 'lof'].includes(quoteTypeForAsset(asset))
  );
  let repaired = 0;
  for (const asset of candidates) {
    const historicalPrice = await getHistoricalFundPrice(
      quoteCodeForAsset(asset), asset.valuation_as_of
    );
    if (!historicalPrice) continue;
    const shares = new Decimal(asset.imported_market_value).div(historicalPrice);
    if (!shares.gt(0)) continue;
    const costPrice = Number(asset.imported_cost_value) > 0
      ? new Decimal(asset.imported_cost_value).div(shares)
      : new Decimal(asset.cost_price || 0);
    const before = { shares: asset.shares, cost_price: asset.cost_price, quantity_status: asset.quantity_status, valuation_mode: asset.valuation_mode };
    db.prepare(`
      UPDATE assets
      SET shares = ?, cost_price = ?, quantity_status = 'estimated',
          valuation_mode = 'units', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(precise(shares, 12), precise(costPrice, 12), asset.id);
    db.prepare(`
      INSERT INTO audit_log (entity_type, entity_id, action, username, before_json, after_json)
      VALUES ('asset', ?, 'estimate_quantity_from_historical_nav', 'system:market-refresh', ?, ?)
    `).run(asset.id, JSON.stringify(before), JSON.stringify({
      shares: precise(shares, 12), cost_price: precise(costPrice, 12),
      quantity_status: 'estimated', valuation_mode: 'units',
      quote_code: quoteCodeForAsset(asset), historical_price: historicalPrice,
      valuation_as_of: asset.valuation_as_of
    }));
    repaired += 1;
  }
  return repaired;
}

function isMarketRefreshCandidate(asset) {
  if (asset.external_source === 'trading212') return false;
  if (asset.external_source === 'manual_import') {
    return Boolean(asset.quote_code) && ['fund', 'etf', 'lof', 'stock_cn', 'stock_us', 'stock_uk'].includes(quoteTypeForAsset(asset));
  }
  return Boolean(quoteCodeForAsset(asset));
}

function getMarketStatus() {
  return marketStatus;
}

module.exports = {
  CLASS_META,
  SUBTYPE_LABELS,
  money,
  valueAssets,
  getDashboard,
  getHouseholdSummary,
  getHouseholdPlan,
  monthsBetween,
  getTrend,
  saveDailySnapshot,
  refreshMarket,
  getMarketStatus,
  getStoredRates,
  londonDate,
  quoteCodeForAsset,
  quoteTypeForAsset,
  repairImportedQuantities,
  isMarketRefreshCandidate,
  getAssetDataQuality
};
