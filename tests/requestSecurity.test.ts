import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-request-security-'));
process.env.ASSET_TRACKER_DB_PATH = path.join(temporaryDirectory, 'routes.sqlite');
process.env.NODE_ENV = 'test';
const originalPublicOrigin = process.env.ASSET_TRACKER_PUBLIC_ORIGIN;
delete process.env.ASSET_TRACKER_PUBLIC_ORIGIN;

let db: any;
let routeServer: any;
let routeBaseUrl: string;
let assetId: number;
let child: ChildProcessWithoutNullStreams | undefined;
let websiteBaseUrl: string;
let childOutput = '';
const dangerousUsername = '家庭成员</script><script>window.injected=true</script>\u2028\u2029';

async function availablePort() {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  db = require('../src/services/database.cjs');
  const accountId = Number(db.prepare("INSERT INTO platforms (name, account_type) VALUES ('Origin test', 'bank')").run().lastInsertRowid);
  const cny = db.prepare("SELECT id FROM currencies WHERE code = 'CNY'").get().id;
  const cash = db.prepare("SELECT id FROM asset_types WHERE name = 'cash'").get().id;
  assetId = Number(db.prepare(`
    INSERT INTO assets (platform_id, asset_type_id, currency_id, code, shares, cost_price)
    VALUES (?, ?, ?, 'ORIGIN-CASH', 50, 1)
  `).run(accountId, cash, cny).lastInsertRowid);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { username: 'security-test' };
    next();
  });
  app.use('/api/v2', require('../src/routes/v2.cjs'));
  await new Promise<void>((resolve) => { routeServer = app.listen(0, '127.0.0.1', resolve); });
  routeBaseUrl = `http://127.0.0.1:${routeServer.address().port}/api/v2`;

  // Exercise the real SSO middleware and HTML response with an isolated DB and
  // a deterministic local substitute for the upstream token verification call.
  const preloadPath = path.join(temporaryDirectory, 'sso-fixture.cjs');
  fs.writeFileSync(preloadPath, `
    const https = require('node:https');
    const { EventEmitter } = require('node:events');
    const originalGet = https.get;
    https.get = function(url, callback) {
      if (!String(url).startsWith('https://stoneking.top/api/sso/verify?')) {
        return originalGet.apply(this, arguments);
      }
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new EventEmitter();
        callback(response);
        response.emit('data', JSON.stringify({
          valid: new URL(url).searchParams.get('token') === 'sso-fixture-token',
          username: process.env.SECURITY_TEST_USERNAME,
          is_admin: true,
          services: ['asset-tracker']
        }));
        response.emit('end');
      });
      return request;
    };
  `);
  const port = await availablePort();
  websiteBaseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--require', preloadPath, 'src/server.cjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ASSET_TRACKER_DB_PATH: path.join(temporaryDirectory, 'website.sqlite'),
      SECURITY_TEST_USERNAME: dangerousUsername,
      PORT: String(port),
    },
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Security fixture failed to start: ${childOutput}`);
    try {
      const response = await fetch(`${websiteBaseUrl}/health`);
      if (response.ok) return;
    } catch (_) {
      // The listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Security fixture startup timed out: ${childOutput}`);
}, 20000);

afterEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.ASSET_TRACKER_PUBLIC_ORIGIN;
});

afterAll(async () => {
  if (originalPublicOrigin !== undefined) process.env.ASSET_TRACKER_PUBLIC_ORIGIN = originalPublicOrigin;
  if (routeServer) await new Promise<void>((resolve) => routeServer.close(resolve));
  db?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('website mutation request origins', () => {
  it('rejects missing, sibling-site, malformed and external origins before business writes', async () => {
    const beforeAsset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    const beforeAccounts = db.prepare('SELECT COUNT(*) AS count FROM platforms').get().count;
    const beforeAudit = db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count;
    const mutations: Array<[string, string, unknown]> = [
      ['/accounts', 'POST', { name: 'Untrusted write', account_type: 'bank' }],
      [`/assets/${assetId}`, 'PATCH', { shares: 999 }],
      [`/assets/${assetId}`, 'DELETE', undefined],
      ['/household/budgets', 'PUT', { month: '2026-10', items: [] }],
    ];
    for (const origin of [undefined, 'https://stoneking.top', 'https://attacker.example', 'null']) {
      for (const [route, method, body] of mutations) {
        const response = await fetch(`${routeBaseUrl}${route}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('ORIGIN_MISMATCH');
      }
    }
    expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)).toEqual(beforeAsset);
    expect(db.prepare('SELECT COUNT(*) AS count FROM platforms').get().count).toBe(beforeAccounts);
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count).toBe(beforeAudit);
  });

  it('allows same-origin writes and reads without Origin', async () => {
    const response = await fetch(`${routeBaseUrl}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: new URL(routeBaseUrl).origin },
      body: JSON.stringify({ shares: 55 }),
    });
    expect(response.status).toBe(200);
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(assetId).shares).toBe(55);
    expect((await fetch(`${routeBaseUrl}/accounts`)).status).toBe(200);
    expect((await fetch(`${routeBaseUrl}/accounts`, { method: 'HEAD' })).status).toBe(200);
  });

  it('accepts the configured public HTTPS origin behind a proxy', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ASSET_TRACKER_PUBLIC_ORIGIN = 'https://wealth.example';
    const response = await fetch(`${routeBaseUrl}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'https://wealth.example' },
      body: JSON.stringify({ shares: 56 }),
    });
    expect(response.status).toBe(200);
    const insecure = await fetch(`${routeBaseUrl}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: new URL(routeBaseUrl).origin },
      body: JSON.stringify({ shares: 999 }),
    });
    expect(insecure.status).toBe(403);
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(assetId).shares).toBe(56);
  });

  it('keeps the development Vite port exception restricted to matching loopback hosts', async () => {
    process.env.NODE_ENV = 'development';
    const response = await fetch(`${routeBaseUrl}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ shares: 57 }),
    });
    expect(response.status).toBe(200);
    const external = await fetch(`${routeBaseUrl}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://external.example:5173' },
      body: JSON.stringify({ shares: 999 }),
    });
    expect(external.status).toBe(403);
    expect(db.prepare('SELECT shares FROM assets WHERE id = ?').get(assetId).shares).toBe(57);
  });
});

describe('SSO response hardening', () => {
  it('prevents script break-out and caches no credential-bearing HTML while retaining SSO transports', async () => {
    const requests: Array<[string, Record<string, string>]> = [
      ['/?token=sso-fixture-token', {}],
      ['/', { 'X-Auth-Token': 'sso-fixture-token' }],
      ['/', { Cookie: 'session_token=sso-fixture-token' }],
    ];
    for (const [route, headers] of requests) {
      const response = await fetch(`${websiteBaseUrl}${route}`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await response.text();
      const serialized = /<script>window\.__USER__=(.*?);<\/script>/s.exec(html)?.[1];
      expect(serialized).toBeTruthy();
      expect(serialized).not.toContain('<');
      expect(serialized).not.toContain('\u2028');
      expect(serialized).not.toContain('\u2029');
      expect(JSON.parse(serialized!)).toMatchObject({ username: dangerousUsername, token: 'sso-fixture-token' });
      expect(html).not.toContain('<script>window.injected=true</script>');
    }
  });

  it('applies no-referrer to redirects before authentication too', async () => {
    const response = await fetch(`${websiteBaseUrl}/`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
