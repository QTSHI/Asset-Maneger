/**
 * 数据库服务
 */

const Database = require('better-sqlite3');
const path = require('path');
const { runMigrations } = require('../db/migrations.cjs');

// 生产默认使用正式数据库；本地预览可通过环境变量指定独立副本。
const DB_PATH = process.env.ASSET_TRACKER_DB_PATH
    ? path.resolve(process.cwd(), process.env.ASSET_TRACKER_DB_PATH)
    : path.join(__dirname, '../../database.sqlite');

// 初始化数据库
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建表（如果不存在）
function initTables() {
    // 用户表
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 资产类型表
    db.exec(`
        CREATE TABLE IF NOT EXISTS asset_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )
    `);

    // 平台表
    db.exec(`
        CREATE TABLE IF NOT EXISTS platforms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )
    `);

    // 货币表
    db.exec(`
        CREATE TABLE IF NOT EXISTS currencies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL
        )
    `);

    // 资产表
    db.exec(`
        CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            name TEXT,
            shares REAL NOT NULL,
            cost_price REAL,
            asset_type_id INTEGER,
            platform_id INTEGER,
            currency_id INTEGER,
            user_id INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (asset_type_id) REFERENCES asset_types(id),
            FOREIGN KEY (platform_id) REFERENCES platforms(id),
            FOREIGN KEY (currency_id) REFERENCES currencies(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // 历史记录表
    db.exec(`
        CREATE TABLE IF NOT EXISTS daily_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT UNIQUE NOT NULL,
            total_value REAL,
            total_cost REAL,
            profit REAL,
            profit_percent REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 创建索引
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assets_platform ON assets(platform_id);
        CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type_id);
        CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);
    `);

    console.log('✅ 数据库表已初始化');
}

// 初始化默认数据
function initDefaultData() {
    // 旧表仍保留 user_id 外键，但认证已完全由 SSO 承担。空库使用一个不可登录的
    // 系统占位记录，兼容旧接口的默认值；不会创建本地用户名/密码登录能力。
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount === 0) {
        db.prepare('INSERT INTO users (id, username, password) VALUES (1, ?, ?)')
            .run('__sso_managed__', '!SSO_ONLY_NO_LOCAL_LOGIN!');
    }

    // 检查资产类型
    const typeCount = db.prepare('SELECT COUNT(*) as count FROM asset_types').get().count;
    if (typeCount === 0) {
        const types = ['stock_cn', 'stock_us', 'stock_uk', 'etf', 'lof', 'fund', 'cash', '纸黄金', '加密货币'];
        const insert = db.prepare('INSERT INTO asset_types (name) VALUES (?)');
        types.forEach(t => insert.run(t));
        console.log('✅ 默认资产类型已创建');
    }

    // 检查货币
    const currencyCount = db.prepare('SELECT COUNT(*) as count FROM currencies').get().count;
    if (currencyCount === 0) {
        const currencies = ['CNY', 'USD', 'GBP', 'EUR', 'HKD'];
        const insert = db.prepare('INSERT INTO currencies (code) VALUES (?)');
        currencies.forEach(c => insert.run(c));
        console.log('✅ 默认货币已创建');
    }
}

// 初始化
initTables();
initDefaultData();
runMigrations(db);

module.exports = db;
