/**
 * Disposable browser-test app. All writes go to an OS-temp database, and the
 * real v2 routes run without production SSO, integration keys or schedulers.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const host = '127.0.0.1';
const uiPort = 5273;
const apiPort = 8187;
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-e2e-'));
fs.chmodSync(tempDirectory, 0o700);

// Always replace inherited paths and credentials before importing services.
// A user's development/production database is never opened by this launcher.
process.env.NODE_ENV = 'test';
process.env.ASSET_TRACKER_DB_PATH = path.join(tempDirectory, 'fixture.sqlite');
process.env.ASSET_TRACKER_BACKUP_DIR = path.join(tempDirectory, 'backups');
process.env.ASSET_TRACKER_BACKUP_KEEP = '3';
process.env.ASSET_TRACKER_BACKUP_FRESH_HOURS = '36';
process.env.ASSET_TRACKER_PUBLIC_ORIGIN = `http://${host}:${uiPort}`;
process.env.T212_API_KEY = '';
process.env.T212_API_SECRET = '';

let database;
let apiServer;
let viteServer;
let stopping = false;

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  try {
    if (viteServer) await viteServer.close();
    if (apiServer?.listening) {
      await new Promise((resolve, reject) => {
        apiServer.close((error) => error ? reject(error) : resolve());
        apiServer.closeAllConnections();
      });
    }
  } catch (error) {
    console.error('Browser fixture shutdown failed:', error.message);
    exitCode = 1;
  } finally {
    if (database?.open) database.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    process.exit(exitCode);
  }
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('uncaughtException', (error) => {
  console.error(error);
  void shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  void shutdown(1);
});

async function start() {
  database = require('../src/services/database.cjs');
  const cny = database.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
  const cash = database.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
  const category = database.prepare("SELECT id FROM household_categories WHERE kind = 'expense' ORDER BY id LIMIT 1").get().id;
  const date = new Date().toISOString().slice(0, 10);
  database.transaction(() => {
    const accountId = Number(database.prepare(`
      INSERT INTO platforms (name, account_type, category, default_currency_id, created_by)
      VALUES ('演示银行 · 储蓄', 'bank', '现金类', ?, 'browser-fixture')
    `).run(cny).lastInsertRowid);
    database.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, asset_type_id, platform_id,
                          currency_id, quantity_status, valuation_mode, cash_confirmed_at, created_by)
      VALUES ('E2E-CASH', '演示备用金', 1000, 1, ?, ?, ?, 'verified', 'units', ?, 'browser-fixture')
    `).run(cash, accountId, cny, date);
    database.prepare(`
      INSERT INTO household_transactions (kind, amount, currency_id, fx_rate_to_cny,
                                          amount_cny, category_id, account_id, occurred_on, note, created_by)
      VALUES ('expense', 35, ?, 1, 35, ?, ?, ?, '浏览器测试生活费', 'browser-fixture')
    `).run(cny, category, accountId, date);
  })();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { username: 'browser-fixture', is_admin: true, services: ['asset-tracker'] };
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'browser-fixture' }));
  app.use('/api/v2', require('../src/routes/v2.cjs'));
  await new Promise((resolve, reject) => {
    apiServer = app.listen(apiPort, host, resolve);
    apiServer.once('error', reject);
  });

  const { createServer } = await import('vite');
  viteServer = await createServer({
    configFile: path.join(root, 'vite.config.mjs'),
    mode: 'test',
    server: {
      host,
      port: uiPort,
      strictPort: true,
      proxy: {
        '/api': `http://${host}:${apiPort}`,
        '/health': `http://${host}:${apiPort}`,
      },
    },
  });
  await viteServer.listen();
  console.log(`Browser fixture ready at http://${host}:${uiPort} (disposable synthetic data)`);
}

start().catch((error) => {
  console.error(error);
  void shutdown(1);
});
