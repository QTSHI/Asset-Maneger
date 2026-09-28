const express = require('express');
const { z } = require('zod');
const db = require('../services/database.cjs');
const wealth = require('../services/wealthService.cjs');
const trading212 = require('../services/trading212Service.cjs');
const agent = require('../services/agentService.cjs');

const router = express.Router();

function ok(res, data, meta) {
  return res.json(meta ? { data, meta } : { data });
}

function fail(res, status, code, message, fields) {
  return res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}) } });
}

// These unfinished modules are withdrawn from the single-household release.
// Keep their historical tables for a future redesign, but reject old clients too.
for (const path of ['/household/budgets', '/household/plan', '/household/projects', '/household/memos']) {
  router.use(path, (_req, res) => fail(res, 410, 'MODULE_RETIRED', '该功能已暂时下线'));
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) fields[issue.path.join('.') || 'form'] = issue.message;
    const error = new Error('输入内容不完整或格式不正确');
    error.status = 400;
    error.code = 'VALIDATION_ERROR';
    error.fields = fields;
    throw error;
  }
  return result.data;
}

function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!error.status || error.status >= 500) console.error('[api/v2]', error);
      fail(res, error.status || 500, error.code || 'INTERNAL_ERROR', error.status ? error.message : '服务暂时不可用', error.fields);
    }
  };
}

function username(req) {
  return req.user?.username || 'unknown';
}

function audit(entityType, entityId, action, user, before, after) {
  db.prepare(`
    INSERT INTO audit_log (entity_type, entity_id, action, username, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entityType, entityId || null, action, user, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

function getRecord(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

function sendList(res, items, query = {}) {
  const total = items.length;
  if (query.page === undefined && query.pageSize === undefined) return ok(res, items, { total });
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return ok(res, items.slice((page - 1) * pageSize, page * pageSize), { total, page, pageSize });
}

function updateRecord(table, id, values, allowed, user) {
  const entries = Object.entries(values).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (allowed.includes('updated_by')) entries.push(['updated_by', user]);
  if (allowed.includes('updated_at')) entries.push(['updated_at', new Date().toISOString()]);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
}

const idSchema = z.coerce.number().int().positive();
const optionalId = z.coerce.number().int().positive().nullable().optional();
const dateString = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, '请输入有效日期');
const monthString = z.string()
  .regex(/^\d{4}-\d{2}$/, '月份格式应为 YYYY-MM')
  .refine((value) => Number(value.slice(5)) >= 1 && Number(value.slice(5)) <= 12, '请输入有效月份');

const assetCreateSchema = z.object({
  platform_id: idSchema,
  asset_type_id: idSchema,
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().max(120).optional().default(''),
  shares: z.coerce.number().finite(),
  cost_price: z.coerce.number().nonnegative().nullable().optional().default(0),
  currency_id: idSchema,
  quote_code: z.string().trim().max(40).nullable().optional(),
  quantity_status: z.enum(['missing', 'estimated', 'verified']).optional().default('verified'),
  valuation_mode: z.enum(['units', 'position_value']).optional().default('units'),
  imported_market_value: z.coerce.number().nonnegative().nullable().optional(),
  imported_cost_value: z.coerce.number().nonnegative().nullable().optional(),
  valuation_as_of: dateString.nullable().optional()
});
const assetPatchSchema = assetCreateSchema.partial();

function requireWebsiteUser(req, res, next) {
  if (!req.user?.username || req.user.username === 'unknown') {
    return fail(res, 401, 'AUTH_REQUIRED', '需要先通过统一登录验证身份');
  }
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const host = req.get('host');
  let allowed = false;
  try {
    const parsed = new URL(origin);
    const publicOrigin = process.env.ASSET_TRACKER_PUBLIC_ORIGIN || 'https://asset.stoneking.top';
    // The reverse proxy may pass its internal Host to Express, so also accept
    // the configured public website origin when it matches exactly.
    allowed = parsed.origin === publicOrigin || parsed.host === host &&
      (parsed.protocol === 'https:' ||
        (process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:'));
    // The local Vite proxy forwards requests to port 8080 while the browser
    // remains on port 5173. Keep this exception limited to loopback previews.
    if (!allowed && process.env.NODE_ENV === 'development') {
      const destination = new URL(`http://${host}`);
      allowed = parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
        parsed.hostname === destination.hostname &&
        ['localhost', '127.0.0.1'].includes(destination.hostname);
    }
  } catch (_) {
    allowed = false;
  }
  if (!allowed) return fail(res, 403, 'ORIGIN_MISMATCH', '请在本网站中确认此操作');
  next();
}

router.use('/agent', requireWebsiteUser);

router.get('/agent/proposals', handler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = agent.listProposals(username(req), req.query.status, req.query);
  ok(res, result.items, { total: result.total, page: result.page, pageSize: result.pageSize });
}));

router.post('/agent/proposals/:id/approve', requireSameOrigin, handler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, agent.approveProposal(parse(idSchema, req.params.id), username(req)));
}));

router.post('/agent/proposals/:id/reject', requireSameOrigin, handler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, agent.rejectProposal(parse(idSchema, req.params.id), username(req)));
}));

router.get('/agent/keys', handler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  sendList(res, agent.listAgentKeys(username(req)));
}));

router.post('/agent/keys', requireSameOrigin, handler(async (req, res) => {
  const input = parse(z.object({
    label: z.string().trim().min(1).max(80),
    expiresInDays: z.number().int().min(1).max(365).optional()
  }).strict(), req.body);
  res.set('Cache-Control', 'no-store');
  res.status(201);
  ok(res, agent.createAgentKey(username(req), input.label, input.expiresInDays));
}));

router.delete('/agent/keys/:id', requireSameOrigin, handler(async (req, res) => {
  agent.revokeAgentKey(parse(idSchema, req.params.id), username(req));
  res.status(204).end();
}));

router.get('/dashboard', handler(async (req, res) => {
  ok(res, wealth.getDashboard({ range: req.query.range }));
}));

router.get('/assets', handler(async (req, res) => {
  let assets = wealth.valueAssets();
  if (req.query.class) assets = assets.filter((item) => item.classCode === req.query.class);
  if (req.query.account) assets = assets.filter((item) => String(item.accountId) === String(req.query.account));
  if (req.query.q) {
    const query = String(req.query.q).toLowerCase();
    assets = assets.filter((item) => `${item.code} ${item.name} ${item.accountName}`.toLowerCase().includes(query));
  }
  const sort = req.query.sort || 'value';
  assets.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.marketValueCny - a.marketValueCny);
  sendList(res, assets, req.query);
}));

router.post('/assets', handler(async (req, res) => {
  const input = parse(assetCreateSchema, req.body);
  const user = username(req);
  const result = db.prepare(`
    INSERT INTO assets (
      platform_id, asset_type_id, code, name, shares, cost_price, currency_id,
      quote_code, quantity_status, valuation_mode, imported_market_value,
      imported_cost_value, valuation_as_of, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.platform_id, input.asset_type_id, input.code, input.name, input.shares,
    input.cost_price, input.currency_id, input.quote_code || null,
    input.quantity_status, input.valuation_mode, input.imported_market_value ?? null,
    input.imported_cost_value ?? null, input.valuation_as_of || null, user, user
  );
  const id = Number(result.lastInsertRowid);
  const record = getRecord('assets', id);
  audit('asset', id, 'create', user, null, record);
  res.status(201);
  ok(res, record);
}));

router.patch('/assets/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const input = parse(assetPatchSchema, req.body);
  const before = getRecord('assets', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '资产不存在');
  const user = username(req);
  const balanceIdentityChanged = [
    'shares', 'cost_price', 'currency_id', 'platform_id', 'asset_type_id',
    'valuation_mode', 'imported_market_value', 'imported_cost_value'
  ]
    .some((key) => input[key] !== undefined && input[key] !== before[key]);
  updateRecord('assets', id, balanceIdentityChanged ? { ...input, cash_confirmed_at: null } : input, [
    'platform_id', 'asset_type_id', 'code', 'name', 'shares', 'cost_price', 'currency_id',
    'quote_code', 'quantity_status', 'valuation_mode', 'imported_market_value',
    'imported_cost_value', 'valuation_as_of', 'cash_confirmed_at', 'updated_by', 'updated_at'
  ], user);
  const after = getRecord('assets', id);
  audit('asset', id, 'update', user, before, after);
  ok(res, after);
}));

const cashBalanceSchema = z.object({
  balance: z.number().finite(),
  confirmed_on: dateString.refine(
    (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
    '请输入有效的确认日期'
  )
});

router.patch('/assets/:id/cash-balance', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const input = parse(cashBalanceSchema, req.body);
  const before = db.prepare(`
    SELECT a.*, at.name AS asset_type_name
    FROM assets a JOIN asset_types at ON at.id = a.asset_type_id
    WHERE a.id = ?
  `).get(id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '资产不存在');
  if (before.asset_type_name !== 'cash') {
    return fail(res, 400, 'NOT_CASH_ASSET', '只有现金类资产可以快捷更新余额');
  }
  if (before.external_source === 'trading212') {
    return fail(res, 409, 'SYNC_MANAGED', '该现金余额由 Trading212 同步，请在数据同步后查看');
  }
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (input.confirmed_on > localToday) {
    return fail(res, 400, 'FUTURE_CONFIRMATION', '余额确认日期不能晚于今天');
  }
  const user = username(req);
  db.prepare(`
    UPDATE assets
    SET shares = ?, cost_price = 1, cash_confirmed_at = ?,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(input.balance, input.confirmed_on, user, id);
  const after = getRecord('assets', id);
  audit('asset', id, 'confirm_cash_balance', user, before, after);
  ok(res, after);
}));

router.delete('/assets/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const before = getRecord('assets', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '资产不存在');
  const user = username(req);
  db.prepare('UPDATE assets SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, id);
  audit('asset', id, 'archive', user, before, getRecord('assets', id));
  res.status(204).end();
}));

const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  account_type: z.enum(['investment', 'bank', 'e_wallet', 'cash', 'credit', 'other']).default('other'),
  default_currency_id: optionalId,
  category: z.string().trim().max(20).optional().default('其他')
});

router.get('/accounts', handler(async (req, res) => {
  const archivedOnly = req.query.archived === '1';
  const accountValues = new Map();
  for (const asset of wealth.valueAssets()) {
    accountValues.set(asset.accountId, wealth.money((accountValues.get(asset.accountId) || 0) + asset.marketValueCny));
  }
  let accounts = db.prepare(`
    SELECT p.*, c.code AS currency_code,
           COUNT(CASE WHEN a.archived_at IS NULL THEN a.id END) AS asset_count
    FROM platforms p
    LEFT JOIN currencies c ON c.id = p.default_currency_id
    LEFT JOIN assets a ON a.platform_id = p.id
    WHERE p.archived_at IS ${archivedOnly ? 'NOT NULL' : 'NULL'}
    GROUP BY p.id
    ORDER BY p.name
  `).all().map((account) => ({
    ...account,
    market_value_cny: accountValues.get(account.id) || 0
  }));
  if (req.query.q) {
    const q = String(req.query.q).toLowerCase();
    accounts = accounts.filter((item) => item.name.toLowerCase().includes(q));
  }
  if (req.query.type) accounts = accounts.filter((item) => item.account_type === req.query.type);
  accounts.sort((a, b) => req.query.sort === 'value' ? b.market_value_cny - a.market_value_cny : a.name.localeCompare(b.name, 'zh-CN'));
  sendList(res, accounts, req.query);
}));

router.post('/accounts', handler(async (req, res) => {
  const input = parse(accountSchema, req.body);
  if (db.prepare('SELECT 1 FROM platforms WHERE name = ? COLLATE NOCASE').get(input.name)) {
    return fail(res, 409, 'ACCOUNT_NAME_EXISTS', '账户名称已存在，请使用不同名称');
  }
  const user = username(req);
  const result = db.prepare(`
    INSERT INTO platforms (name, account_type, default_currency_id, category, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(input.name, input.account_type, input.default_currency_id || null, input.category, user, user);
  const id = Number(result.lastInsertRowid);
  const record = getRecord('platforms', id);
  audit('account', id, 'create', user, null, record);
  res.status(201);
  ok(res, record);
}));

router.patch('/accounts/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const input = parse(accountSchema.partial(), req.body);
  const before = getRecord('platforms', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '账户不存在');
  if (input.name && db.prepare('SELECT 1 FROM platforms WHERE name = ? COLLATE NOCASE AND id <> ?').get(input.name, id)) {
    return fail(res, 409, 'ACCOUNT_NAME_EXISTS', '账户名称已存在，请使用不同名称');
  }
  const user = username(req);
  updateRecord('platforms', id, input, ['name', 'account_type', 'default_currency_id', 'category', 'updated_by', 'updated_at'], user);
  const after = getRecord('platforms', id);
  audit('account', id, 'update', user, before, after);
  ok(res, after);
}));

router.delete('/accounts/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const activeAssets = db.prepare('SELECT COUNT(*) AS count FROM assets WHERE platform_id = ? AND archived_at IS NULL').get(id).count;
  if (activeAssets) return fail(res, 409, 'ACCOUNT_NOT_EMPTY', '请先处理该账户中的资产');
  const before = getRecord('platforms', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '账户不存在');
  const user = username(req);
  db.prepare('UPDATE platforms SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, id);
  audit('account', id, 'archive', user, before, getRecord('platforms', id));
  res.status(204).end();
}));

router.post('/accounts/:id/restore', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const before = getRecord('platforms', id);
  if (!before || !before.archived_at) return fail(res, 404, 'NOT_FOUND', '已归档账户不存在');
  const user = username(req);
  db.prepare('UPDATE platforms SET archived_at = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, id);
  const after = getRecord('platforms', id);
  audit('account', id, 'restore', user, before, after);
  ok(res, after);
}));

router.get('/asset-classes', handler(async (_req, res) => {
  ok(res, Object.values(wealth.CLASS_META));
}));

router.get('/meta', handler(async (_req, res) => {
  ok(res, {
    currencies: db.prepare('SELECT * FROM currencies ORDER BY code').all(),
    assetTypes: db.prepare('SELECT * FROM asset_types ORDER BY asset_class_code, name').all(),
    categories: db.prepare('SELECT * FROM household_categories WHERE archived_at IS NULL ORDER BY kind DESC, sort_order, name').all(),
    accounts: db.prepare('SELECT * FROM platforms WHERE archived_at IS NULL ORDER BY name').all(),
    accountTypes: [
      { code: 'investment', label: '投资账户' }, { code: 'bank', label: '银行账户' },
      { code: 'e_wallet', label: '电子钱包' }, { code: 'cash', label: '现金账户' },
      { code: 'credit', label: '信用账户' }, { code: 'other', label: '其他账户' }
    ]
  });
}));

router.post('/market/refresh', handler(async (_req, res) => {
  const status = wealth.getMarketStatus();
  if (status.state === 'running') return fail(res, 409, 'REFRESH_RUNNING', '行情正在更新');
  if (status.finishedAt && Date.now() - new Date(status.finishedAt).getTime() < 60_000) {
    return fail(res, 429, 'REFRESH_COOLDOWN', '请在一分钟后再次手动刷新');
  }
  wealth.refreshMarket();
  res.status(202);
  ok(res, wealth.getMarketStatus());
}));

router.get('/market/status', handler(async (_req, res) => ok(res, wealth.getMarketStatus())));

const budgetSchema = z.object({
  month: monthString,
  items: z.array(z.object({ category_id: idSchema, planned_amount_cny: z.coerce.number().nonnegative() }))
});

router.get('/household/budgets', handler(async (req, res) => {
  ok(res, wealth.getHouseholdSummary(req.query.month));
}));

const householdPlanSettingsSchema = z.object({
  opening_amount: z.coerce.number().nonnegative(),
  opening_currency_id: idSchema,
  planning_rate_to_cny: z.coerce.number().positive(),
  start_month: monthString,
  end_month: monthString
}).refine((value) => value.start_month <= value.end_month, {
  message: '结束月份不能早于开始月份', path: ['end_month']
}).refine((value) => {
  const [startYear, startMonth] = value.start_month.split('-').map(Number);
  const [endYear, endMonth] = value.end_month.split('-').map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth < 120;
}, {
  message: '规划区间最多支持 120 个月', path: ['end_month']
});

router.get('/household/plan', handler(async (_req, res) => {
  ok(res, wealth.getHouseholdPlan());
}));

router.put('/household/plan/settings', handler(async (req, res) => {
  const input = parse(householdPlanSettingsSchema, req.body);
  const currency = db.prepare('SELECT code FROM currencies WHERE id = ?').get(input.opening_currency_id);
  if (!currency) return fail(res, 400, 'INVALID_CURRENCY', '期初金额币种不存在');
  if (currency.code === 'CNY' && input.planning_rate_to_cny !== 1) {
    return fail(res, 400, 'INVALID_FX_RATE', '人民币规划汇率必须为 1');
  }
  const user = username(req);
  const plan = db.transaction(() => {
    const before = db.prepare('SELECT * FROM household_plan_settings WHERE id = 1').get();
    db.prepare(`
    INSERT INTO household_plan_settings (
      id, opening_amount, opening_currency_id, planning_rate_to_cny,
      start_month, end_month, created_by, updated_by, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      opening_amount = excluded.opening_amount,
      opening_currency_id = excluded.opening_currency_id,
      planning_rate_to_cny = excluded.planning_rate_to_cny,
      start_month = excluded.start_month,
      end_month = excluded.end_month,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
    `).run(
      input.opening_amount, input.opening_currency_id, input.planning_rate_to_cny,
      input.start_month, input.end_month, user, user
    );
    const after = db.prepare('SELECT * FROM household_plan_settings WHERE id = 1').get();
    audit('household_plan_settings', 1, 'update', user, before, after);
    return wealth.getHouseholdPlan();
  })();
  ok(res, plan);
}));

router.put('/household/budgets', handler(async (req, res) => {
  const input = parse(budgetSchema, req.body);
  const user = username(req);
  const upsert = db.prepare(`
    INSERT INTO monthly_budgets (month, category_id, planned_amount_cny, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(month, category_id) DO UPDATE SET
      planned_amount_cny = excluded.planned_amount_cny,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const item of input.items) upsert.run(input.month, item.category_id, item.planned_amount_cny, user, user);
  })();
  audit('monthly_budget', null, 'upsert', user, null, input);
  ok(res, wealth.getHouseholdSummary(input.month));
}));

router.post('/household/budgets/copy', handler(async (req, res) => {
  const input = parse(z.object({ fromMonth: monthString, toMonth: monthString }), req.body);
  const user = username(req);
  const rows = db.prepare('SELECT category_id, planned_amount_cny FROM monthly_budgets WHERE month = ?').all(input.fromMonth);
  const insert = db.prepare(`
    INSERT INTO monthly_budgets (month, category_id, planned_amount_cny, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(month, category_id) DO UPDATE SET planned_amount_cny = excluded.planned_amount_cny, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => rows.forEach((row) => insert.run(input.toMonth, row.category_id, row.planned_amount_cny, user, user)))();
  audit('monthly_budget', null, 'copy', user, input, { copied: rows.length });
  ok(res, wealth.getHouseholdSummary(input.toMonth), { copied: rows.length });
}));

const transactionSchema = z.object({
  kind: z.enum(['income', 'expense']),
  amount: z.coerce.number().positive(),
  currency_id: idSchema,
  fx_rate_to_cny: z.coerce.number().positive().optional(),
  category_id: idSchema,
  account_id: optionalId,
  project_id: optionalId,
  occurred_on: dateString,
  note: z.string().trim().max(500).optional().default('')
});
const transactionPatchSchema = transactionSchema.partial().extend({
  linked_action: z.enum(['sync', 'unlink']).optional()
});

function transactionRate(currencyCode, suppliedRate, priorRate) {
  if (currencyCode === 'CNY') {
    if (suppliedRate !== undefined && suppliedRate !== 1) {
      const error = new Error('人民币记账汇率必须为 1');
      error.status = 400;
      error.code = 'INVALID_FX_RATE';
      throw error;
    }
    return 1;
  }
  if (suppliedRate !== undefined) return suppliedRate;
  if (priorRate !== undefined && priorRate !== null) return priorRate;
  const cached = db.prepare('SELECT rate_to_cny FROM exchange_rate_cache WHERE currency_code = ?').get(currencyCode)?.rate_to_cny;
  const rate = Number(cached) || wealth.getStoredRates()[currencyCode];
  if (Number.isFinite(rate) && rate > 0 && (Number(cached) > 0 || rate !== 1)) return rate;
  const error = new Error(`缺少 ${currencyCode} 兑人民币汇率，请填写记账汇率`);
  error.status = 400;
  error.code = 'FX_RATE_REQUIRED';
  throw error;
}

function validTransactionCategory(categoryId, kind) {
  const category = db.prepare('SELECT kind FROM household_categories WHERE id = ? AND archived_at IS NULL').get(categoryId);
  return category?.kind === kind;
}

function transactionList(query = {}) {
  const conditions = ['ht.archived_at IS NULL'];
  const params = [];
  if (query.month) { conditions.push("substr(ht.occurred_on, 1, 7) = ?"); params.push(query.month); }
  if (query.kind) { conditions.push('ht.kind = ?'); params.push(query.kind); }
  if (query.category) { conditions.push('ht.category_id = ?'); params.push(Number(query.category)); }
  if (query.account) { conditions.push('ht.account_id = ?'); params.push(Number(query.account)); }
  if (query.project) { conditions.push('ht.project_id = ?'); params.push(Number(query.project)); }
  if (query.q) { conditions.push("LOWER(COALESCE(ht.note, '') || ' ' || hc.name) LIKE ?"); params.push(`%${String(query.q).toLowerCase()}%`); }
  return db.prepare(`
    SELECT ht.*, c.code AS currency_code, hc.name AS category_name, hc.color AS category_color,
           p.name AS account_name, hp.name AS project_name
    FROM household_transactions ht
    JOIN currencies c ON c.id = ht.currency_id
    JOIN household_categories hc ON hc.id = ht.category_id
    LEFT JOIN platforms p ON p.id = ht.account_id
    LEFT JOIN household_projects hp ON hp.id = ht.project_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ht.occurred_on DESC, ht.id DESC
  `).all(...params);
}

router.get('/household/transactions', handler(async (req, res) => sendList(res, transactionList(req.query), req.query)));

router.post('/household/transactions', handler(async (req, res) => {
  const input = parse(transactionSchema, req.body);
  const currency = db.prepare('SELECT code FROM currencies WHERE id = ?').get(input.currency_id);
  if (!currency) return fail(res, 400, 'INVALID_CURRENCY', '币种不存在');
  if (!validTransactionCategory(input.category_id, input.kind)) {
    return fail(res, 400, 'INVALID_CATEGORY', '分类与收支类型不匹配');
  }
  const rate = transactionRate(currency.code, input.fx_rate_to_cny);
  const amountCny = wealth.money(input.amount * rate);
  const user = username(req);
  const result = db.prepare(`
    INSERT INTO household_transactions (kind, amount, currency_id, fx_rate_to_cny, amount_cny, category_id, account_id, project_id, occurred_on, note, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.kind, input.amount, input.currency_id, rate, amountCny, input.category_id, input.account_id || null, input.project_id || null, input.occurred_on, input.note, user, user);
  const id = Number(result.lastInsertRowid);
  const record = getRecord('household_transactions', id);
  audit('household_transaction', id, 'create', user, null, record);
  res.status(201);
  ok(res, record);
}));

router.patch('/household/transactions/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const input = parse(transactionPatchSchema, req.body);
  const before = getRecord('household_transactions', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '收支记录不存在');
  if (before.linked_cash_flow_id && !input.linked_action) {
    return fail(res, 409, 'LINK_ACTION_REQUIRED', '请先选择同步更新关联资金流或解除关联');
  }
  const merged = { ...before, ...input };
  const currency = db.prepare('SELECT code FROM currencies WHERE id = ?').get(merged.currency_id);
  if (!currency) return fail(res, 400, 'INVALID_CURRENCY', '币种不存在');
  if (!validTransactionCategory(merged.category_id, merged.kind)) {
    return fail(res, 400, 'INVALID_CATEGORY', '分类与收支类型不匹配');
  }
  if (before.linked_cash_flow_id && input.linked_action === 'sync' && !merged.account_id) {
    return fail(res, 400, 'ACCOUNT_REQUIRED', '同步资产资金流前，请先选择账户');
  }
  const rate = transactionRate(
    currency.code,
    input.fx_rate_to_cny,
    input.currency_id && input.currency_id !== before.currency_id ? undefined : before.fx_rate_to_cny
  );
  input.fx_rate_to_cny = rate;
  input.amount_cny = wealth.money(merged.amount * rate);
  const user = username(req);
  let after;
  db.transaction(() => {
    updateRecord('household_transactions', id, input, ['kind', 'amount', 'currency_id', 'fx_rate_to_cny', 'amount_cny', 'category_id', 'account_id', 'project_id', 'occurred_on', 'note', 'updated_by', 'updated_at'], user);
    after = getRecord('household_transactions', id);
    if (before.linked_cash_flow_id && input.linked_action === 'sync') {
      db.prepare(`UPDATE cash_flows SET flow_type = ?, amount = ?, currency_id = ?, account_id = ?, occurred_on = ?, note = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(after.kind === 'income' ? 'deposit' : 'withdrawal', after.amount, after.currency_id, after.account_id, after.occurred_on, after.note, user, before.linked_cash_flow_id);
    } else if (before.linked_cash_flow_id && input.linked_action === 'unlink') {
      db.prepare('UPDATE cash_flows SET source_transaction_id = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, before.linked_cash_flow_id);
      db.prepare('UPDATE household_transactions SET linked_cash_flow_id = NULL WHERE id = ?').run(id);
    }
    after = getRecord('household_transactions', id);
    audit('household_transaction', id, 'update', user, before, after);
  })();
  ok(res, after);
}));

router.delete('/household/transactions/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const before = getRecord('household_transactions', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '收支记录不存在');
  const linkedAction = req.body?.linked_action || req.query.linked_action;
  if (before.linked_cash_flow_id && !['sync', 'unlink'].includes(linkedAction)) {
    return fail(res, 409, 'LINK_ACTION_REQUIRED', '请先选择同步归档关联资金流或解除关联');
  }
  const user = username(req);
  db.transaction(() => {
    db.prepare('UPDATE household_transactions SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, id);
    if (before.linked_cash_flow_id && linkedAction === 'sync') {
      db.prepare('UPDATE cash_flows SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, before.linked_cash_flow_id);
    } else if (before.linked_cash_flow_id && linkedAction === 'unlink') {
      db.prepare('UPDATE cash_flows SET source_transaction_id = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, before.linked_cash_flow_id);
      db.prepare('UPDATE household_transactions SET linked_cash_flow_id = NULL WHERE id = ?').run(id);
    }
  })();
  audit('household_transaction', id, 'archive', user, before, getRecord('household_transactions', id));
  res.status(204).end();
}));

router.post('/household/transactions/:id/link-cash-flow', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const transaction = getRecord('household_transactions', id);
  if (!transaction || transaction.archived_at) return fail(res, 404, 'NOT_FOUND', '收支记录不存在');
  if (transaction.linked_cash_flow_id) return fail(res, 409, 'ALREADY_LINKED', '该记录已经关联资产资金流');
  const input = parse(z.object({ account_id: optionalId, note: z.string().max(500).optional() }), req.body || {});
  const accountId = input.account_id || transaction.account_id;
  if (!accountId) return fail(res, 400, 'ACCOUNT_REQUIRED', '关联资产资金流前，请先为这笔收支选择账户');
  const user = username(req);
  const flowType = transaction.kind === 'income' ? 'deposit' : 'withdrawal';
  let flowId;
  db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO cash_flows (flow_type, amount, currency_id, account_id, occurred_on, note, source_transaction_id, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(flowType, transaction.amount, transaction.currency_id, accountId, transaction.occurred_on, input.note || transaction.note, id, user, user);
    flowId = Number(result.lastInsertRowid);
    db.prepare('UPDATE household_transactions SET linked_cash_flow_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(flowId, user, id);
  })();
  audit('household_transaction', id, 'link_cash_flow', user, transaction, getRecord('household_transactions', id));
  ok(res, { transactionId: id, cashFlowId: flowId });
}));

router.delete('/household/transactions/:id/cash-flow-link', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const transaction = getRecord('household_transactions', id);
  if (!transaction || !transaction.linked_cash_flow_id) return fail(res, 404, 'NOT_LINKED', '该记录没有关联资金流');
  const user = username(req);
  db.transaction(() => {
    db.prepare('UPDATE cash_flows SET source_transaction_id = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, transaction.linked_cash_flow_id);
    db.prepare('UPDATE household_transactions SET linked_cash_flow_id = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user, id);
  })();
  audit('household_transaction', id, 'unlink_cash_flow', user, transaction, getRecord('household_transactions', id));
  res.status(204).end();
}));

function crudRoutes(path, table, entity, schema, createColumns, updateColumns) {
  router.get(path, handler(async (_req, res) => {
    ok(res, db.prepare(`SELECT * FROM ${table} WHERE archived_at IS NULL ORDER BY id DESC`).all());
  }));
  router.post(path, handler(async (req, res) => {
    const input = parse(schema, req.body);
    const user = username(req);
    const columns = [...createColumns, 'created_by', 'updated_by'];
    const values = [...createColumns.map((column) => input[column] ?? null), user, user];
    const result = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
    const id = Number(result.lastInsertRowid);
    const record = getRecord(table, id);
    audit(entity, id, 'create', user, null, record);
    res.status(201);
    ok(res, record);
  }));
  router.patch(`${path}/:id`, handler(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const input = parse(schema.partial(), req.body);
    const before = getRecord(table, id);
    if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '记录不存在');
    const user = username(req);
    updateRecord(table, id, input, [...updateColumns, 'updated_by', 'updated_at'], user);
    const after = getRecord(table, id);
    audit(entity, id, 'update', user, before, after);
    ok(res, after);
  }));
  router.delete(`${path}/:id`, handler(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const before = getRecord(table, id);
    if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '记录不存在');
    const user = username(req);
    db.prepare(`UPDATE ${table} SET archived_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user, id);
    audit(entity, id, 'archive', user, before, getRecord(table, id));
    res.status(204).end();
  }));
}

const projectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  target_amount_cny: z.coerce.number().nonnegative(),
  start_date: dateString.nullable().optional(),
  end_date: dateString.nullable().optional(),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']).default('planned'),
  note: z.string().trim().max(500).optional().default('')
});
crudRoutes('/household/projects', 'household_projects', 'household_project', projectSchema,
  ['name', 'target_amount_cny', 'start_date', 'end_date', 'status', 'note'],
  ['name', 'target_amount_cny', 'start_date', 'end_date', 'status', 'note']);

const memoSchema = z.object({
  kind: z.enum(['income', 'expense']),
  title: z.string().trim().min(1).max(160),
  expected_amount: z.coerce.number().nonnegative(),
  currency_id: idSchema,
  due_date: dateString,
  account_id: optionalId,
  category_id: optionalId,
  reminder_days: z.coerce.number().int().min(0).max(365).default(7),
  status: z.enum(['pending', 'completed', 'cancelled']).default('pending'),
  note: z.string().trim().max(500).optional().default(''),
  completed_transaction_id: optionalId
});
crudRoutes('/household/memos', 'financial_memos', 'financial_memo', memoSchema,
  ['kind', 'title', 'expected_amount', 'currency_id', 'due_date', 'account_id', 'category_id', 'reminder_days', 'status', 'note', 'completed_transaction_id'],
  ['kind', 'title', 'expected_amount', 'currency_id', 'due_date', 'account_id', 'category_id', 'reminder_days', 'status', 'note', 'completed_transaction_id']);

router.post('/household/memos/:id/complete', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const memo = getRecord('financial_memos', id);
  if (!memo || memo.archived_at) return fail(res, 404, 'NOT_FOUND', '备忘不存在');
  if (memo.status !== 'pending') return fail(res, 409, 'MEMO_NOT_PENDING', '该备忘已经处理');
  const input = parse(z.object({
    create_transaction: z.boolean().default(false),
    category_id: optionalId,
    account_id: optionalId,
    fx_rate_to_cny: z.coerce.number().positive().optional(),
    link_cash_flow: z.boolean().default(false)
  }), req.body || {});
  const categoryId = input.category_id || memo.category_id;
  if (input.create_transaction && !categoryId) return fail(res, 400, 'CATEGORY_REQUIRED', '生成实际收支前需要选择分类');
  if (input.create_transaction && !validTransactionCategory(categoryId, memo.kind)) {
    return fail(res, 400, 'INVALID_CATEGORY', '分类与收入或支出类型不匹配');
  }
  const currency = input.create_transaction
    ? db.prepare('SELECT code FROM currencies WHERE id = ?').get(memo.currency_id)
    : null;
  if (input.create_transaction && !currency) return fail(res, 400, 'INVALID_CURRENCY', '备忘币种不存在');
  const rate = input.create_transaction ? transactionRate(currency.code, input.fx_rate_to_cny) : null;
  const user = username(req);
  let transactionId = null;
  let cashFlowId = null;
  db.transaction(() => {
    if (input.create_transaction) {
      const transaction = db.prepare(`
        INSERT INTO household_transactions (kind, amount, currency_id, fx_rate_to_cny, amount_cny, category_id, account_id, occurred_on, note, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(memo.kind, memo.expected_amount, memo.currency_id, rate, wealth.money(memo.expected_amount * rate), categoryId, input.account_id || memo.account_id || null, wealth.londonDate(), memo.note || memo.title, user, user);
      transactionId = Number(transaction.lastInsertRowid);
      if (input.link_cash_flow) {
        const flow = db.prepare(`
          INSERT INTO cash_flows (flow_type, amount, currency_id, account_id, occurred_on, note, source_transaction_id, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(memo.kind === 'income' ? 'deposit' : 'withdrawal', memo.expected_amount, memo.currency_id, input.account_id || memo.account_id || null, wealth.londonDate(), memo.note || memo.title, transactionId, user, user);
        cashFlowId = Number(flow.lastInsertRowid);
        db.prepare('UPDATE household_transactions SET linked_cash_flow_id = ? WHERE id = ?').run(cashFlowId, transactionId);
      }
    }
    db.prepare('UPDATE financial_memos SET status = ?, completed_transaction_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('completed', transactionId, user, id);
  })();
  const after = getRecord('financial_memos', id);
  audit('financial_memo', id, 'complete', user, memo, { ...after, transactionId, cashFlowId });
  ok(res, { memo: after, transactionId, cashFlowId });
}));

const categorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['income', 'expense']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),
  icon: z.string().trim().max(40).default('circle'),
  sort_order: z.coerce.number().int().default(0)
});
router.get('/household/categories', handler(async (_req, res) => ok(res, db.prepare('SELECT * FROM household_categories WHERE archived_at IS NULL ORDER BY kind DESC, sort_order, name').all())));
router.post('/household/categories', handler(async (req, res) => {
  const input = parse(categorySchema, req.body);
  const user = username(req);
  const result = db.prepare('INSERT INTO household_categories (name, kind, color, icon, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.name, input.kind, input.color, input.icon, input.sort_order, user);
  const id = Number(result.lastInsertRowid);
  const record = getRecord('household_categories', id);
  audit('household_category', id, 'create', user, null, record);
  res.status(201); ok(res, record);
}));
router.patch('/household/categories/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const input = parse(categorySchema.partial(), req.body);
  const before = getRecord('household_categories', id);
  if (!before || before.archived_at) return fail(res, 404, 'NOT_FOUND', '分类不存在');
  updateRecord('household_categories', id, input, ['name', 'kind', 'color', 'icon', 'sort_order'], username(req));
  const after = getRecord('household_categories', id);
  audit('household_category', id, 'update', username(req), before, after);
  ok(res, after);
}));
router.delete('/household/categories/:id', handler(async (req, res) => {
  const id = parse(idSchema, req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS count FROM household_transactions WHERE category_id = ? AND archived_at IS NULL').get(id).count;
  if (used) return fail(res, 409, 'CATEGORY_IN_USE', '该分类已有收支记录，不能删除');
  const before = getRecord('household_categories', id);
  db.prepare('UPDATE household_categories SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  audit('household_category', id, 'archive', username(req), before, getRecord('household_categories', id));
  res.status(204).end();
}));

router.get('/integrations/trading212/status', handler(async (_req, res) => {
  ok(res, trading212.getStatus());
}));

router.post('/integrations/trading212/sync', handler(async (req, res) => {
  if (!trading212.configured()) return fail(res, 400, 'NOT_CONFIGURED', 'Trading212 API 凭据未配置');
  const user = username(req);
  const result = await trading212.sync(user);
  audit('integration', null, 'trading212_sync', user, null, result);
  ok(res, result);
}));

module.exports = router;
