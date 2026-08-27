/**
 * 配置常量
 */

// 服务器配置
const PORT = process.env.PORT || 8080;

// Trading212 API 配置
const T212_KEY = process.env.T212_API_KEY;
const T212_SECRET = process.env.T212_API_SECRET;

// 价格缓存配置
const CACHE_DURATION = 30 * 60 * 1000; // 30 分钟

// 汇率更新间隔
const EXCHANGE_RATE_INTERVAL = 60 * 60 * 1000; // 1 小时

module.exports = {
    PORT,
    T212_KEY,
    T212_SECRET,
    CACHE_DURATION,
    EXCHANGE_RATE_INTERVAL
};
