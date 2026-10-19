const express = require('express');
const exportsService = require('../services/exportService.cjs');
const router = express.Router();

// These authenticated downloads must never become shared browser/proxy caches.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

function download(kind, run) {
  router.get(`/${kind}.csv`, (req, res) => {
    try {
      const month = req.query.month;
      if (kind === 'transactions' && month !== undefined &&
          (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
        return res.status(400).json({ error: { code: 'INVALID_MONTH', message: '月份格式应为 YYYY-MM，月份须为 01 至 12' } });
      }
      const suffix = kind === 'transactions' ? month || 'all-dates' : 'active';
      const csv = run(kind === 'transactions' ? month : undefined);
      res.type('text/csv; charset=utf-8');
      res.attachment(`stone-wealth-${kind}-${suffix}.csv`);
      res.send(csv);
    } catch (error) {
      console.error('[api/v2/exports]', error);
      res.status(500).json({ error: { code: 'EXPORT_FAILED', message: '导出失败，请稍后重试' } });
    }
  });
}

download('accounts', exportsService.exportAccounts);
download('assets', exportsService.exportAssets);
download('transactions', exportsService.exportTransactions);

module.exports = router;
