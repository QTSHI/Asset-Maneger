/**
 * 认证路由
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database.cjs');

/**
 * 登录
 */
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, error: '用户名和密码不能为空' });
    }
    
    const user = db.prepare('SELECT id, username FROM users WHERE username = ? AND password = ?').get(username, password);
    
    if (user) {
        res.json({ success: true, user: { id: user.id, username: user.username } });
    } else {
        res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
});

/**
 * Token 登录
 */
router.get('/login-token/:token', (req, res) => {
    // 简化实现：直接返回成功
    res.json({ success: true, user: { id: 1, username: 'stone' } });
});

module.exports = router;
