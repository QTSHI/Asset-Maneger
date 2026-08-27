/**
 * 资产路由
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database.cjs');
const { getPrice, convertCurrency, getExchangeRates } = require('../services/priceFetcher.cjs');

/**
 * 处理资产数据
 */
async function processAsset(asset) {
    // 获取价格
    const priceInfo = await getPrice(asset.type, asset.code, asset.cost_price || 0);
    
    const currentPrice = priceInfo.price;
    const marketValue = currentPrice * asset.shares;
    const costValue = (asset.cost_price || 0) * asset.shares;
    const profit = marketValue - costValue;
    const profitPercent = costValue > 0 ? (profit / costValue) * 100 : 0;
    
    return {
        ...asset,
        currentPrice,
        marketValue,
        costValue,
        profit,
        profitPercent,
        change: priceInfo.change,
        priceUnavailable: priceInfo.priceUnavailable || false
    };
}

/**
 * 获取资产列表
 */
router.get('/', async (req, res) => {
    try {
        const platform = req.query.platform;
        
        let query = `
            SELECT a.*, t.name as type, p.name as platform, c.code as currency
            FROM assets a
            LEFT JOIN asset_types t ON a.asset_type_id = t.id
            LEFT JOIN platforms p ON a.platform_id = p.id
            LEFT JOIN currencies c ON a.currency_id = c.id
        `;
        
        if (platform) {
            query += ' WHERE p.name = ?';
        }
        
        query += ' ORDER BY a.id DESC';
        
        const assets = platform 
            ? db.prepare(query).all(platform)
            : db.prepare(query).all();
        
        // 处理每个资产
        const processedAssets = await Promise.all(assets.map(processAsset));
        
        res.json(processedAssets);
    } catch (e) {
        console.error('获取资产失败:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * 添加资产
 */
router.post('/', (req, res) => {
    try {
        const { code, name, shares, cost_price, platform_id, currency_id, asset_type_id } = req.body;
        
        const result = db.prepare(`
            INSERT INTO assets (code, name, shares, cost_price, platform_id, currency_id, asset_type_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(code, name || '', shares, cost_price, platform_id, currency_id, asset_type_id);
        
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 更新资产
 */
router.put('/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { code, name, shares, cost_price, platform_id, currency_id, asset_type_id } = req.body;
        
        db.prepare(`
            UPDATE assets 
            SET code = ?, name = ?, shares = ?, cost_price = ?, 
                platform_id = ?, currency_id = ?, asset_type_id = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(code, name || '', shares, cost_price, platform_id, currency_id, asset_type_id, id);
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 删除资产
 */
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;
        db.prepare('DELETE FROM assets WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 获取资产类型
 */
router.get('/types', (req, res) => {
    const types = db.prepare('SELECT * FROM asset_types').all();
    res.json(types);
});

/**
 * 获取货币
 */
router.get('/currencies', (req, res) => {
    const currencies = db.prepare('SELECT * FROM currencies').all();
    res.json(currencies);
});

module.exports = router;
