const express = require('express');
const { getBackupStatus } = require('../services/backupStatus.cjs');

function createBackupStatusRouter(options = {}) {
  const router = express.Router();
  router.get('/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: getBackupStatus(options) });
  });
  return router;
}

module.exports = createBackupStatusRouter();
module.exports.createBackupStatusRouter = createBackupStatusRouter;
