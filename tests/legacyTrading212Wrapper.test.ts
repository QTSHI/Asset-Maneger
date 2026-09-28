// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(projectRoot, 'scripts', 'sync-t212.sh');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-sync-wrapper-'));
  const binDirectory = path.join(directory, 'bin');
  fs.mkdirSync(binDirectory);
  const nodeStub = path.join(binDirectory, 'node');
  fs.writeFileSync(nodeStub, [
    '#!/bin/sh',
    'printf "%s\\n" "$1" > "$SYNC_ENTRY_FILE"',
    'printf "%s\\n" "$ASSET_TRACKER_DB_PATH" > "$SYNC_DB_FILE"',
    'pwd > "$SYNC_CWD_FILE"',
    'exit 37'
  ].join('\n'));
  fs.chmodSync(nodeStub, 0o755);
  const env = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH || '/usr/bin:/bin'}`,
    T212_API_KEY: 'test-key',
    T212_API_SECRET: 'test-secret',
    SYNC_ENTRY_FILE: path.join(directory, 'entry.txt'),
    SYNC_DB_FILE: path.join(directory, 'db.txt'),
    SYNC_CWD_FILE: path.join(directory, 'cwd.txt')
  };
  return { directory, env };
}

describe('legacy Trading212 cron entry', () => {
  it('delegates to the new sync with the caller-relative database path and exit status', () => {
    const { directory, env } = fixture();
    try {
      const dbPath = path.join(directory, 'household.sqlite');
      fs.writeFileSync(dbPath, 'existing database sentinel');
      const result = spawnSync('/bin/sh', [wrapper], {
        cwd: directory,
        env: { ...env, ASSET_TRACKER_DB_PATH: 'household.sqlite' },
        encoding: 'utf8'
      });

      expect(result.status).toBe(37);
      expect(fs.readFileSync(env.SYNC_ENTRY_FILE, 'utf8').trim()).toBe(path.join(projectRoot, 'scripts', 'sync-trading212.cjs'));
      expect(fs.realpathSync(fs.readFileSync(env.SYNC_DB_FILE, 'utf8').trim())).toBe(fs.realpathSync(dbPath));
      expect(fs.readFileSync(env.SYNC_CWD_FILE, 'utf8').trim()).toBe(projectRoot);
      expect(fs.readFileSync(dbPath, 'utf8')).toBe('existing database sentinel');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails before launching the sync when the selected database does not exist', () => {
    const { directory, env } = fixture();
    try {
      const dbPath = path.join(directory, 'missing.sqlite');
      const result = spawnSync('/bin/sh', [wrapper], {
        cwd: directory,
        env: { ...env, ASSET_TRACKER_DB_PATH: dbPath },
        encoding: 'utf8'
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('数据库文件不存在');
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.existsSync(env.SYNC_ENTRY_FILE)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
