/**
 * Trading212 同步脚本
 * 从 API 获取账户总值并同步到数据库
 * 
 * 数据存储方式：
 * - shares = 账户总值
 * - cost_price = 投入成本 / 账户总值（单价）
 * - 价格 = 1（现金类型）
 * 这样：市值 = shares * 1 = 账户总值
 *      成本 = shares * cost_price = 投入成本
 *      盈亏 = 市值 - 成本
 */

const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');

// 从配置文件读取
const config = require('../src/config/constants.cjs');
const API_KEY = config.T212_KEY;
const API_SECRET = config.T212_SECRET;
const BASE_URL = 'live.trading212.com';
const DB_PATH = path.join(__dirname, '..', 'database.sqlite');

function getAuthHeader() {
  const credentials = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
}

function fetchAPI(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': getAuthHeader(),
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } 
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else if (res.statusCode === 429) {
          reject(new Error('Rate limited (429)'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function syncTrading212() {
  console.log('🔄 同步 Trading212...');
  
  const db = new Database(DB_PATH);
  
  try {
    const cash = await fetchAPI('/api/v0/equity/account/cash');
    const total = cash.total;
    const invested = cash.invested;
    const ppl = cash.ppl;
    
    console.log(`💰 账户总值: £${total.toFixed(2)}`);
    console.log(`📊 投入成本: £${invested.toFixed(2)}`);
    console.log(`📈 盈亏: £${ppl.toFixed(2)} (${(ppl / invested * 100).toFixed(2)}%)`);
    
    const platform = db.prepare('SELECT id FROM platforms WHERE name = ?').get('Trading212');
    const currency = db.prepare('SELECT id FROM currencies WHERE code = ?').get('GBP');
    const cashType = db.prepare('SELECT id FROM asset_types WHERE name = ?').get('cash');
    
    // 清空旧数据
    db.prepare('DELETE FROM assets WHERE platform_id = ?').run(platform.id);
    
    // 计算单价：成本 / 总值
    const costPerUnit = invested / total;
    
    // 插入账户总值
    // shares = 账户总值, cost_price = 单价
    db.prepare(`
      INSERT INTO assets (code, name, shares, cost_price, platform_id, currency_id, asset_type_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run('T212-TOTAL', 'Trading212账户', total, costPerUnit, platform.id, currency.id, cashType.id);
    
    console.log(`✅ 同步完成`);
    console.log(`   市值: £${total.toFixed(2)}`);
    console.log(`   成本: £${invested.toFixed(2)}`);
    console.log(`   盈亏: £${ppl.toFixed(2)}`);
    
    return { total, invested, ppl };
    
  } catch (error) {
    console.error('❌ 失败:', error.message);
    throw error;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  syncTrading212().catch(() => process.exit(1));
}

module.exports = { syncTrading212 };
