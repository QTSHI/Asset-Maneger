import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const express = require('express');
const { runBackupMaintenance, acquireLock } = require('../scripts/backup-maintenance.cjs');
const { getBackupStatus, readRecord, writeRecord, STATUS_NAME, LOCK_NAME } = require('../src/services/backupStatus.cjs');
const { createBackupStatusRouter } = require('../src/routes/backupStatus.cjs');
const { checkBackup } = require('../scripts/check-backup.cjs');

let temporaryDirectory: string;
let sourcePath: string;
let backupDir: string;
let source: any;
const servers: any[] = [];

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-backup-ops-test-'));
  sourcePath = path.join(temporaryDirectory, 'source.sqlite');
  backupDir = path.join(temporaryDirectory, 'backups');
  source = new Database(sourcePath);
  source.pragma('journal_mode = WAL');
  source.exec('CREATE TABLE assets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  source.prepare('INSERT INTO assets (name) VALUES (?)').run('Private household sample');
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  source?.close();
  source = undefined;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('verified backup maintenance', () => {
  it('records a verified success, retains only its own old finalized copies and leaves unknown files alone', async () => {
    const options = { sourcePath, backupDir, keep: 2 };
    const first = await runBackupMaintenance(options);
    const second = await runBackupMaintenance(options);
    const unrelated = path.join(backupDir, 'asset-tracker-20260101T000000Z-aaaaaaaaaaaaaaaa.sqlite.backup');
    fs.writeFileSync(unrelated, 'manual or unknown backup', { mode: 0o600 });
    const third = await runBackupMaintenance(options);

    expect(fs.existsSync(first.file)).toBe(false);
    expect(fs.existsSync(second.file)).toBe(true);
    expect(fs.existsSync(third.file)).toBe(true);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('manual or unknown backup');
    expect(third.removed).toBe(1);
    expect(readRecord(backupDir).backups).toHaveLength(2);
    expect(fs.statSync(path.join(backupDir, STATUS_NAME)).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(backupDir, LOCK_NAME))).toBe(false);
    const status = getBackupStatus(options);
    expect(status.state).toBe('healthy');
    expect(status.lastSuccessAt).toBe(third.completedAt);
    expect(status.freshnessHours).toBe(36);
    expect(checkBackup(options).healthy).toBe(true);
  });

  it('does not remove symlinks, replaced files, or the source database during retention', async () => {
    const options = { sourcePath, backupDir, keep: 2 };
    const first = await runBackupMaintenance(options);
    const second = await runBackupMaintenance(options);
    fs.unlinkSync(first.file);
    fs.symlinkSync(sourcePath, first.file);
    fs.writeFileSync(second.file, 'manually replaced backup');
    const third = await runBackupMaintenance(options);
    const fourth = await runBackupMaintenance(options);
    const fifth = await runBackupMaintenance(options);
    expect(fs.lstatSync(first.file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(second.file, 'utf8')).toBe('manually replaced backup');
    expect(fs.existsSync(third.file)).toBe(false);
    expect(fs.existsSync(fourth.file)).toBe(true);
    expect(fs.existsSync(fifth.file)).toBe(true);
    expect(source.prepare('SELECT COUNT(*) AS count FROM assets').get().count).toBe(1);
  });

  it('preserves existing verified copies on failure and reports a redacted failure', async () => {
    const options = { sourcePath, backupDir, keep: 2 };
    const first = await runBackupMaintenance(options);
    const second = await runBackupMaintenance(options);
    // A missing source produces the same path hash as before; the runner must
    // report failure while preserving the last successful verified copy.
    source.close();
    source = undefined;
    fs.unlinkSync(sourcePath);
    await expect(runBackupMaintenance(options)).rejects.toThrow('数据库文件不存在');
    expect(fs.existsSync(first.file)).toBe(true);
    expect(fs.existsSync(second.file)).toBe(true);
    const status = getBackupStatus(options);
    expect(status.state).toBe('failed');
    expect(status.lastSuccessAt).toBe(second.completedAt);
    expect(status.lastError).toMatch(/源数据库不存在/);
    expect(JSON.stringify(status)).not.toContain(temporaryDirectory);
    expect(JSON.stringify(status)).not.toContain('Private household');
    expect(fs.readdirSync(backupDir).some((name) => name.endsWith('.pending'))).toBe(false);
  });

  it('uses an exclusive lock so a competing runner never changes the active run record', async () => {
    const options = { sourcePath, backupDir, keep: 2 };
    await runBackupMaintenance(options);
    const original = readRecord(backupDir);
    const release = acquireLock(backupDir);
    try {
      await expect(runBackupMaintenance(options)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
      expect(readRecord(backupDir)).toEqual(original);
      expect(fs.statSync(path.join(backupDir, LOCK_NAME)).mode & 0o777).toBe(0o600);
    } finally { release(); }
  });

  it('rejects unsafe retention settings before changing or pruning old copies', async () => {
    const first = await runBackupMaintenance({ sourcePath, backupDir, keep: 2 });
    await expect(runBackupMaintenance({ sourcePath, backupDir, keep: 1 })).rejects.toMatchObject({ code: 'BACKUP_CONFIG' });
    expect(fs.existsSync(first.file)).toBe(true);
    expect(getBackupStatus({ sourcePath, backupDir }).state).toBe('failed');
  });

  it('does not treat missing, stale, changed, or another database’s backups as healthy', async () => {
    const options = { sourcePath, backupDir, keep: 2 };
    expect(getBackupStatus(options).state).toBe('not_run');
    const created = await runBackupMaintenance(options);
    expect(getBackupStatus({ ...options, now: new Date(Date.parse(created.completedAt) + 36 * 3_600_000 + 1_000) }).state).toBe('stale');
    expect(getBackupStatus({ ...options, sourcePath: path.join(temporaryDirectory, 'different.sqlite') }).state).toBe('not_run');
    expect(checkBackup({ ...options, now: new Date(Date.parse(created.completedAt) + 40 * 3_600_000) }).healthy).toBe(false);
    fs.writeFileSync(created.file, 'corrupted after verification');
    expect(getBackupStatus(options).state).toBe('failed');
    expect(getBackupStatus(options).lastError).toMatch(/缺失或发生变化/);
  });

  it('reports running only with a live run lock and makes interrupted runs actionable', async () => {
    const options = { sourcePath, backupDir };
    await runBackupMaintenance(options);
    const record = readRecord(backupDir);
    record.lastAttempt = { state: 'running', startedAt: new Date().toISOString() };
    writeRecord(backupDir, record);
    expect(getBackupStatus(options).state).toBe('failed');
    const release = acquireLock(backupDir);
    try {
      expect(getBackupStatus(options).state).toBe('running');
      expect(getBackupStatus({ ...options, now: new Date(Date.now() + 3 * 3_600_000) }).state).toBe('failed');
    } finally { release(); }
  });

  it('returns failure for corrupt or linked metadata without exposing filenames or parser errors', async () => {
    const options = { sourcePath, backupDir };
    await runBackupMaintenance(options);
    const marker = path.join(backupDir, STATUS_NAME);
    fs.writeFileSync(marker, `{"private":"${sourcePath}", invalid`);
    expect(getBackupStatus(options).state).toBe('failed');
    expect(JSON.stringify(getBackupStatus(options))).not.toContain(sourcePath);
    fs.unlinkSync(marker);
    fs.symlinkSync(sourcePath, marker);
    expect(getBackupStatus(options).state).toBe('failed');
    await expect(runBackupMaintenance(options)).rejects.toThrow();
    expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
  });

  it('serves only friendly read-only backup metadata, ignoring request path parameters', async () => {
    await runBackupMaintenance({ sourcePath, backupDir });
    const app = express();
    app.use('/backup', createBackupStatusRouter({ sourcePath, backupDir }));
    const server: any = await new Promise((resolve) => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running));
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/backup/status?backupDir=/etc&sourcePath=/etc/passwd`);
    const text = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text).data.state).toBe('healthy');
    expect(text).not.toContain(temporaryDirectory);
    expect(text).not.toContain('.sqlite');
    expect(text).not.toContain('filename');
    expect(text).not.toContain('sourceHash');
    expect(text).not.toContain('Private household');
  });

  it('CLI health check fails before first backup, succeeds after verification, and runner exits nonzero on failure', () => {
    const env = { ...process.env, ASSET_TRACKER_DB_PATH: sourcePath, ASSET_TRACKER_BACKUP_DIR: backupDir };
    const missing = spawnSync(process.execPath, ['scripts/check-backup.cjs'], { env, encoding: 'utf8' });
    expect(missing.status).toBe(1);
    const backup = spawnSync(process.execPath, ['scripts/backup-maintenance.cjs'], { env, encoding: 'utf8' });
    expect(backup.status).toBe(0);
    const healthy = spawnSync(process.execPath, ['scripts/check-backup.cjs'], { env, encoding: 'utf8' });
    expect(healthy.status).toBe(0);
    const failed = spawnSync(process.execPath, ['scripts/backup-maintenance.cjs'], { env: { ...env, ASSET_TRACKER_BACKUP_KEEP: '1' }, encoding: 'utf8' });
    expect(failed.status).toBe(1);
    const noLongerHealthy = spawnSync(process.execPath, ['scripts/check-backup.cjs'], { env, encoding: 'utf8' });
    expect(noLongerHealthy.status).toBe(1);
    expect(failed.stderr).not.toContain(sourcePath);
  });
});
