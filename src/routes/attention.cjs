const express = require('express');
const { getAttention } = require('../services/attentionService.cjs');

const router = express.Router();

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ data: getAttention() });
  } catch (error) {
    console.error('[api/v2/attention]', error);
    res.status(500).json({ error: { code: 'ATTENTION_UNAVAILABLE', message: '暂时无法读取待核对清单，请稍后重试' } });
  }
});

module.exports = router;
