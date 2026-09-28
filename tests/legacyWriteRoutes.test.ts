import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-legacy-route-test-'));
const testDatabasePath = path.join(temporaryDirectory, 'preview.sqlite');

let child: ChildProcessWithoutNullStreams | undefined;
let db: any;
let baseUrl: string;
let childOutput = '';

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: response.status === 204 ? null : await response.json() };
}

beforeAll(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.cjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ASSET_TRACKER_DB_PATH: testDatabasePath,
      PORT: String(port),
    },
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`本地服务启动失败：${childOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        db = new (require('better-sqlite3'))(testDatabasePath, { readonly: true, fileMustExist: true });
        return;
      }
    } catch (_) {
      // The listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待本地服务超时：${childOutput}`);
}, 20000);

afterAll(async () => {
  db?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('retired legacy writes', () => {
  it('rejects every old asset/account write without changing data, while v2 still writes and audits', async () => {
    const account = await request('/api/v2/accounts', 'POST', { name: 'V2 Test Account', account_type: 'bank' });
    expect(account.status).toBe(201);
    const accountId = account.payload.data.id;
    const cashTypeId = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
    const cnyId = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
    const validAsset = {
      platform_id: accountId, asset_type_id: cashTypeId, code: 'CASH-TEST',
      name: 'Cash Test', shares: 100, cost_price: 1, currency_id: cnyId,
    };
    const asset = await request('/api/v2/assets', 'POST', validAsset);
    expect(asset.status).toBe(201);
    const assetId = asset.payload.data.id;
    const before = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    const beforeAccountCount = db.prepare('SELECT COUNT(*) AS count FROM platforms').get().count;
    const beforeAssetCount = db.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
    const beforeAuditCount = db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count;

    const retiredRequests: Array<[string, string, unknown?]> = [
      ['/platforms', 'POST', { name: 'Legacy Account', category: '投资类', default_currency_id: cnyId }],
      ['/assets', 'POST', { ...validAsset, code: 'LEGACY-CASH' }],
      [`/assets/${assetId}`, 'PUT', { ...validAsset, shares: 999 }],
      [`/assets/${assetId}`, 'DELETE'],
    ];
    for (const [route, method, body] of retiredRequests) {
      const result = await request(route, method, body);
      expect(result.status).toBe(410);
      expect(result.payload.error.code).toBe('LEGACY_WRITE_RETIRED');
    }

    expect(db.prepare('SELECT COUNT(*) AS count FROM platforms').get().count).toBe(beforeAccountCount);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count).toBe(beforeAssetCount);
    expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count).toBe(beforeAuditCount);
    expect((await request('/platforms')).status).toBe(200);
    expect((await request('/assets')).status).toBe(200);

    const updated = await request(`/api/v2/assets/${assetId}`, 'PATCH', { shares: 120 });
    expect(updated.status).toBe(200);
    expect(updated.payload.data.shares).toBe(120);
    expect(db.prepare("SELECT action, username FROM audit_log WHERE entity_type = 'asset' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(assetId))
      .toMatchObject({ action: 'update', username: 'local-preview' });
    const archived = await request(`/api/v2/assets/${assetId}`, 'DELETE');
    expect(archived.status).toBe(204);
    expect(db.prepare('SELECT archived_at FROM assets WHERE id = ?').get(assetId).archived_at).not.toBeNull();
  });
});

describe('development database isolation', () => {
  it('refuses an unset path, the production path, and an alias before opening the database', () => {
    // Run a copy in a disposable project layout so this test can never open the real database.
    const fixtureRoot = path.join(temporaryDirectory, 'guard-fixture');
    const fixtureSource = path.join(fixtureRoot, 'src');
    fs.mkdirSync(fixtureSource, { recursive: true });
    fs.copyFileSync(path.join(projectRoot, 'src/server.cjs'), path.join(fixtureSource, 'server.cjs'));
    const productionPath = path.join(fixtureRoot, 'database.sqlite');
    fs.writeFileSync(productionPath, 'disposable fixture');
    fs.symlinkSync(productionPath, path.join(fixtureRoot, 'alias.sqlite'));

    for (const configuredPath of [undefined, 'database.sqlite', 'alias.sqlite']) {
      const env = {
        ...process.env,
        NODE_ENV: 'development',
        NODE_PATH: path.join(projectRoot, 'node_modules'),
        PORT: '0',
      };
      delete env.ASSET_TRACKER_DB_PATH;
      if (configuredPath !== undefined) env.ASSET_TRACKER_DB_PATH = configuredPath;
      const outcome = spawnSync(process.execPath, ['src/server.cjs'], {
        cwd: fixtureRoot, env, encoding: 'utf8', timeout: 10000,
      });
      expect(outcome.status).not.toBe(0);
      expect(outcome.stderr).toContain('本地预览必须设置独立的 ASSET_TRACKER_DB_PATH');
    }
  });
});
