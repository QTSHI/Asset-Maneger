# Stone Wealth

Stone Wealth 是面向家庭场景的资产与财务中心，提供资产、家庭收支记录、统一账户和数据状态。

当前版本供同一家庭使用：已获授权的家庭成员共用一套资产数据；尚未提供面向陌生用户的家庭隔离或公开注册。最小使用范围及后续公开发布门槛见 [产品路线图](docs/product-roadmap.md)。

生产地址：<https://asset.stoneking.top>

## 主要能力

- 资产按“类别 → 账户 → 持仓”或“账户 → 类别 → 持仓”查看
- 现金、基金、股票、另类资产和待分类采用统一 CNY 估值
- 账户可编辑、归档和恢复；现金余额可直接确认，并提示上次确认时间
- 家庭实际收支与资产资金流独立记录，不会自动修改持仓
- Trading212 现金与开放持仓分别同步，并以账户总值做对账；认证、汇率或对账失败时保留原有资产
- 行情与汇率缓存、组合与持仓每日快照、全量操作审计
- Agent 可查询资产并提交待确认的修改建议；只有本人在网站确认后才会写入资产
- 明暗主题、金额隐私模式、桌面侧栏和移动端底部导航

家庭预算和计划与提醒暂时从网站页面、导航和首页撤下，相关 API 返回 410，不再接受新增或修改。原有记录仍保存在数据库中，便于后续重新设计时恢复。

## 本地预览

需要 Node.js 20.19+（20.x）、22.12+（22.x）或 24.x。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。本地预览使用 `database.dev.sqlite` 和模拟家庭成员身份，不会改动正式数据库，也不会进入生产 SSO 逻辑。

如果 `better-sqlite3` 报 Mach-O 或架构错误，先在项目目录执行：

```bash
rm -rf node_modules
npm install
```

## 常用检查

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm audit
```

端到端测试覆盖 375px、768px、常规桌面和 1440px 页面。

## 配置

复制 `.env.example` 后通过环境变量注入密钥，不要把真实值提交到 Git：

```bash
T212_API_KEY=...
T212_API_SECRET=...
```

生产认证继续使用既有 SSO：Token 验证、五分钟缓存、服务权限、登录跳转、401 行为及用户注入均保留。业务接口统一挂载在认证之后的 `/api/v2`。

Agent 接入使用网站签发的独立、可撤销访问凭证，仅能通过 `/mcp` 查询资产和提交修改建议。此凭证不能调用普通业务写入接口。修改建议在网站内由同一 SSO 用户查看、确认或拒绝；Agent 无法确认自己的建议。配置与使用方式见 [Agent 接入说明](docs/agent-access.md)，网站审核接口见 [OpenAPI 描述](docs/agent-review.openapi.json)。

外币资产和资金流必须有有效兑人民币汇率。遇到缺失汇率时，接口会提示具体币种，不会按 1:1 计价。行情刷新失败时保留上次有效汇率并将缓存标为过期。

## 数据与迁移

- 正式数据：`database.sqlite`
- 本地预览副本：`database.dev.sqlite`（已忽略）
- 版本记录：`schema_migrations`
- 所有删除均为软删除，写操作记录 SSO 用户名
- 旧资产、平台、货币和类型 ID 不变
- `daily_summary` 历史数据迁入 `portfolio_snapshots`

上线前至少同时备份 `database.sqlite` 和当前代码版本。上传构建产物和后端代码时不要覆盖正式数据库，然后再由新版启动过程执行增量迁移。

日常使用可通过 `npm run backup` 创建并验证 SQLite 在线备份；备份默认保存在项目目录之外。路径配置、恢复步骤与定期备份建议见 [个人家庭版备份说明](docs/personal-backup.md)。

## 目录

```text
client/                    React + TypeScript 前端
src/server.cjs             Express 启动与原 SSO 边界
src/routes/v2.cjs          Stone Wealth API
src/services/              估值、行情、Trading212 与数据库服务
src/db/migrations.cjs      增量数据库迁移
src/public/                npm run build 生成的部署产物
tests/                     单元与端到端测试
```

## 部署

服务器也需要上述 Node.js 版本。若反向代理向应用转发的是内部 Host，可设置 `ASSET_TRACKER_PUBLIC_ORIGIN=https://asset.stoneking.top`；换域名时同步更新该值及 `ASSET_TRACKER_MCP_ALLOWED_HOSTS`。

```bash
npm ci
npm run check
npm run build
pm2 startOrReload ecosystem.config.js
```

PM2 进程名仍为 `asset-tracker`，避免破坏现有运维脚本。每日快照可由服务内定时任务完成，也可单独执行 `daily-update.sh`。
