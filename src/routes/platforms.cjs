/**
 * 平台路由
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database.cjs');

/**
 * 获取平台列表
 */
router.get('/', (req, res) => {
    const platforms = db.prepare('SELECT * FROM platforms ORDER BY name').all();
    res.json(platforms);
});

/**
 * 添加平台
 */
router.post('/', (req, res) => {
    try {
        const { name } = req.body;
        
        if (!name) {
            return res.status(400).json({ success: false, error: '平台名称不能为空' });
        }
        
        const result = db.prepare('INSERT INTO platforms (name) VALUES (?)').run(name);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        if (e.message.includes('UNIQUE')) {
            res.status(400).json({ success: false, error: '平台已存在' });
        } else {
            res.status(500).json({ success: false, error: e.message });
        }
    }
});

/**
 * 删除平台
 */
router.delete('/:id', (req, res) => {
    try {
        const { id } = req.params;
        
        // 先删除该平台下的所有资产
        db.prepare('DELETE FROM assets WHERE platform_id = ?').run(id);
        
        // 再删除平台
        db.prepare('DELETE FROM platforms WHERE id = ?').run(id);
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
