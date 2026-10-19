const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STATUS_NAME = '.asset-tracker-backup-status.json';
const LOCK_NAME = '.asset-tracker-backup.lock';
const BACKUP_NAME = /^asset-tracker-\d{8}T\d{6}Z-[a-f0-9]{16}\.sqlite\.backup$/;
const ERROR_MESSAGES = {
  BACKUP_FAILED: '最近备份未完成，请管理员检查备份任务日志。',
  BACKUP_SOURCE_MISSING: '源数据库不存在，请管理员核对备份任务与网站使用的数据库配置。',
  BACKUP_CONFIG: '备份配置不可用，请管理员检查目录权限与配置。',
  BACKUP_METADATA: '备份记录无法读取，请管理员检查备份任务。',
  BACKUP_MISSING: '最近备份文件已缺失或发生变化，请重新备份。',
  BACKUP_INTERRUPTED: '上次备份尚未完成，请管理员检查任务是否仍在运行。',
  BACKUP_RETENTION: '备份已验证，但旧备份清理失败，请管理员检查任务日志。',
};

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function throughExistingParent(candidate) {
  let existing = candidate;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.resolve(fs.realpathSync(existing), path.relative(existing, candidate));
}

function configuration(options = {}) {
  const env = options.env || process.env;
  const sourcePath = path.resolve(options.sourcePath || env.ASSET_TRACKER_DB_PATH || path.join(PROJECT_ROOT, 'database.sqlite'));
  const backupDir = path.resolve(options.backupDir || env.ASSET_TRACKER_BACKUP_DIR || path.join(PROJECT_ROOT, '..', 'asset-tracker-backups'));
  const freshnessHours = Number(options.freshnessHours ?? env.ASSET_TRACKER_BACKUP_FRESH_HOURS ?? 36);
  if (!Number.isFinite(freshnessHours) || freshnessHours < 1 || freshnessHours > 8760) {
    throw Object.assign(new Error('备份有效期限应为 1 至 8760 小时。'), { code: 'BACKUP_CONFIG' });
  }
  const canonicalSource = throughExistingParent(sourcePath);
  return {
    sourcePath, backupDir, freshnessHours,
    explicitlyConfigured: Boolean(options.backupDir || env.ASSET_TRACKER_BACKUP_DIR),
    sourceHash: createHash('sha256').update(canonicalSource).digest('hex'),
  };
}

// This only validates the one configured directory. Status requests never scan
// the repository, open a database, or accept a path from an HTTP parameter.
function resolveBackupDirectory(backupDir, { create = false } = {}) {
  const projectRoot = fs.realpathSync(PROJECT_ROOT);
  if (isWithin(projectRoot, throughExistingParent(backupDir))) {
    throw new Error('备份目录必须位于项目目录之外。');
  }
  let info;
  try { info = fs.lstatSync(backupDir); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    info = fs.lstatSync(backupDir);
  }
  if (info.isSymbolicLink()) throw new Error('备份目录不能是符号链接。');
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('备份目录必须归当前用户所有，且权限为 0700。');
  }
  const realDirectory = fs.realpathSync(backupDir);
  if (isWithin(projectRoot, realDirectory)) throw new Error('备份目录必须位于项目目录之外。');
  return realDirectory;
}

function privateFileInfo(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('备份记录必须是当前用户所有的私有普通文件。');
  }
  return info;
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validBackupRecord(record) {
  return record && BACKUP_NAME.test(record.filename) && validDate(record.completedAt) &&
    ['dev', 'ino', 'size', 'mtimeMs'].every((key) => Number.isFinite(record[key]) && record[key] >= 0);
}

function readRecord(backupDir) {
  const file = path.join(backupDir, STATUS_NAME);
  try {
    const info = privateFileInfo(file);
    if (info.size > 4 * 1024 * 1024) throw new Error('备份记录过大。');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.sourceHash) ||
        !Array.isArray(record.backups) || !record.backups.every(validBackupRecord) ||
        (record.lastSuccess && !validBackupRecord(record.lastSuccess)) ||
        (record.lastAttempt && (!validDate(record.lastAttempt.startedAt) ||
          !['running', 'success', 'failed'].includes(record.lastAttempt.state) ||
          (record.lastAttempt.finishedAt && !validDate(record.lastAttempt.finishedAt))))) {
      throw new Error('备份记录格式不正确。');
    }
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeRecord(backupDir, record) {
  const pending = path.join(backupDir, `.${STATUS_NAME}-${randomBytes(8).toString('hex')}.pending`);
  try {
    const fd = fs.openSync(pending, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(pending, path.join(backupDir, STATUS_NAME));
    syncDirectory(backupDir);
  } finally { fs.rmSync(pending, { force: true }); }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fileRecord(file, completedAt) {
  const info = privateFileInfo(file);
  return { filename: path.basename(file), completedAt, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
}

function matchesRecord(backupDir, record) {
  if (!validBackupRecord(record)) return false;
  try {
    const info = privateFileInfo(path.join(backupDir, record.filename));
    return ['dev', 'ino', 'size', 'mtimeMs'].every((key) => info[key] === record[key]);
  } catch (_) { return false; }
}

function getBackupStatus(options = {}) {
  const result = {
    configured: false, state: 'unconfigured', lastAttemptAt: null,
    lastSuccessAt: null, ageHours: null, freshnessHours: 36, lastError: null,
  };
  try {
    const config = configuration(options);
    result.freshnessHours = config.freshnessHours;
    result.configured = config.explicitlyConfigured;
    const backupDir = resolveBackupDirectory(config.backupDir);
    if (!backupDir) {
      if (result.configured) result.state = 'not_run';
      return result;
    }
    result.configured = true;
    let record;
    try { record = readRecord(backupDir); } catch (_) {
      return { ...result, state: 'failed', lastError: ERROR_MESSAGES.BACKUP_METADATA };
    }
    if (!record || record.sourceHash !== config.sourceHash) return { ...result, state: 'not_run' };
    const now = options.now ? new Date(options.now).getTime() : Date.now();
    result.lastAttemptAt = record.lastAttempt?.startedAt || null;
    result.lastSuccessAt = record.lastSuccess?.completedAt || null;
    if (result.lastSuccessAt) {
      const age = now - Date.parse(result.lastSuccessAt);
      if (!Number.isFinite(age) || age < -5 * 60 * 1000) {
        return { ...result, state: 'failed', lastError: ERROR_MESSAGES.BACKUP_METADATA };
      }
      result.ageHours = Math.round(Math.max(0, age) / 3_600_000 * 10) / 10;
      if (!matchesRecord(backupDir, record.lastSuccess)) {
        return { ...result, state: 'failed', lastError: ERROR_MESSAGES.BACKUP_MISSING };
      }
    }
    if (record.lastAttempt?.state === 'failed') {
      const message = Object.hasOwn(ERROR_MESSAGES, record.lastAttempt.errorCode) ? ERROR_MESSAGES[record.lastAttempt.errorCode] : ERROR_MESSAGES.BACKUP_FAILED;
      return { ...result, state: 'failed', lastError: message };
    }
    if (record.lastAttempt?.state === 'running') {
      const elapsed = now - Date.parse(record.lastAttempt.startedAt);
      let locked = false;
      try { privateFileInfo(path.join(backupDir, LOCK_NAME)); locked = true; } catch (_) { /* unavailable */ }
      if (locked && elapsed >= 0 && elapsed < 2 * 3_600_000) return { ...result, state: 'running' };
      return { ...result, state: 'failed', lastError: ERROR_MESSAGES.BACKUP_INTERRUPTED };
    }
    if (!result.lastSuccessAt) return { ...result, state: 'not_run' };
    return { ...result, state: (now - Date.parse(result.lastSuccessAt)) / 3_600_000 > config.freshnessHours ? 'stale' : 'healthy' };
  } catch (_) {
    return { ...result, state: 'failed', lastError: ERROR_MESSAGES.BACKUP_CONFIG };
  }
}

module.exports = {
  BACKUP_NAME, LOCK_NAME, STATUS_NAME, ERROR_MESSAGES, configuration, resolveBackupDirectory,
  readRecord, writeRecord, fileRecord, matchesRecord, syncDirectory, getBackupStatus,
};
