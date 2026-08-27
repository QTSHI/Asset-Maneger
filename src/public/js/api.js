/**
 * API 调用模块
 */

// 获取token
function getToken() {
    // 1. URL参数
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');
    if (urlToken) return urlToken;
    
    // 2. localStorage
    const lsToken = localStorage.getItem('sso_token');
    if (lsToken) return lsToken;
    
    // 3. Cookie
    const cookies = document.cookie.split(';');
    for (let c of cookies) {
        if (c.trim().startsWith('session_token=')) {
            return c.trim().substring('session_token='.length);
        }
    }
    return null;
}

// 添加token到URL
function addToken(url) {
    const token = getToken();
    if (!token) return url;
    const separator = url.includes('?') ? '&' : '?';
    return url + separator + 'token=' + token;
}

// 处理API响应
async function handleResponse(res) {
    if (res.status === 401) {
        // 未登录，重定向到SSO
        const data = await res.json().catch(() => ({}));
        const redirect = data.redirect || 'https://stoneking.top/login?redirect=https://asset.stoneking.top';
        window.location.href = redirect;
        throw new Error('未登录');
    }
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.json();
}

const API = {
    // 登录
    login: async (username, password) => {
        const res = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        return res.json();
    },
    
    // 获取汇总
    getSummary: async () => {
        const res = await fetch(addToken('/summary-by-currency'));
        return handleResponse(res);
    },
    
    // 获取资产
    getAssets: async (platform = null) => {
        const url = platform ? `/assets?platform=${encodeURIComponent(platform)}` : '/assets';
        const res = await fetch(addToken(url));
        return handleResponse(res);
    },
    
    // 添加资产
    addAsset: async (data) => {
        const res = await fetch(addToken('/assets'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return handleResponse(res);
    },
    
    // 更新资产
    updateAsset: async (id, data) => {
        const res = await fetch(addToken(`/assets/${id}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return handleResponse(res);
    },
    
    // 删除资产
    deleteAsset: async (id) => {
        const res = await fetch(addToken(`/assets/${id}`), { method: 'DELETE' });
        return handleResponse(res);
    },
    
    // 获取平台
    getPlatforms: async () => {
        const res = await fetch(addToken('/platforms'));
        return handleResponse(res);
    },
    
    // 添加平台
    addPlatform: async (name) => {
        const res = await fetch(addToken('/platforms'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        return handleResponse(res);
    },
    
    // 删除平台
    deletePlatform: async (id) => {
        const res = await fetch(addToken(`/platforms/${id}`), { method: 'DELETE' });
        return handleResponse(res);
    },
    
    // 获取资产类型
    getAssetTypes: async () => {
        const res = await fetch(addToken('/asset-types'));
        return handleResponse(res);
    },
    
    // 获取货币
    getCurrencies: async () => {
        const res = await fetch(addToken('/currencies'));
        return handleResponse(res);
    }
};
