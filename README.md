# Stone Wealth

Stone Wealth 是面向家庭场景的资产与财务中心。原资产追踪能力保留为“资产”模块，并新增家庭预算、实际收支、专项计划、大额收支备忘、统一账户和数据状态。

生产地址：<https://asset.stoneking.top>

## 主要能力

- 资产按“类别 → 账户 → 持仓”或“账户 → 类别 → 持仓”查看
- 现金、基金、股票、另类资产和待分类采用统一 CNY 估值
- 家庭预算与实际收支独立管理，不会自动修改资产
- 专项计划和未来 30 天大额收支提醒
- Trading212 现金与开放持仓分别同步，并以账户总值做对账
- 行情与汇率缓存、组合与持仓每日快照、全量操作审计
- 明暗主题、金额隐私模式、桌面侧栏和移动端底部导航

## 本地预览

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

## 数据与迁移

- 正式数据：`database.sqlite`
- 本地预览副本：`database.dev.sqlite`（已忽略）
- 版本记录：`schema_migrations`
- 所有删除均为软删除，写操作记录 SSO 用户名
- 旧资产、平台、货币和类型 ID 不变
- `daily_summary` 历史数据迁入 `portfolio_snapshots`

上线前至少同时备份 `database.sqlite` 和当前代码版本。上传构建产物和后端代码时不要覆盖正式数据库，然后再由新版启动过程执行增量迁移。

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

```bash
npm ci
npm run check
npm run build
pm2 startOrReload ecosystem.config.js
```

PM2 进程名仍为 `asset-tracker`，避免破坏现有运维脚本。每日快照可由服务内定时任务完成，也可单独执行 `daily-update.sh`。
