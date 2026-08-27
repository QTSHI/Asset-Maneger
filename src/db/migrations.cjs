/**
 * Stone Wealth schema migrations.
 * Migrations are additive so the existing production database can be rolled back.
 */

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function ensureColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function applyStoneWealthSchema(db) {
  ensureColumn(db, 'asset_types', "asset_class_code TEXT DEFAULT 'unclassified'");
  ensureColumn(db, 'asset_types', "asset_subtype_code TEXT DEFAULT 'unclassified'");

  ensureColumn(db, 'platforms', "category TEXT DEFAULT '其他'");
  ensureColumn(db, 'platforms', 'default_currency_id INTEGER REFERENCES currencies(id)');
  ensureColumn(db, 'platforms', "account_type TEXT DEFAULT 'other'");
  ensureColumn(db, 'platforms', 'archived_at DATETIME');
  ensureColumn(db, 'platforms', 'created_by TEXT');
  ensureColumn(db, 'platforms', 'updated_by TEXT');
  ensureColumn(db, 'platforms', 'updated_at DATETIME');

  ensureColumn(db, 'assets', 'archived_at DATETIME');
  ensureColumn(db, 'assets', 'created_by TEXT');
  ensureColumn(db, 'assets', 'updated_by TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cash_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_type TEXT NOT NULL CHECK(flow_type IN ('deposit','withdrawal','dividend','interest','fee','tax')),
      amount REAL NOT NULL CHECK(amount >= 0),
      currency_id INTEGER NOT NULL REFERENCES currencies(id),
      account_id INTEGER REFERENCES platforms(id),
      occurred_on TEXT NOT NULL,
      note TEXT,
      source_transaction_id INTEGER UNIQUE,
      created_by TEXT,
      updated_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS quote_cache (
      cache_key TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      price REAL,
      currency_code TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'missing' CHECK(status IN ('fresh','stale','error','missing')),
      error_message TEXT,
      fetched_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS exchange_rate_cache (
      currency_code TEXT PRIMARY KEY,
      rate_to_cny REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'fresh' CHECK(status IN ('fresh','stale','error')),
      error_message TEXT,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL UNIQUE,
      market_value_cny REAL NOT NULL,
      cost_value_cny REAL NOT NULL,
      unrealized_profit_cny REAL NOT NULL,
      net_cash_flow_cny REAL NOT NULL DEFAULT 0,
      day_change_cny REAL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      price REAL,
      market_value_cny REAL NOT NULL,
      cost_value_cny REAL NOT NULL,
      currency_code TEXT NOT NULL,
      rate_to_cny REAL NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(snapshot_date, asset_id)
    );

    CREATE TABLE IF NOT EXISTS household_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
      color TEXT NOT NULL DEFAULT '#0f766e',
      icon TEXT NOT NULL DEFAULT 'circle',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at DATETIME,
      UNIQUE(name, kind)
    );

    CREATE TABLE IF NOT EXISTS monthly_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES household_categories(id),
      planned_amount_cny REAL NOT NULL DEFAULT 0 CHECK(planned_amount_cny >= 0),
      created_by TEXT,
      updated_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      UNIQUE(month, category_id)
    );

    CREATE TABLE IF NOT EXISTS household_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_amount_cny REAL NOT NULL DEFAULT 0 CHECK(target_amount_cny >= 0),
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','completed','cancelled')),
      note TEXT,
      created_by TEXT,
      updated_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS household_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
      amount REAL NOT NULL CHECK(amount >= 0),
      currency_id INTEGER NOT NULL REFERENCES currencies(id),
      fx_rate_to_cny REAL NOT NULL CHECK(fx_rate_to_cny > 0),
      amount_cny REAL NOT NULL CHECK(amount_cny >= 0),
      category_id INTEGER NOT NULL REFERENCES household_categories(id),
      account_id INTEGER REFERENCES platforms(id),
      project_id INTEGER REFERENCES household_projects(id),
      occurred_on TEXT NOT NULL,
      note TEXT,
      linked_cash_flow_id INTEGER REFERENCES cash_flows(id),
      created_by TEXT,
      updated_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS financial_memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
      title TEXT NOT NULL,
      expected_amount REAL NOT NULL DEFAULT 0 CHECK(expected_amount >= 0),
      currency_id INTEGER NOT NULL REFERENCES currencies(id),
      due_date TEXT NOT NULL,
      account_id INTEGER REFERENCES platforms(id),
      category_id INTEGER REFERENCES household_categories(id),
      reminder_days INTEGER NOT NULL DEFAULT 7 CHECK(reminder_days >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
      note TEXT,
      completed_transaction_id INTEGER REFERENCES household_transactions(id),
      created_by TEXT,
      updated_by TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      archived_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      username TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_assets_active_platform ON assets(platform_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_cash_flows_date ON cash_flows(occurred_on, archived_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_month_kind ON household_transactions(occurred_on, kind, archived_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON household_transactions(category_id, occurred_on);
    CREATE INDEX IF NOT EXISTS idx_budgets_month ON monthly_budgets(month);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON household_projects(status, archived_at);
    CREATE INDEX IF NOT EXISTS idx_memos_due_status ON financial_memos(due_date, status, archived_at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, created_at);
  `);

  const mappings = [
    ['cash', 'cash', 'cash'],
    ['fund', 'fund', 'mutual_fund'],
    ['etf', 'fund', 'etf'],
    ['lof', 'fund', 'lof'],
    ['stock_cn', 'stock', 'stock_cn'],
    ['stock_us', 'stock', 'stock_us'],
    ['stock_uk', 'stock', 'stock_uk'],
    ['纸黄金', 'alternative', 'gold'],
    ['gold_paper', 'alternative', 'gold'],
    ['加密货币', 'alternative', 'crypto'],
    ['crypto', 'alternative', 'crypto']
  ];
  const updateType = db.prepare('UPDATE asset_types SET asset_class_code = ?, asset_subtype_code = ? WHERE name = ?');
  for (const [name, assetClass, subtype] of mappings) updateType.run(assetClass, subtype, name);

  db.prepare(`
    UPDATE platforms
    SET account_type = CASE
      WHEN category = '投资类' THEN 'investment'
      WHEN category = '现金类' THEN 'bank'
      ELSE COALESCE(NULLIF(account_type, ''), 'other')
    END
    WHERE account_type IS NULL OR account_type = 'other'
  `).run();

  const categories = [
    ['工资收入', 'income', '#0f766e', 'wallet', 10],
    ['其他收入', 'income', '#2f855a', 'plus', 20],
    ['住房', 'expense', '#496a8f', 'house', 10],
    ['餐饮', 'expense', '#d97706', 'utensils', 20],
    ['交通', 'expense', '#2563eb', 'car', 30],
    ['日用', 'expense', '#7c3aed', 'shopping-bag', 40],
    ['教育', 'expense', '#0891b2', 'book-open', 50],
    ['医疗', 'expense', '#dc2626', 'heart-pulse', 60],
    ['娱乐', 'expense', '#db2777', 'sparkles', 70],
    ['人情往来', 'expense', '#9333ea', 'gift', 80],
    ['其他支出', 'expense', '#64748b', 'circle', 90]
  ];
  const insertCategory = db.prepare(`
    INSERT OR IGNORE INTO household_categories (name, kind, color, icon, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const category of categories) insertCategory.run(...category);

  const cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get();
  if (cny) {
    db.prepare(`
      INSERT INTO exchange_rate_cache (currency_code, rate_to_cny, status, fetched_at)
      VALUES ('CNY', 1, 'fresh', CURRENT_TIMESTAMP)
      ON CONFLICT(currency_code) DO UPDATE SET rate_to_cny = 1
    `).run();
  }

  if (tableExists(db, 'daily_summary')) {
    db.exec(`
      INSERT OR IGNORE INTO portfolio_snapshots (
        snapshot_date, market_value_cny, cost_value_cny, unrealized_profit_cny, net_cash_flow_cny
      )
      SELECT date,
             COALESCE(total_value, 0),
             COALESCE(total_cost, 0),
             COALESCE(total_value, 0) - COALESCE(total_cost, 0),
             0
      FROM daily_summary
      WHERE date IS NOT NULL;
    `);
  }
}

const migrations = [
  { version: '001_stone_wealth_core', run: applyStoneWealthSchema },
  {
    version: '002_integrations',
    run(db) {
      ensureColumn(db, 'assets', 'external_source TEXT');
      ensureColumn(db, 'assets', 'external_id TEXT');
      ensureColumn(db, 'platforms', 'external_source TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS integration_status (
          integration_key TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'idle',
          last_started_at DATETIME,
          last_success_at DATETIME,
          message TEXT,
          details_json TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_external_identity
        ON assets(external_source, external_id)
        WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
      `);
      db.prepare(`
        INSERT OR IGNORE INTO asset_types (name, asset_class_code, asset_subtype_code)
        VALUES ('unclassified', 'unclassified', 'unclassified')
      `).run();
    }
  },
  {
    version: '003_asset_instrument_identity',
    run(db) {
      ensureColumn(db, 'assets', 'quote_code TEXT');
      ensureColumn(db, 'assets', "quantity_status TEXT NOT NULL DEFAULT 'verified'");
      ensureColumn(db, 'assets', "valuation_mode TEXT NOT NULL DEFAULT 'units'");
      ensureColumn(db, 'assets', 'imported_market_value REAL');
      ensureColumn(db, 'assets', 'imported_cost_value REAL');
      ensureColumn(db, 'assets', 'valuation_as_of TEXT');

      // Legacy spreadsheet imports stored a whole position as one synthetic unit.
      // Preserve that value explicitly until a real or estimated quantity is supplied.
      db.exec(`
        UPDATE assets
        SET valuation_mode = 'position_value',
            quantity_status = 'missing',
            imported_market_value = COALESCE(
              imported_market_value,
              (SELECT q.price
               FROM quote_cache q
               JOIN asset_types at ON at.id = assets.asset_type_id
               WHERE q.cache_key = assets.code || '_' || at.name),
              shares * COALESCE(cost_price, 0)
            ),
            imported_cost_value = COALESCE(imported_cost_value, shares * COALESCE(cost_price, 0)),
            valuation_as_of = COALESCE(valuation_as_of, date(created_at))
        WHERE external_source = 'manual_import'
          AND asset_type_id IN (
            SELECT id FROM asset_types WHERE asset_class_code IN ('fund', 'stock', 'alternative')
          );
      `);
    }
  }
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');

  for (const migration of migrations) {
    if (applied.get(migration.version)) continue;
    db.transaction(() => {
      migration.run(db);
      record.run(migration.version);
    })();
  }

  db.pragma('optimize');
}

module.exports = { runMigrations };
