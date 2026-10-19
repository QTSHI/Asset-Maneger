#!/usr/bin/env node

const { getBackupStatus } = require('../src/services/backupStatus.cjs');
const labels = {
  unconfigured: '备份目录尚未配置，也没有备份运行记录。',
  not_run: '当前数据库尚无通过验证的备份记录。',
  running: '备份正在运行，尚未完成本次验证。',
  healthy: '最近备份已验证，且处于有效期限内。',
  stale: '最近备份已超出有效期限，请检查定时任务。',
  failed: '备份需要处理。',
};

function checkBackup(options = {}) {
  const status = getBackupStatus(options);
  return { status, healthy: status.state === 'healthy', message: `${labels[status.state]}${status.lastError ? ` ${status.lastError}` : ''}` };
}

if (require.main === module) {
  const result = checkBackup();
  console.log(result.message);
  if (result.status.lastSuccessAt) console.log(`最近验证成功：${result.status.lastSuccessAt}`);
  process.exitCode = result.healthy ? 0 : 1;
}

module.exports = { checkBackup };
