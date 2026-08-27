/**
 * 资产追踪器 - 前端应用
 */

// 获取token
function getToken() {
    return window.__USER__?.token || localStorage.getItem('sso_token');
}

// 检查是否已登录
function isLoggedIn() {
    if (window.__USER__) return true;
    return !!getToken();
}

// 未登录跳转SSO
if (!isLoggedIn()) {
    const redirect = encodeURIComponent(window.location.origin + window.location.pathname);
    window.location.href = 'https://stoneking.top/login?redirect=' + redirect;
}

// 清理URL中的token参数
(function cleanUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('token')) {
        window.history.replaceState({}, '', window.location.pathname);
    }
})();

let lastUpdateTime = null;

async function handleRefresh() {
    UI.showHint('loadingHint');
    
    try {
        const assets = await API.getAssets();
        const ratesRes = await fetch('/exchange-rates?token=' + getToken());
        const rates = await ratesRes.json();
        
        const platformAssets = {};
        let totalAmountCNY = 0;
        
        for (const asset of assets) {
            const platformName = asset.platform_name || '未知平台';
            const currency = asset.currency_code || 'CNY';
            
            if (!platformAssets[platformName]) {
                platformAssets[platformName] = { assets: [], total: 0, currency: currency, totalCNY: 0 };
            }
            
            const cost = (asset.shares * (asset.cost_price || 0));
            let costCNY = cost;
            if (currency !== 'CNY' && rates[currency + '_TO_CNY']) {
                costCNY = cost * rates[currency + '_TO_CNY'];
            }
            
            platformAssets[platformName].assets.push(asset);
            platformAssets[platformName].total += cost;
            platformAssets[platformName].totalCNY += costCNY;
            totalAmountCNY += costCNY;
        }
        
        const currencySymbols = { 'CNY': '¥', 'GBP': '£', 'USD': '$', 'EUR': '€', 'AED': 'د.إ', 'JPY': '¥' };
        
        const totalAmountEl = document.getElementById('totalAmount');
        if (totalAmountEl) totalAmountEl.textContent = '¥' + totalAmountCNY.toFixed(2);
        
        const exchangeRatesEl = document.getElementById('exchangeRates');
        if (exchangeRatesEl) {
            let ratesHtml = '';
            if (rates.GBP_TO_CNY) ratesHtml += '<div>£1 = ¥' + rates.GBP_TO_CNY.toFixed(2) + '</div>';
            if (rates.USD_TO_CNY) ratesHtml += '<div>$1 = ¥' + rates.USD_TO_CNY.toFixed(2) + '</div>';
            if (rates.EUR_TO_CNY) ratesHtml += '<div>€1 = ¥' + rates.EUR_TO_CNY.toFixed(2) + '</div>';
            exchangeRatesEl.innerHTML = ratesHtml;
        }
        
        let html = '';
        const sortedPlatforms = Object.entries(platformAssets).sort((a, b) => b[1].totalCNY - a[1].totalCNY);
        
        for (const [platformName, data] of sortedPlatforms) {
            const symbol = currencySymbols[data.currency] || '¥';
            const escapedName = platformName.replace(/'/g, "\\'");
            html += '<div class="currency-card" onclick="showPlatformAssets(\'' + escapedName + '\')" style="cursor:pointer">' +
                '<h3>' + platformName + '</h3>' +
                '<div class="amount">' + symbol + data.total.toFixed(2) + '</div>' +
                '<div class="amount-cny">≈ ¥' + data.totalCNY.toFixed(2) + ' · ' + data.assets.length + '项</div>' +
                '</div>';
        }
        
        const currencySectionsEl = document.getElementById('currencySections');
        if (currencySectionsEl) currencySectionsEl.innerHTML = html;
        
        lastUpdateTime = new Date();
        UI.hideHint('loadingHint');
        UI.showHint('successHint', true);
    } catch (err) {
        console.error('刷新失败:', err);
        UI.hideHint('loadingHint');
        UI.showHint('errorHint', true);
    }
}

async function loadFormData() {
    const [p, c, t] = await Promise.all([API.getPlatforms(), API.getCurrencies(), API.getAssetTypes()]);
    window._platforms = p;
    window._currencies = c;
    window._assetTypes = t;
}

async function showAssetForm(asset) {
    await loadFormData();
    
    const platformOptions = window._platforms.map(p => 
        '<option value="' + p.id + '"' + (asset && asset.platform_id === p.id ? ' selected' : '') + '>' + p.name + '</option>'
    ).join('');
    
    const typeOptions = window._assetTypes.map(t => 
        '<option value="' + t.id + '"' + (asset && asset.asset_type_id === t.id ? ' selected' : '') + '>' + t.name + '</option>'
    ).join('');
    
    const currencyOptions = window._currencies.map(c => 
        '<option value="' + c.id + '"' + (asset && asset.currency_id === c.id ? ' selected' : '') + '>' + c.code + '</option>'
    ).join('');
    
    UI.showModal(
        '<h2>' + (asset ? '编辑资产' : '添加资产') + '</h2>' +
        '<form id="assetForm">' +
        '<div class="form-group"><label>平台</label><select id="platform_id" required>' + platformOptions + '</select></div>' +
        '<div class="form-group"><label>类型</label><select id="asset_type_id" required>' + typeOptions + '</select></div>' +
        '<div class="form-group"><label>代码</label><input type="text" id="code" value="' + (asset ? asset.code || '' : '') + '" required placeholder="如: AAPL"></div>' +
        '<div class="form-group"><label>名称</label><input type="text" id="name" value="' + (asset ? asset.name || '' : '') + '" placeholder="可选"></div>' +
        '<div class="form-group"><label>份额</label><input type="number" id="shares" value="' + (asset ? asset.shares || '' : '') + '" step="0.01" required></div>' +
        '<div class="form-group"><label>成本价</label><input type="number" id="cost_price" value="' + (asset ? asset.cost_price || '' : '') + '" step="0.01" required></div>' +
        '<div class="form-group"><label>货币</label><select id="currency_id" required>' + currencyOptions + '</select></div>' +
        '<div class="form-actions">' +
        '<button type="submit" class="btn-primary">保存</button> ' +
        '<button type="button" class="btn-secondary" onclick="UI.closeModal()">取消</button>' +
        (asset ? ' <button type="button" class="btn-danger" onclick="deleteAsset(' + asset.id + ')">删除</button>' : '') +
        '</div></form>'
    );
    
    document.getElementById('assetForm').onsubmit = async (e) => {
        e.preventDefault();
        const formData = {
            platform_id: parseInt(document.getElementById('platform_id').value),
            asset_type_id: parseInt(document.getElementById('asset_type_id').value),
            code: document.getElementById('code').value,
            name: document.getElementById('name').value,
            shares: parseFloat(document.getElementById('shares').value),
            cost_price: parseFloat(document.getElementById('cost_price').value),
            currency_id: parseInt(document.getElementById('currency_id').value)
        };
        
        try {
            if (asset) {
                await API.updateAsset(asset.id, formData);
            } else {
                await API.addAsset(formData);
            }
            UI.closeModal();
            handleRefresh();
        } catch (err) {
            alert('保存失败: ' + err.message);
        }
    };
}

async function deleteAsset(id) {
    if (confirm('确定删除此资产？')) {
        await API.deleteAsset(id);
        UI.closeModal();
        handleRefresh();
    }
}

async function showPlatformAssets(platformName) {
    UI.showAssetsPage();
    document.getElementById('pageTitle').textContent = platformName + ' 资产详情';
    
    try {
        const response = await fetch('/snapshot?token=' + getToken());
        const data = await response.json();
        const filtered = data.assets.filter(a => (a.platform_name || '未知平台') === platformName);
        
        let html = '<table class="assets-table"><thead><tr>' +
            '<th>代码</th><th>名称</th><th>份额</th><th>成本价</th><th>现价</th><th>市值</th><th>盈亏</th><th>货币</th><th>操作</th>' +
            '</tr></thead><tbody>';
        
        for (const asset of filtered) {
            const currentPrice = asset.current_price || 0;
            const currentValue = parseFloat(asset.current_value) || 0;
            const profit = parseFloat(asset.profit) || 0;
            const profitPercent = asset.profit_percent || 0;
            
            const profitClass = profit >= 0 ? 'profit' : 'loss';
            const profitSign = profit >= 0 ? '+' : '';
            
            html += '<tr>' +
                '<td>' + (asset.code || '-') + '</td>' +
                '<td>' + (asset.name || '-') + '</td>' +
                '<td>' + asset.shares + '</td>' +
                '<td>' + asset.cost_price + '</td>' +
                '<td>' + (currentPrice || '-') + '</td>' +
                '<td>' + currentValue.toFixed(2) + '</td>' +
                '<td class="' + profitClass + '">' + profitSign + profit.toFixed(2) + ' (' + profitSign + profitPercent + '%)</td>' +
                '<td>' + (asset.currency_code || 'CNY') + '</td>' +
                '<td><button onclick="showAssetForm(' + JSON.stringify(asset).replace(/"/g, '&quot;') + ')">编辑</button></td>' +
                '</tr>';
        }
        
        html += '</tbody></table>';
        
        if (filtered.length === 0) {
            html = '<div class="empty-state">暂无资产</div>';
        }
        
        document.getElementById('assetsTable').innerHTML = html;
    } catch (err) {
        console.error('加载资产失败:', err);
        document.getElementById('assetsTable').innerHTML = '<div class="error">加载失败: ' + err.message + '</div>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (isLoggedIn()) {
        UI.showDashboard();
        handleRefresh();
    }
});
