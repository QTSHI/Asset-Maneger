const crypto = require('node:crypto');
const { z } = require('zod');
const db = require('./database.cjs');
const wealth = require('./wealthService.cjs');

const PATCH_COLUMNS = [
  'platform_id', 'asset_type_id', 'code', 'name', 'shares', 'cost_price',
  'currency_id', 'quote_code', 'quantity_status', 'valuation_mode',
  'imported_market_value', 'imported_cost_value', 'valuation_as_of'
];
const BALANCE_COLUMNS = [
  'shares', 'cost_price', 'currency_id', 'platform_id', 'asset_type_id',
  'valuation_mode', 'imported_market_value', 'imported_cost_value'
];
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'conflicted'];
const MAX_PENDING_PER_OWNER = 100;
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  '请输入有效日期'
);
const patchSchema = z.object({
  platform_id: z.number().int().positive().optional(),
  asset_type_id: z.number().int().positive().optional(),
  code: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().max(120).optional(),
  shares: z.number().finite().optional(),
  cost_price: z.number().finite().nonnegative().nullable().optional(),
  currency_id: z.number().int().positive().optional(),
  quote_code: z.string().trim().max(40).nullable().optional(),
  quantity_status: z.enum(['missing', 'estimated', 'verified']).optional(),
  valuation_mode: z.enum(['units', 'position_value']).optional(),
  imported_market_value: z.number().finite().nonnegative().nullable().optional(),
  imported_cost_value: z.number().finite().nonnegative().nullable().optional(),
  valuation_as_of: dateString.nullable().optional()
}).strict();

function problem(status, code, message, fields) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (fields) error.fields = fields;
  return error;
}

function requireOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 200) {
    throw problem(401, 'AUTH_REQUIRED', '需要先通过统一登录验证身份');
  }
  return owner;
}

function requireId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw problem(400, 'VALIDATION_ERROR', '无效的编号');
  }
  return id;
}

function audit(entityType, entityId, action, owner, before, after) {
  db.prepare(`
    INSERT INTO audit_log (entity_type, entity_id, action, username, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    entityType, entityId, action, owner,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after)
  );
}

function assetRow(id) {
  return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
}

function assetLabel(id) {
  const row = db.prepare(`
    SELECT a.id, a.code, a.name, p.name AS account_name,
           c.code AS currency_code, at.name AS asset_type_name
    FROM assets a
    LEFT JOIN platforms p ON p.id = a.platform_id
    LEFT JOIN currencies c ON c.id = a.currency_id
    LEFT JOIN asset_types at ON at.id = a.asset_type_id
    WHERE a.id = ?
  `).get(id);
  return row ? {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    accountName: row.account_name || null,
    currencyCode: row.currency_code || null,
    assetTypeName: row.asset_type_name || null
  } : { id, code: null, name: '已删除的资产', accountName: null, currencyCode: null, assetTypeName: null };
}

function proposalView(row) {
  const before = JSON.parse(row.before_json);
  const patch = JSON.parse(row.patch_json);
  return {
    id: row.id,
    assetId: row.asset_id,
    status: row.status,
    agentKeyId: row.agent_key_id ?? null,
    agentLabel: row.agent_label ?? null,
    asset: assetLabel(row.asset_id),
    changes: Object.entries(patch).map(([field, after]) => ({
      field,
      before: before[field] ?? null,
      after
    })),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewerUsername: row.reviewer_username
  };
}

function keyView(row) {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at
  };
}

function validateReferences(patch) {
  const refs = [
    ['platform_id', 'platforms', 'AND archived_at IS NULL', '账户'],
    ['asset_type_id', 'asset_types', '', '资产类型'],
    ['currency_id', 'currencies', '', '货币']
  ];
  for (const [field, table, active, label] of refs) {
    if (patch[field] === undefined) continue;
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? ${active}`).get(patch[field])) {
      throw problem(400, 'INVALID_REFERENCE', `${label}不存在或不可用`, { [field]: `${label}不存在或不可用` });
    }
  }
}

function requireEditableAsset(asset) {
  if (!asset || asset.archived_at) throw problem(404, 'NOT_FOUND', '资产不存在');
  if (asset.external_source && asset.external_source !== 'manual_import') {
    throw problem(409, 'SYNC_MANAGED', '该资产由外部数据源管理，不能由 Agent 提交修改');
  }
  return asset;
}

function listAgentAssets(owner) {
  requireOwner(owner);
  return wealth.valueAssets().sort((a, b) => b.marketValueCny - a.marketValueCny);
}

function getAgentAsset(id, owner) {
  requireOwner(owner);
  const assetId = requireId(id);
  const result = wealth.valueAssets().find((asset) => asset.id === assetId);
  if (!result) throw problem(404, 'NOT_FOUND', '资产不存在');
  return result;
}

function listProposals(owner, status, options = {}) {
  const username = requireOwner(owner);
  if (status !== undefined && !PROPOSAL_STATUSES.includes(status)) {
    throw problem(400, 'VALIDATION_ERROR', '无效的提案状态');
  }
  const page = Number(options.page ?? 1);
  const pageSize = Number(options.pageSize ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw problem(400, 'VALIDATION_ERROR', '分页参数无效');
  }
  const where = status ? 'owner_username = ? AND status = ?' : 'owner_username = ?';
  const joinedWhere = status ? 'p.owner_username = ? AND p.status = ?' : 'p.owner_username = ?';
  const params = status ? [username, status] : [username];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM agent_asset_proposals WHERE ${where}`).get(...params).count;
  const rows = db.prepare(`
    SELECT p.*, k.label AS agent_label
    FROM agent_asset_proposals p
    LEFT JOIN agent_api_keys k ON k.id = p.agent_key_id
    WHERE ${joinedWhere}
    ORDER BY p.id DESC LIMIT ? OFFSET ?
  `)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map(proposalView), total, page, pageSize };
}

function getOwnedProposal(id, owner) {
  const row = db.prepare(`
    SELECT p.*, k.label AS agent_label
    FROM agent_asset_proposals p
    LEFT JOIN agent_api_keys k ON k.id = p.agent_key_id
    WHERE p.id = ? AND p.owner_username = ?
  `).get(requireId(id), requireOwner(owner));
  if (!row) throw problem(404, 'NOT_FOUND', '修改提案不存在');
  return row;
}

function proposeAssetPatch({ assetId, patch, owner, agentKeyId, idempotencyKey } = {}) {
  const username = requireOwner(owner);
  const id = requireId(assetId);
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.') || 'patch'] = issue.message;
    throw problem(400, 'VALIDATION_ERROR', '资产修改内容无效', fields);
  }
  const orderedPatch = Object.fromEntries(
    PATCH_COLUMNS.filter((field) => parsed.data[field] !== undefined).map((field) => [field, parsed.data[field]])
  );
  if (!Object.keys(orderedPatch).length) throw problem(400, 'EMPTY_PATCH', '请至少修改一项资产信息');
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120)) {
    throw problem(400, 'VALIDATION_ERROR', '幂等键格式无效');
  }
  const requestKey = idempotencyKey || null;
  return db.transaction(() => {
    let verifiedAgentKeyId = null;
    if (agentKeyId !== undefined && agentKeyId !== null) {
      verifiedAgentKeyId = requireId(agentKeyId);
      const key = db.prepare('SELECT owner_username, expires_at, revoked_at FROM agent_api_keys WHERE id = ?').get(verifiedAgentKeyId);
      const expiresAt = key ? Date.parse(key.expires_at) : NaN;
      if (!key || key.owner_username !== username || key.revoked_at || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw problem(403, 'AGENT_KEY_INACTIVE', 'Agent 凭证已失效或不属于当前用户');
      }
    }
    if (requestKey) {
      const prior = db.prepare('SELECT * FROM agent_asset_proposals WHERE owner_username = ? AND idempotency_key = ?').get(username, requestKey);
      if (prior) {
        const original = JSON.parse(prior.before_json);
        const expectedPatch = Object.fromEntries(
          Object.entries(orderedPatch).filter(([field, value]) => value !== original[field])
        );
        if (prior.asset_id !== id || prior.agent_key_id !== verifiedAgentKeyId ||
            prior.patch_json !== JSON.stringify(expectedPatch)) {
          throw problem(409, 'IDEMPOTENCY_CONFLICT', '此请求编号已用于另一项修改');
        }
        return proposalView(getOwnedProposal(prior.id, username));
      }
    }
    const before = requireEditableAsset(assetRow(id));
    validateReferences(orderedPatch);
    const changedPatch = Object.fromEntries(Object.entries(orderedPatch).filter(([field, value]) => value !== before[field]));
    if (!Object.keys(changedPatch).length) throw problem(400, 'NO_CHANGE', '修改内容与当前资产一致');
    const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM agent_asset_proposals WHERE owner_username = ? AND status = 'pending'").get(username).count;
    if (pendingCount >= MAX_PENDING_PER_OWNER) {
      throw problem(429, 'TOO_MANY_PENDING', '待确认修改过多，请先在网站处理');
    }
    const createdAt = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO agent_asset_proposals
        (owner_username, asset_id, agent_key_id, status, before_json, patch_json, idempotency_key, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(username, id, verifiedAgentKeyId, JSON.stringify(before), JSON.stringify(changedPatch), requestKey, createdAt);
    const row = getOwnedProposal(Number(result.lastInsertRowid), username);
    const view = proposalView(row);
    audit('agent_asset_proposal', row.id, 'propose', username, null, view);
    return view;
  }).immediate();
}

function approveProposal(id, reviewer) {
  const username = requireOwner(reviewer);
  const proposalId = requireId(id);
  const outcome = db.transaction(() => {
    const proposal = getOwnedProposal(proposalId, username);
    if (proposal.status !== 'pending') throw problem(409, 'ALREADY_REVIEWED', '这项修改已经处理');
    const before = JSON.parse(proposal.before_json);
    const current = assetRow(proposal.asset_id);
    const patch = JSON.parse(proposal.patch_json);
    let referencesChanged = false;
    try {
      validateReferences(patch);
    } catch (error) {
      if (error.code !== 'INVALID_REFERENCE') throw error;
      referencesChanged = true;
    }
    if (!current || current.archived_at || JSON.stringify(current) !== proposal.before_json ||
        (current.external_source && current.external_source !== 'manual_import') || referencesChanged) {
      const reviewedAt = new Date().toISOString();
      db.prepare(`
        UPDATE agent_asset_proposals
        SET status = 'conflicted', reviewed_at = ?, reviewer_username = ?
        WHERE id = ?
      `).run(reviewedAt, username, proposalId);
      const view = proposalView(getOwnedProposal(proposalId, username));
      audit('agent_asset_proposal', proposalId, 'conflicted', username, proposalView(proposal), view);
      return { conflict: true, view };
    }
    const balanceIdentityChanged = BALANCE_COLUMNS.some((field) => patch[field] !== undefined && patch[field] !== current[field]);
    const entries = Object.entries(patch);
    const assignments = entries.map(([field]) => `${field} = ?`);
    if (balanceIdentityChanged) assignments.push('cash_confirmed_at = NULL');
    assignments.push('updated_by = ?', 'updated_at = ?');
    db.prepare(`UPDATE assets SET ${assignments.join(', ')} WHERE id = ?`).run(
      ...entries.map(([, value]) => value), username, new Date().toISOString(), proposal.asset_id
    );
    const after = assetRow(proposal.asset_id);
    db.prepare(`
      UPDATE agent_asset_proposals
      SET status = 'approved', reviewed_at = ?, reviewer_username = ?
      WHERE id = ?
    `).run(new Date().toISOString(), username, proposalId);
    const view = proposalView(getOwnedProposal(proposalId, username));
    audit('asset', proposal.asset_id, 'agent_proposal_approved', username, before, after);
    audit('agent_asset_proposal', proposalId, 'approve', username, proposalView(proposal), view);
    return { conflict: false, view };
  }).immediate();
  if (outcome.conflict) throw problem(409, 'STALE_PROPOSAL', '资产已有变化，请让 Agent 重新提交修改');
  return outcome.view;
}

function rejectProposal(id, reviewer) {
  const username = requireOwner(reviewer);
  return db.transaction(() => {
    const proposal = getOwnedProposal(id, username);
    if (proposal.status !== 'pending') throw problem(409, 'ALREADY_REVIEWED', '这项修改已经处理');
    db.prepare(`
      UPDATE agent_asset_proposals
      SET status = 'rejected', reviewed_at = ?, reviewer_username = ?
      WHERE id = ?
    `).run(new Date().toISOString(), username, proposal.id);
    const view = proposalView(getOwnedProposal(proposal.id, username));
    audit('agent_asset_proposal', proposal.id, 'reject', username, proposalView(proposal), view);
    return view;
  }).immediate();
}

function listAgentKeys(owner) {
  const username = requireOwner(owner);
  return db.prepare('SELECT * FROM agent_api_keys WHERE owner_username = ? ORDER BY id DESC').all(username).map(keyView);
}

function createAgentKey(owner, label, expiresInDays = 90) {
  const username = requireOwner(owner);
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 80) {
    throw problem(400, 'VALIDATION_ERROR', '请输入不超过 80 字的密钥名称');
  }
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw problem(400, 'VALIDATION_ERROR', '有效期应为 1 到 365 天');
  }
  const token = `swag_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInDays * 86400000).toISOString();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 13);
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO agent_api_keys (owner_username, label, token_hash, token_prefix, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, label.trim(), tokenHash, prefix, createdAt, expiresAt);
    const row = db.prepare('SELECT * FROM agent_api_keys WHERE id = ?').get(Number(result.lastInsertRowid));
    const view = keyView(row);
    audit('agent_api_key', row.id, 'create', username, null, view);
    return { ...view, token };
  }).immediate();
}

function revokeAgentKey(id, owner) {
  const username = requireOwner(owner);
  return db.transaction(() => {
    const keyId = requireId(id);
    const row = db.prepare('SELECT * FROM agent_api_keys WHERE id = ? AND owner_username = ?').get(keyId, username);
    if (!row) throw problem(404, 'NOT_FOUND', '密钥不存在');
    if (!row.revoked_at) {
      db.prepare('UPDATE agent_api_keys SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), keyId);
      audit('agent_api_key', keyId, 'revoke', username, keyView(row), keyView(db.prepare('SELECT * FROM agent_api_keys WHERE id = ?').get(keyId)));
    }
  }).immediate();
}

function verifyAgentToken(raw) {
  if (typeof raw !== 'string' || !/^swag_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const row = db.prepare('SELECT * FROM agent_api_keys WHERE token_hash = ? AND revoked_at IS NULL').get(hash);
  const expiresAt = row ? Date.parse(row.expires_at) : NaN;
  if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  db.prepare('UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return { id: row.id, ownerUsername: row.owner_username, label: row.label, expiresAt: row.expires_at };
}

module.exports = {
  PATCH_COLUMNS,
  verifyAgentToken,
  listAgentAssets,
  getAgentAsset,
  proposeAssetPatch,
  listProposals,
  approveProposal,
  rejectProposal,
  listAgentKeys,
  createAgentKey,
  revokeAgentKey
};
