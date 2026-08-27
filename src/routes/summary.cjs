/**
 * 汇总路由
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database.cjs');
const { getPrice, convertCurrency, getExchangeRates } = require('../services/priceFetcher.cjs');

/**
 * 按币种汇总
 */
router.get('/by-currency', async (req, res) => {
    try {
        // 获取所有资产
        const assets = db.prepare(`
            SELECT a.*, t.name as type, p.name as platform, c.code as currency
            FROM assets a
            LEFT JOIN asset_types t ON a.asset_type_id = t.id
            LEFT JOIN platforms p ON a.platform_id = p.id
            LEFT JOIN currencies c ON a.currency_id = c.id
        `).all();
        
        // 按币种和平台分组
        const result = {};
        let totalAssetCNY = 0;
        
        for (const asset of assets) {
            // 获取价格
            const price = await getPrice(asset);
            const marketValue = price * asset.shares;
            const costValue = (asset.cost_price || 0) * asset.shares;
            const profit = marketValue - costValue;
            
            const currency = asset.currency || 'CNY';
            const platform = asset.platform || '其他';
            
            // 初始化币种
            if (!result[currency]) {
                result[currency] = {
                    platforms: {},
                    totalValue: 0,
                    totalCost: 0,
                    totalProfit: 0
                };
            }
            
            // 初始化平台
            if (!result[currency].platforms[platform]) {
                result[currency].platforms[platform] = {
                    platform,
                    assets: 0,
                    value: 0,
                    cost: 0,
                    profit: 0
                };
            }
            
            // 更新统计
            result[currency].platforms[platform].assets++;
            result[currency].platforms[platform].value += marketValue;
            result[currency].platforms[platform].cost += costValue;
            result[currency].platforms[platform].profit += profit;
            
            result[currency].totalValue += marketValue;
            result[currency].totalCost += costValue;
            result[currency].totalProfit += profit;
            
            // 转换成 CNY 计算总资产
            totalAssetCNY += convertCurrency(marketValue, currency, 'CNY');
        }
        
        // 计算收益率
        for (const currency in result) {
            if (result[currency].totalCost > 0) {
                result[currency].totalProfitPercent = (result[currency].totalProfit / result[currency].totalCost) * 100;
            }
            
            for (const platform in result[currency].platforms) {
                const p = result[currency].platforms[platform];
                if (p.cost > 0) {
                    p.profitPercent = (p.profit / p.cost) * 100;
                }
            }
        }
        
        res.json({
            ...result,
            exchangeRates: getExchangeRates(),
            totalAssetCNY
        });
    } catch (e) {
        console.error('汇总失败:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
