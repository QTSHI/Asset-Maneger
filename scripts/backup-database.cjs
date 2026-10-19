#!/usr/bin/env node

/** Create a consistent, self-contained snapshot of the live SQLite database. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Database = require('better-sqlite3');
const { resolveBackupDirectory, syncDirectory } = require('../src/services/backupStatus.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolvePaths(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || process.env.ASSET_TRACKER_DB_PATH || path.join(PROJECT_ROOT, 'database.sqlite'));
  const backupDir = path.resolve(options.backupDir || process.env.ASSET_TRACKER_BACKUP_DIR || path.join(PROJECT_ROOT, '..', 'asset-tracker-backups'));
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw Object.assign(new Error(`数据库文件不存在：${sourcePath}`), { code: 'BACKUP_SOURCE_MISSING' });
  }

  return { sourcePath, backupDir: resolveBackupDirectory(backupDir, { create: true }) };
}

function verifyRestoredCopy(backupPath) {
  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stone-wealth-restore-check-'));
  const restoredPath = path.join(restoreDir, 'restored.sqlite');
  let restored;
  try {
    fs.copyFileSync(backupPath, restoredPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(restoredPath, 0o600);
    restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
    const results = restored.pragma('integrity_check');
    if (results.length !== 1 || results[0].integrity_check !== 'ok') {
      throw new Error('恢复副本未通过 SQLite integrity_check。');
    }
    if (!restored.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get()) {
      throw new Error('恢复副本缺少资产表。');
    }
    // A read proves the restored copy can be opened and queried independently.
    restored.prepare('SELECT COUNT(*) AS count FROM assets').get();
  } finally {
    restored?.close();
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }
}

async function backupDatabase(options = {}) {
  const { sourcePath, backupDir } = resolvePaths(options);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const name = `asset-tracker-${stamp}-${randomBytes(8).toString('hex')}.sqlite.backup`;
  const pendingPath = path.join(backupDir, `.${name}.pending`);
  const finalPath = path.join(backupDir, name);
  let source;
  let published = false;
  try {
    // Reserving the destination with wx guarantees mode 0600 throughout the
    // online backup, rather than only fixing permissions after private data lands.
    fs.closeSync(fs.openSync(pendingPath, 'wx', 0o600));
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    await source.backup(pendingPath);
    source.close();
    source = undefined;
    verifyRestoredCopy(pendingPath);
    const fd = fs.openSync(pendingPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(pendingPath, finalPath);
    published = true;
    syncDirectory(backupDir);
    return finalPath;
  } finally {
    source?.close();
    if (!published) fs.rmSync(pendingPath, { force: true });
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${pendingPath}${suffix}`, { force: true });
    }
  }
}

module.exports = { backupDatabase, verifyRestoredCopy };

if (require.main === module) {
  // Keep direct invocation on the same locking/status/retention path as npm.
  const { runBackupMaintenance } = require('./backup-maintenance.cjs');
  runBackupMaintenance()
    .then((result) => console.log(`已创建并验证备份；本任务保留 ${result.kept} 份。`))
    .catch(() => { console.error('备份未完成，请检查备份配置与任务日志。'); process.exitCode = 1; });
}
