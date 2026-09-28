#!/usr/bin/env node

/** Create a consistent, self-contained snapshot of the live SQLite database. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveThroughExistingParent(candidate) {
  let existing = candidate;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.resolve(fs.realpathSync(existing), path.relative(existing, candidate));
}

function resolvePaths(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || process.env.ASSET_TRACKER_DB_PATH || path.join(PROJECT_ROOT, 'database.sqlite'));
  const backupDir = path.resolve(options.backupDir || process.env.ASSET_TRACKER_BACKUP_DIR || path.join(PROJECT_ROOT, '..', 'asset-tracker-backups'));
  const projectRoot = fs.realpathSync(PROJECT_ROOT);

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`数据库文件不存在：${sourcePath}`);
  }

  // Backups contain private financial data. Keep every destination outside the
  // repository (including src/public), even when the caller sets a custom path.
  if (isWithin(projectRoot, resolveThroughExistingParent(backupDir))) {
    throw new Error('备份目录必须位于项目目录之外。');
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(backupDir).isSymbolicLink()) {
    throw new Error('备份目录不能是符号链接。');
  }
  const realBackupDir = fs.realpathSync(backupDir);
  if (isWithin(projectRoot, realBackupDir)) {
    throw new Error('备份目录必须位于项目目录之外。');
  }
  const info = fs.statSync(realBackupDir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('备份目录必须归当前用户所有，且权限为 0700。');
  }

  return { sourcePath, backupDir: realBackupDir };
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
    return finalPath;
  } finally {
    source?.close();
    if (!published) fs.rmSync(pendingPath, { force: true });
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${pendingPath}${suffix}`, { force: true });
    }
  }
}

if (require.main === module) {
  backupDatabase()
    .then((file) => { console.log(`已创建并验证备份：${file}`); })
    .catch((error) => { console.error(`备份失败：${error.message}`); process.exitCode = 1; });
}

module.exports = { backupDatabase, verifyRestoredCopy };
