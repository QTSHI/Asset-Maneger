# 🪨 Asset Tracker - 资产追踪器

实时资产追踪与管理平台 - Stone King Empire

**访问地址**: https://asset.stoneking.top

## 功能

- 📊 **资产总览** - 按平台分组显示，自动转换货币
- 💰 **多平台支持** - 支付宝、同花顺、中信证券、Trading212 等 12+ 平台
- 📈 **实时价格** - 自动获取 A股、基金、ETF、加密货币最新价格
- 💱 **智能汇率** - 自动转换 GBP、USD、EUR 等为 CNY
- 🔐 **SSO 统一认证** - 集成石头大王统一登录系统
- 📱 **响应式设计** - 支持桌面和移动端

## 技术栈

- **后端**: Node.js + Express
- **数据库**: SQLite (better-sqlite3)
- **前端**: 原生 HTML/CSS/JavaScript
- **认证**: SSO (石头大王统一登录)
- **价格源**: 
  - 腾讯股票（A股、ETF）
  - 天天基金网（基金）
  - CoinGecko（加密货币）

## SSO 登录

资产中心已接入石头大王统一登录系统 (SSO)。

### 登录流程

1. 访问 asset.stoneking.top
2. 自动跳转到 stoneking.top 登录
3. 登录成功后自动返回资产中心
4. 已登录用户访问其他服务无需重复登录

详细文档: `/root/.openclaw/workspace/docs/SSO_LOGIN.md`

## 项目结构

```
/var/www/asset-tracker/
├── src/
│   ├── server.cjs           # 主服务器（含SSO中间件）
│   ├── config/
│   │   └── constants.cjs    # 配置常量
│   ├── services/
│   │   ├── database.cjs     # 数据库服务
│   │   └── priceFetcher.cjs # 价格获取服务
│   └── public/
│       ├── index.html       # 入口页面
│       ├── css/
│       │   └── style.css    # 样式
│       └── js/
│           ├── api.js       # API 调用（含token传递）
│           ├── ui.js        # UI 工具
│           └── app.js       # 主逻辑
├── scripts/
│   └── sync-t212.sh         # Trading212 同步脚本
├── database.sqlite          # SQLite 数据库
├── SSOLogin.md              # SSO 登录逻辑文档
├── ecosystem.config.js      # PM2 配置
├── package.json
└── README.md
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/assets` | GET | 获取所有资产 |
| `/assets` | POST | 添加资产 |
| `/assets/:id` | PUT/DELETE | 更新/删除资产 |
| `/platforms` | GET/POST | 平台管理 |
| `/currencies` | GET | 货币列表 |
| `/asset-types` | GET | 资产类型列表 |
| `/exchange-rates` | GET | 当前汇率 |
| `/summary-by-currency` | GET | 按货币汇总（含汇率转换） |
| `/snapshot` | GET | 资产快照 |
| `/health` | GET | 健康检查 |

**认证方式**: 所有 API 需要传递 token
- URL参数: `?token=xxx`
- Header: `X-Auth-Token: xxx`
- Cookie: `session_token=xxx`

## 支持的资产类型

| 类型 | 代码 | 价格源 |
|------|------|--------|
| A股 | stock_cn | 腾讯股票 |
| 美股 | stock_us | 腾讯美股 |
| ETF | etf | 腾讯股票 |
| LOF基金 | lof | 腾讯股票 |
| 场外基金 | fund | 天天基金网 |
| 现金 | cash | 固定价格 1 |
| 加密货币 | crypto | CoinGecko |

## 支持的货币

| 货币 | 代码 | 符号 |
|------|------|------|
| 人民币 | CNY | ¥ |
| 英镑 | GBP | £ |
| 美元 | USD | $ |
| 欧元 | EUR | € |
| 迪拉姆 | AED | د.إ |
| 日元 | JPY | ¥ |

## PM2 管理

```bash
# 查看状态
pm2 list

# 查看日志
pm2 logs asset-tracker

# 重启
pm2 restart asset-tracker

# 停止
pm2 stop asset-tracker
```

## Trading212 自动同步

每小时自动同步 Trading212 账户余额。

```bash
# 手动同步
/var/www/asset-tracker/scripts/sync-t212.sh

# 查看同步日志
tail -f /var/log/t212-sync.log
```

## 显示效果

首页按平台分组显示资产：

```
总资产: ¥100,000.00（示例）
汇率: £1 = ¥9.15  $1 = ¥7.24  €1 = ¥7.85

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ 示例银行      │ │ 示例券商      │ │ 示例基金      │
│ ¥50,000.00   │ │ £2,000.00    │ │ ¥30,000.00   │
│ ≈ ¥50,000.00 │ │ ≈ ¥18,000.00 │ │ ≈ ¥30,000.00 │
│ 3项          │ │ 2项          │ │ 4项          │
└──────────────┘ └──────────────┘ └──────────────┘
```

点击平台卡片可查看该平台所有资产详情。

## 更新日志

### 2026-04-12
- ✅ 集成 SSO 统一登录系统
- ✅ 添加 Token 缓存（5分钟 TTL）
- ✅ 按平台分组显示资产
- ✅ 自动货币转换（GBP/USD/EUR → CNY）
- ✅ 添加 `/api/auth/token` 端点
- ✅ 首页注入 `window.__USER__` 解决 httpOnly cookie 问题
- ✅ 前端错误处理优化

### 2026-03-24
- ✅ 项目迁移至 `/var/www/asset-tracker`
- ✅ 添加 Trading212 自动同步
- ✅ 升级 better-sqlite3 支持 Node.js 24

### 2026-03-12
- ✅ 代码模块化重构
- ✅ 添加加密货币价格获取（CoinGecko API）
- ✅ 配置 PM2 自动重启

## 相关文档

- [SSO 登录逻辑](./SSOLogin.md)
- [SSO 接入指南](/root/.openclaw/workspace/docs/SSO_LOGIN.md)

## License

MIT © Stone King Empire
