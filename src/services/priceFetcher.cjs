/**
 * 价格获取服务
 */

const axios = require('axios');

// 价格缓存
const priceCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;

// 汇率缓存
let exchangeRates = {
    GBP_TO_CNY: 9.15,
    USD_TO_CNY: 7.24,
    EUR_TO_CNY: 7.85,
    AED_TO_CNY: 1.97,
    JPY_TO_CNY: 0.048
};

// 金价缓存
let goldPriceCache = { price: null, time: 0 };

/**
 * 获取股票市场
 */
function getMarket(code) {
    const prefix = code.substring(0, 3);
    if (code.startsWith('6') || code.startsWith('5') || prefix === '510' || prefix === '511' || prefix === '512' || prefix === '513' || prefix === '515' || prefix === '516' || prefix === '517' || prefix === '518' || prefix === '501' || prefix === '502') {
        return 'sh';
    }
    return 'sz';
}

/**
 * 获取股票价格
 */
async function getStockPrice(code) {
    if (code.endsWith('.US') || code.endsWith('.L')) {
        return getUSStockPrice(code);
    }
    
    const market = getMarket(code);
    const url = `https://qt.gtimg.cn/q=${market}${code}`;
    
    try {
        const resp = await axios.get(url, { timeout: 5000 });
        const match = resp.data.match(/v_(.+?)="(.+?)"/);
        if (match) {
            const parts = match[2].split('~');
            if (parts.length > 3 && parts[3]) {
                const price = parseFloat(parts[3]);
                if (!isNaN(price) && price > 0) return price;
            }
        }
    } catch (e) {}

    // Tencent can be unreachable from some overseas networks. Eastmoney uses
    // integer cents in f43 and provides a stable fallback for mainland stocks.
    try {
        const secid = `${market === 'sh' ? 1 : 0}.${code}`;
        const resp = await axios.get('https://push2.eastmoney.com/api/qt/stock/get', {
            timeout: 8000,
            params: { secid, fields: 'f43,f57,f58' }
        });
        const price = normalizeEastmoneyStockPrice(resp.data);
        if (price) return price;
    } catch (e) {}
    
    return null;
}

function normalizeEastmoneyStockPrice(payload) {
    const raw = Number(payload?.data?.f43);
    return Number.isFinite(raw) && raw > 0 ? raw / 100 : null;
}

/**
 * 获取美股价格
 */
async function getUSStockPrice(code) {
    try {
        if (code.endsWith('.US')) {
            const symbol = code.replace('.US', '');
            const resp = await axios.get(`https://qt.gtimg.cn/q=us.${symbol}`, { timeout: 5000 });
            const match = resp.data.match(/v_(.+?)="(.+?)"/);
            if (match) return parseFloat(match[2].split('~')[3]);
        } else if (code.endsWith('.L')) {
            const symbol = code.replace('.L', '');
            const resp = await axios.get(`https://qt.gtimg.cn/q=gb.${symbol}`, { timeout: 5000 });
            const match = resp.data.match(/v_(.+?)="(.+?)"/);
            if (match) return parseFloat(match[2].split('~')[3]);
        }
    } catch (e) {}
    return null;
}

/**
 * 获取基金价格
 */
async function getFundPrice(code) {
    // 天天基金网
    try {
        const resp = await axios.get(`https://fundgz.1234567.com.cn/js/${code}.js`, { timeout: 5000 });
        const gszMatch = resp.data.match(/"gsz":"([^"]+)"/);
        const dwjzMatch = resp.data.match(/"dwjz":"([^"]+)"/);
        
        if (gszMatch && gszMatch[1] && gszMatch[1] !== '--') return parseFloat(gszMatch[1]);
        if (dwjzMatch && dwjzMatch[1] && dwjzMatch[1] !== '--') return parseFloat(dwjzMatch[1]);
    } catch (e) {}
    
    // 东方财富
    try {
        const resp = await axios.get(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
            timeout: 10000,
            headers: { 'Referer': 'https://fund.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }
        });
        
        const trendMatch = resp.data.match(/Data_netWorthTrend\s*=\s*(\[[^\]]+\]);/);
        if (trendMatch) {
            const trend = JSON.parse(trendMatch[1]);
            if (trend && trend.length > 0 && trend[trend.length-1].y) {
                return parseFloat(trend[trend.length-1].y);
            }
        }
    } catch (e) {}
    
    return null;
}

/**
 * 获取实时国内金价（元/克）
 * 使用黄金ETF 518880价格推算
 * 金价 = ETF价格 × 100
 */
async function getGoldPrice() {
    // 缓存30分钟
    if (goldPriceCache.price && Date.now() - goldPriceCache.time < CACHE_DURATION) {
        return goldPriceCache.price;
    }
    
    try {
        const etfPrice = await getStockPrice('518880');
        if (etfPrice && etfPrice > 0) {
            // 金价 = ETF价格 × 100
            const goldPrice = etfPrice * 100;
            goldPriceCache = { price: goldPrice, time: Date.now() };
            console.log('金价已更新:', goldPrice.toFixed(2), '元/克');
            return goldPrice;
        }
    } catch (e) {}
    
    return null;
}

/**
 * 获取加密货币价格
 */
async function getCryptoPrice(code) {
    const coinMap = { 'eth': 'ethereum', 'btc': 'bitcoin', 'bnb': 'binancecoin' };
    const coinId = coinMap[code.toLowerCase()] || code.toLowerCase();
    
    try {
        const resp = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, { timeout: 10000 });
        if (resp.data && resp.data[coinId]) return resp.data[coinId].usd;
    } catch (e) {}
    
    return null;
}

/**
 * 获取资产价格
 */
async function getPrice(asset) {
    // 现金固定价格1
    if (asset.type === 'cash' || (asset.code && asset.code.startsWith('CASH-')) || asset.code === 'T212-TOTAL') {
        return 1;
    }
    
    const cacheKey = `${asset.code}_${asset.type}`;
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_DURATION) {
        return cached.price;
    }
    
    let price = null;
    const code = asset.code;
    
    try {
        if (asset.type === 'gold_paper' || asset.type === '纸黄金') {
            // 纸黄金：返回实时金价（元/克）
            price = await getGoldPrice();
        } else if (asset.type === 'etf' || (asset.type === 'fund' && /^[0-9]{6}$/.test(code) && 
            (code.startsWith('51') || code.startsWith('50') || code.startsWith('56') || code.startsWith('15')))) {
            price = await getStockPrice(code);
        } else if (asset.type === 'fund') {
            price = await getFundPrice(code);
        } else if (asset.type === 'stock_cn') {
            price = await getStockPrice(code);
        } else if (asset.type === 'stock_us') {
            price = await getUSStockPrice(code + '.US');
        } else if (asset.type === 'stock_uk') {
            price = await getUSStockPrice(code + '.L');
        } else if (asset.type === 'crypto' || asset.type === '加密货币') {
            price = await getCryptoPrice(code);
        } else if (asset.type === 'cash') {
            price = 1;
        }
    } catch (e) {}
    
    if (price && price > 0) {
        priceCache.set(cacheKey, { price, time: Date.now() });
    }
    
    return price;
}

/**
 * 更新汇率
 */
async function updateExchangeRates() {
    try {
        const resp = await axios.get('https://api.exchangerate-api.com/v4/latest/GBP', { timeout: 5000 });
        if (resp.data && resp.data.rates) {
            exchangeRates.GBP_TO_CNY = resp.data.rates.CNY;
            exchangeRates.USD_TO_CNY = resp.data.rates.CNY / resp.data.rates.USD;
            exchangeRates.EUR_TO_CNY = resp.data.rates.CNY / resp.data.rates.EUR;
            exchangeRates.AED_TO_CNY = resp.data.rates.CNY / resp.data.rates.AED;
            exchangeRates.JPY_TO_CNY = resp.data.rates.CNY / resp.data.rates.JPY;
        }
    } catch (e) {}
}

function getExchangeRates() { return exchangeRates; }

function convertCurrency(amount, from, to) {
    if (from === to) return amount;
    const rates = getExchangeRates();
    let cny = amount;
    if (from === 'GBP') cny = amount * rates.GBP_TO_CNY;
    else if (from === 'USD') cny = amount * rates.USD_TO_CNY;
    else if (from === 'EUR') cny = amount * rates.EUR_TO_CNY;
    else if (from === 'AED') cny = amount * rates.AED_TO_CNY;
    else if (from === 'JPY') cny = amount * rates.JPY_TO_CNY;
    
    if (to === 'CNY') return cny;
    if (to === 'GBP') return cny / rates.GBP_TO_CNY;
    if (to === 'USD') return cny / rates.USD_TO_CNY;
    if (to === 'EUR') return cny / rates.EUR_TO_CNY;
    if (to === 'AED') return cny / rates.AED_TO_CNY;
    if (to === 'JPY') return cny / rates.JPY_TO_CNY;
    return amount;
}

module.exports = { getPrice, updateExchangeRates, getExchangeRates, convertCurrency, normalizeEastmoneyStockPrice };
