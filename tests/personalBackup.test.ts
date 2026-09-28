import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { backupDatabase, verifyRestoredCopy } = require('../scripts/backup-database.cjs');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let temporaryDirectory: string;
let sourcePath: string;
let source: any;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-backup-test-'));
  sourcePath = path.join(temporaryDirectory, 'source.sqlite');
});

afterEach(() => {
  source?.close();
  source = undefined;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('personal SQLite backup', () => {
  it('captures committed WAL data and verifies a standalone restored copy', async () => {
    source = new Database(sourcePath);
    source.pragma('journal_mode = WAL');
    source.pragma('wal_autocheckpoint = 0');
    source.exec('CREATE TABLE assets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    source.prepare('INSERT INTO assets (name) VALUES (?)').run('Private sample');
    expect(fs.statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);

    const backupDir = path.join(temporaryDirectory, 'private-backups');
    const file = await backupDatabase({ sourcePath, backupDir });
    expect(file).toMatch(/\.sqlite\.backup$/);
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(backupDir)).toEqual([path.basename(file)]);

    const restored = new Database(file, { readonly: true, fileMustExist: true });
    expect(restored.prepare('SELECT name FROM assets').get().name).toBe('Private sample');
    expect(restored.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    restored.close();
    verifyRestoredCopy(file);
  });

  it('fails for a missing source without creating an empty database or backup', async () => {
    const backupDir = path.join(temporaryDirectory, 'private-backups');
    await expect(backupDatabase({ sourcePath, backupDir })).rejects.toThrow('数据库文件不存在');
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('refuses a backup destination inside the project or one with public permissions', async () => {
    source = new Database(sourcePath);
    source.exec('CREATE TABLE assets (id INTEGER PRIMARY KEY)');
    await expect(backupDatabase({ sourcePath, backupDir: path.join(projectRoot, 'src', 'public', 'backup') }))
      .rejects.toThrow('项目目录之外');
    expect(fs.existsSync(path.join(projectRoot, 'src', 'public', 'backup'))).toBe(false);

    const unsafeDir = path.join(temporaryDirectory, 'unsafe-backups');
    fs.mkdirSync(unsafeDir, { mode: 0o755 });
    await expect(backupDatabase({ sourcePath, backupDir: unsafeDir })).rejects.toThrow('权限为 0700');
    expect(fs.readdirSync(unsafeDir)).toEqual([]);
  });

  it('rejects a corrupt restored copy', () => {
    const corruptFile = path.join(temporaryDirectory, 'corrupt.sqlite');
    fs.writeFileSync(corruptFile, 'not a SQLite database');
    expect(() => verifyRestoredCopy(corruptFile)).toThrow();
  });

  it('does not publish a backup when the source cannot be backed up', async () => {
    fs.writeFileSync(sourcePath, 'not a SQLite database');
    const backupDir = path.join(temporaryDirectory, 'private-backups');
    await expect(backupDatabase({ sourcePath, backupDir })).rejects.toThrow();
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });
});
