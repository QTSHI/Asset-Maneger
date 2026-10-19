#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { backupDatabase } = require('./backup-database.cjs');
const {
  BACKUP_NAME, LOCK_NAME, ERROR_MESSAGES, configuration, resolveBackupDirectory,
  readRecord, writeRecord, fileRecord, matchesRecord, syncDirectory,
} = require('../src/services/backupStatus.cjs');

function acquireLock(backupDir) {
  const lockPath = path.join(backupDir, LOCK_NAME);
  const runId = randomBytes(16).toString('hex');
  let fd;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('备份任务正在运行或遗留锁尚未处理。'), { code: 'BACKUP_IN_PROGRESS' });
    throw error;
  }
  const info = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), runId })}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
    throw error;
  }
  return () => {
    try {
      const current = fs.lstatSync(lockPath);
      if (current.isFile() && !current.isSymbolicLink() && current.dev === info.dev && current.ino === info.ino) {
        fs.unlinkSync(lockPath);
      }
    } finally { fs.closeSync(fd); }
  };
}

function retainVerifiedBackups(backupDir, record, sourcePath, keep) {
  // Only files explicitly recorded after this runner verified them are eligible.
  // Matching filenames from old/manual backups are deliberately left alone.
  const owned = [...record.backups].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const verified = owned.filter((item) => matchesRecord(backupDir, item));
  // A wall-clock correction must never cause cleanup of the just-created copy.
  const preserved = new Set([record.lastSuccess.filename]);
  for (const item of verified) {
    if (preserved.size >= keep) break;
    preserved.add(item.filename);
  }
  const retained = [];
  let removed = 0;
  const realSource = fs.realpathSync(sourcePath);
  for (const item of owned) {
    const file = path.join(backupDir, item.filename);
    if (preserved.has(item.filename) || !BACKUP_NAME.test(item.filename) || !matchesRecord(backupDir, item)) {
      retained.push(item);
      continue;
    }
    if (fs.realpathSync(file) === realSource) {
      retained.push(item);
      continue;
    }
    // Compare the inode again immediately before unlinking: replacement files,
    // hard links, symlinks and user-modified files never enter retention cleanup.
    if (!matchesRecord(backupDir, item)) { retained.push(item); continue; }
    fs.unlinkSync(file);
    removed += 1;
  }
  record.backups = retained;
  if (removed) syncDirectory(backupDir);
  return removed;
}

async function runBackupMaintenance(options = {}) {
  const config = configuration(options);
  const backupDir = resolveBackupDirectory(config.backupDir, { create: true });
  const release = acquireLock(backupDir);
  let record;
  try {
    const previous = readRecord(backupDir);
    record = previous?.sourceHash === config.sourceHash
      ? previous
      : { version: 1, sourceHash: config.sourceHash, backups: [], lastSuccess: null };
    record.lastAttempt = { startedAt: new Date().toISOString(), state: 'running' };
    writeRecord(backupDir, record);
    const env = options.env || process.env;
    const keep = Number(options.keep ?? env.ASSET_TRACKER_BACKUP_KEEP ?? 30);
    if (!Number.isInteger(keep) || keep < 2 || keep > 10000) {
      throw Object.assign(new Error('备份保留份数应为 2 至 10000 的整数。'), { code: 'BACKUP_CONFIG' });
    }
    const file = await backupDatabase({ sourcePath: config.sourcePath, backupDir });
    const completedAt = new Date().toISOString();
    const verified = fileRecord(file, completedAt);
    record.lastSuccess = verified;
    record.backups.push(verified);
    // Publish proof of the new verified copy before removing any older copy.
    writeRecord(backupDir, record);
    let removed;
    try { removed = retainVerifiedBackups(backupDir, record, config.sourcePath, keep); } catch (error) {
      error.code = 'BACKUP_RETENTION';
      throw error;
    }
    record.lastAttempt = { ...record.lastAttempt, finishedAt: completedAt, state: 'success' };
    writeRecord(backupDir, record);
    return { file, completedAt, removed, kept: record.backups.length };
  } catch (error) {
    if (record) {
      record.lastAttempt = {
        ...record.lastAttempt, state: 'failed', finishedAt: new Date().toISOString(),
        errorCode: Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : 'BACKUP_FAILED',
      };
      try { writeRecord(backupDir, record); } catch (_) { /* preserve original error and copies */ }
    }
    throw error;
  } finally { release(); }
}

if (require.main === module) {
  runBackupMaintenance()
    .then((result) => console.log(`已创建并验证备份；本任务保留 ${result.kept} 份，清理 ${result.removed} 份。`))
    .catch((error) => {
      console.error(error.code === 'BACKUP_IN_PROGRESS' ? error.message : ERROR_MESSAGES[error.code] || ERROR_MESSAGES.BACKUP_FAILED);
      process.exitCode = 1;
    });
}

module.exports = { runBackupMaintenance, acquireLock };
