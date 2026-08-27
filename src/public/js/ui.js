/**
 * UI 工具模块
 */

const UI = {
    // 显示提示
    showHint: (id, ms) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.add('show');
            if (ms !== false) {
                setTimeout(() => el.classList.remove('show'), ms || 2000);
            }
        }
    },
    
    // 隐藏提示
    hideHint: (id) => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('show');
    },
    
    // 显示仪表盘
    showDashboard: () => {
        const loginPage = document.getElementById('loginPage');
        const dashboard = document.getElementById('dashboard');
        const assetsPage = document.getElementById('assetsPage');
        const currencySections = document.getElementById('currencySections');
        
        if (loginPage) loginPage.style.display = 'none';
        if (dashboard) dashboard.style.display = 'block';
        if (assetsPage) assetsPage.style.display = 'none';
        if (currencySections) currencySections.style.display = 'grid';
    },
    
    // 显示资产页
    showAssetsPage: () => {
        const currencySections = document.getElementById('currencySections');
        const assetsPage = document.getElementById('assetsPage');
        
        if (currencySections) currencySections.style.display = 'none';
        if (assetsPage) assetsPage.style.display = 'block';
    },
    
    // 返回主页
    goBack: () => {
        const assetsPage = document.getElementById('assetsPage');
        const currencySections = document.getElementById('currencySections');
        
        if (assetsPage) assetsPage.style.display = 'none';
        if (currencySections) currencySections.style.display = 'grid';
    },
    
    // 更新时间
    updateTime: (lastUpdateTime) => {
        const el = document.getElementById('updateTime');
        if (!el || !lastUpdateTime) return;
        
        const sec = Math.floor((Date.now() - lastUpdateTime) / 1000);
        const min = Math.floor(sec / 60);
        const hr = Math.floor(min / 60);
        el.textContent = 
            hr > 0 ? `更新于 ${hr} 小时前` : 
            min > 0 ? `更新于 ${min} 分钟前` : 
            `更新于 ${sec} 秒前`;
    },
    
    // 显示模态框（使用assetModal）
    showModal: (content) => {
        const modal = document.getElementById('assetModal');
        const contentEl = modal?.querySelector('.modal-content');
        if (contentEl) {
            // 保留header结构
            const header = contentEl.querySelector('.modal-header');
            contentEl.innerHTML = '';
            if (header) contentEl.appendChild(header);
            
            // 添加内容
            const body = document.createElement('div');
            body.className = 'modal-body';
            body.innerHTML = content;
            contentEl.appendChild(body);
        }
        if (modal) modal.classList.add('show');
    },
    
    // 关闭模态框
    closeModal: () => {
        const modal = document.getElementById('assetModal');
        if (modal) modal.classList.remove('show');
    },
    
    // 资产类型名称映射
    typeNames: {
        'stock_cn': 'A股',
        'fund': '基金',
        'etf': 'ETF',
        'lof': 'LOF',
        'cash': '现金',
        'stock_us': '美股',
        'stock_uk': '英股',
        '纸黄金': '纸黄金',
        '加密货币': '加密货币'
    }
};

// 全局函数（兼容HTML onclick）
function closeModal() {
    UI.closeModal();
}

function closePlatformModal() {
    const modal = document.getElementById('platformModal');
    if (modal) modal.classList.remove('show');
}
