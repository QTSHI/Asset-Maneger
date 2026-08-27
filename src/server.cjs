/**
 * Asset Tracker - 集成SSO认证
 */

const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

const db = require('./services/database.cjs');
const { updateExchangeRates, getPrice, getExchangeRates, convertCurrency } = require('./services/priceFetcher.cjs');
const { PORT, EXCHANGE_RATE_INTERVAL } = require('./config/constants.cjs');

const SSO_BASE_URL = 'https://stoneking.top';
const SERVICE_NAME = 'asset-tracker';

const API_PATHS = ['/asset-types', '/currencies', '/platforms', '/assets', '/snapshot', '/refresh-rates', '/exchange-rates', '/login-token', '/summary-by-currency', '/login'];

const tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function verifyToken(token) {
    if (!token) return null;
    
    const cached = tokenCache.get(token);
    if (cached && cached.expires > Date.now()) return cached.user;
    
    try {
        const response = await new Promise((resolve, reject) => {
            https.get(`${SSO_BASE_URL}/api/sso/verify?token=${encodeURIComponent(token)}`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
        
        if (response.valid) {
            tokenCache.set(token, { user: response, expires: Date.now() + CACHE_TTL });
            return response;
        }
    } catch (e) {
        console.error('Token验证失败:', e.message);
    }
    return null;
}

function checkServicePermission(user, serviceKey) {
    if (user.is_admin) return true;
    return (user.services || []).includes(serviceKey);
}

function isApiRequest(req) {
    if (API_PATHS.some(p => req.path.startsWith(p))) return true;
    if (req.headers.accept?.includes('application/json')) return true;
    if (req.xhr) return true;
    return false;
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            req.cookies[name] = value;
        });
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

async function ssoAuthMiddleware(req, res, next) {
    const whitelist = ['/health', '/favicon.ico', '/manifest.json', '/sw.js'];
    if (whitelist.some(p => req.path === p)) return next();
    
    const token = req.query.token || req.headers['x-auth-token'] || req.cookies?.session_token;
    
    if (!token) {
        if (isApiRequest(req)) {
            return res.status(401).json({ error: '未登录', redirect: `${SSO_BASE_URL}/login?redirect=https://asset.stoneking.top` });
        }
        return res.redirect(`${SSO_BASE_URL}/login?redirect=https://asset.stoneking.top`);
    }
    
    const user = await verifyToken(token);
    
    if (!user) {
        if (isApiRequest(req)) {
            return res.status(401).json({ error: '无效的token', redirect: `${SSO_BASE_URL}/login?redirect=https://asset.stoneking.top` });
        }
        return res.redirect(`${SSO_BASE_URL}/login?redirect=https://asset.stoneking.top`);
    }
    
    if (!checkServicePermission(user, SERVICE_NAME)) {
        return res.status(403).json({ error: '无权限访问此服务' });
    }
    
    req.user = user;
    req.token = token;
    next();
}

app.use(ssoAuthMiddleware);

// 首页 - 注入用户信息
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    
    // 注入用户信息和token
    const userInfo = {
        username: req.user.username,
        is_admin: req.user.is_admin,
        token: req.token
    };
    
    const injectScript = `<script>window.__USER__=${JSON.stringify(userInfo)};</script>`;
    html = html.replace('</head>', injectScript + '</head>');
    
    res.send(html);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'asset-tracker' });
});

app.get('/login-token/:token', async (req, res) => {
    const token = req.params.token;
    const user = await verifyToken(token);
    if (user) {
        res.cookie('session_token', token, {
            domain: '.stoneking.top',
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 86400000
        });
        res.redirect('/');
    } else {
        res.status(401).json({ error: '无效的token' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await new Promise((resolve, reject) => {
            const data = JSON.stringify({ username, password });
            const options = {
                hostname: 'stoneking.top',
                port: 443,
                path: '/api/auth/login',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
            };
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
        res.json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/check', (req, res) => {
    res.json({ authenticated: true, user: req.user });
});

app.get('/asset-types', (req, res) => {
    res.json(db.prepare('SELECT * FROM asset_types').all());
});

app.get('/currencies', (req, res) => {
    res.json(db.prepare('SELECT * FROM currencies').all());
});

app.get('/platforms', (req, res) => {
    res.json(db.prepare('SELECT * FROM platforms').all());
});

app.post('/platforms', (req, res) => {
    const { name, category, default_currency_id } = req.body;
    try {
        const result = db.prepare('INSERT INTO platforms (name, category, default_currency_id) VALUES (?, ?, ?)').run(name, category || '投资类', default_currency_id);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/assets', (req, res) => {
    const assets = db.prepare(`
        SELECT a.*, p.name as platform_name, p.default_currency_id as platform_currency_id, 
               c.code as currency_code, at.name as asset_type_name
        FROM assets a
        JOIN platforms p ON a.platform_id = p.id
        JOIN asset_types at ON a.asset_type_id = at.id
        LEFT JOIN currencies c ON a.currency_id = c.id
        ORDER BY a.id DESC
    `).all();
    res.json(assets);
});

app.post('/assets', (req, res) => {
    const { platform_id, asset_type_id, code, name, shares, cost_price, currency_id } = req.body;
    try {
        const result = db.prepare(`
            INSERT INTO assets (platform_id, asset_type_id, code, name, shares, cost_price, currency_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(platform_id, asset_type_id, code, name, shares, cost_price, currency_id);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/assets/:id', (req, res) => {
    db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.put('/assets/:id', (req, res) => {
    const { platform_id, asset_type_id, code, name, shares, cost_price, currency_id } = req.body;
    try {
        db.prepare(`
            UPDATE assets 
            SET platform_id = ?, asset_type_id = ?, code = ?, name = ?, shares = ?, cost_price = ?, currency_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(platform_id, asset_type_id, code, name, shares, cost_price, currency_id, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/summary-by-currency', async (req, res) => {
    try {
        const assets = db.prepare(`
            SELECT a.*, c.code as currency_code
            FROM assets a
            LEFT JOIN currencies c ON a.currency_id = c.id
        `).all();
        
        const exchangeRates = getExchangeRates();
        const result = {
            totalAssetCNY: 0,
            exchangeRates: exchangeRates
        };
        
        // 按货币分组
        const currenciesConfig = ['CNY', 'GBP', 'USD', 'EUR', 'AED', 'JPY'];
        for (const curr of currenciesConfig) {
            result[curr] = { amount: 0, amountCNY: 0 };
        }
        
        for (const asset of assets) {
            const currencyCode = asset.currency_code || 'CNY';
            const costValue = (asset.cost_price || 0) * asset.shares;
            
            if (result[currencyCode]) {
                result[currencyCode].amount += costValue;
                const rate = exchangeRates[currencyCode + '_TO_CNY'] || 1;
                result[currencyCode].amountCNY += costValue * rate;
                result.totalAssetCNY += costValue * rate;
            }
        }
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/snapshot', async (req, res) => {
    try {
        const assets = db.prepare(`
            SELECT a.*, p.name as platform_name, p.default_currency_id as platform_currency_id,
                   c.code as currency_code, at.name as asset_type_name
            FROM assets a
            JOIN platforms p ON a.platform_id = p.id
            JOIN asset_types at ON a.asset_type_id = at.id
            LEFT JOIN currencies c ON a.currency_id = c.id
        `).all();
        
        const snapshot = await Promise.all(assets.map(async (asset) => {
            const currentPrice = await getPrice({ code: asset.code, type: asset.asset_type_name });
            const currentValue = currentPrice * asset.shares;
            const costValue = asset.cost_price * asset.shares;
            const profit = currentValue - costValue;
            
            return {
                ...asset,
                current_price: currentPrice,
                current_value: currentValue.toFixed(2),
                cost_value: costValue.toFixed(2),
                profit: profit.toFixed(2),
                profit_percent: costValue > 0 ? (profit / costValue * 100).toFixed(2) : 0
            };
        }));
        
        const total = snapshot.reduce((acc, asset) => {
            acc.total_cost += parseFloat(asset.cost_value);
            acc.total_value += parseFloat(asset.current_value);
            return acc;
        }, { total_cost: 0, total_value: 0 });
        
        total.total_profit = (total.total_value - total.total_cost).toFixed(2);
        total.total_profit_percent = total.total_cost > 0 ? ((total.total_profit / total.total_cost) * 100).toFixed(2) : 0;
        
        res.json({ assets: snapshot, total });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/refresh-rates', async (req, res) => {
    try {
        await updateExchangeRates();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/exchange-rates', (req, res) => {
    res.json(getExchangeRates());
});

app.listen(PORT, () => {
    console.log(`✅ Asset Tracker已启动，端口 ${PORT}`);
    console.log(`✅ 已集成SSO认证 (${SSO_BASE_URL})`);
    setInterval(updateExchangeRates, EXCHANGE_RATE_INTERVAL);
});
