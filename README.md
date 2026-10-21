# Stone Wealth

Stone Wealth 是面向家庭场景的资产与财务中心，提供资产、家庭收支记录、统一账户和数据状态。

[项目概览](#项目概览) · [快速开始](#快速开始) · [使用说明](#使用说明) · [开发与验证](#开发与验证) · [目录结构](#目录结构) · [项目文档](#项目文档) · [当前边界](#当前边界)

## 项目概览

本仓库为 `QTSHI/Asset-Maneger`，产品名称为 **Stone Wealth**。前端使用 React + TypeScript，后端使用 Express + SQLite，并提供需要本人确认的 MCP Agent 资产修改流程。

站点入口：<https://asset.stoneking.top>（需要既有统一登录与服务权限）。查看代码和本地预览无需正式站点账号。

- 资产按“类别 → 账户 → 持仓”或“账户 → 类别 → 持仓”查看，现金、基金、股票、另类资产和待分类采用统一 CNY 估值。
- 账户支持编辑、归档与恢复；现金余额可直接确认，并提示上次确认时间；资产和收支提供回收站。
- 家庭实际收支与资产资金流独立记录，不会自动修改持仓。
- Trading212 现金与开放持仓分别同步，并以账户总值做对账；认证、汇率或对账失败时保留原有资产。
- 行情与汇率缓存、组合与持仓每日快照、全量操作审计；总览和数据状态页集中列出待核对项，可定位持仓，缺少汇率时也能查看清单。
- 账户、在用持仓、本月或全部收支可导出 CSV，保留原币字段与记账时汇率。
- Agent 可查询资产并提交待确认的修改建议；只有本人在网站确认后才会写入资产。
- 明暗主题、金额隐私模式、桌面侧栏和移动端底部导航。

## 快速开始

需要 Node.js 20.19+（20.x）、22.12+（22.x）或 24.x。

首次下载项目：

```bash
git clone https://github.com/QTSHI/Asset-Maneger.git
cd Asset-Maneger
npm ci
```

macOS / Linux / WSL 启动前后端：

```bash
npm run dev
```

Windows PowerShell 请在项目目录分别打开两个终端。第一个启动后端：

```powershell
$env:NODE_ENV = 'development'
$env:ASSET_TRACKER_DB_PATH = 'database.dev.sqlite'
node src/server.cjs
```

第二个启动前端：

```bash
npm run dev:client
```

打开 <http://127.0.0.1:5173>；后端默认监听 <http://127.0.0.1:8080>。本地预览使用 `database.dev.sqlite` 和模拟家庭成员身份，不会改动正式数据库，也不会进入生产 SSO 逻辑。空数据库会初始化表结构，先创建账户，再录入资产；本地预览不需要 Trading212 凭据。

`npm run dev:server` 使用 POSIX 环境变量语法，因此 Windows PowerShell 使用上述方式。预览模式绕过登录，只用于本机开发。

如果 `better-sqlite3` 报 Mach-O、架构或原生模块加载错误，请确认 Node.js 版本符合要求，并在当前操作系统和架构上重新执行 `npm ci`；不要复用其他系统的 `node_modules`。

## 使用说明

### 日常记录与恢复

外币资产和资金流必须有有效兑人民币汇率。遇到缺失汇率时，接口会提示具体币种，不会按 1:1 计价。行情刷新失败时保留上次有效汇率并将缓存标为过期。

资产和收支页面的回收站用于恢复误归档记录。同步管理的资产需要重新同步；所属账户已归档时先恢复账户。收支的“仅恢复收支”会解除原资金流关联，并保持原资金流的有效或归档状态。历史归档缺少可靠联动记录，或原资金流已被修改时，不自动恢复资金流，避免重复计入金额。

CSV 导出只包含未归档记录，持仓同时排除已归档账户；收支可选当前月份或全部日期。导出的是原始字段与缓存行情，缺失行情/汇率留空，不伪造为零或 1:1；它不等同于完整数据库备份。文件含真实金额，隐私模式下也需明确确认下载。为防止表格软件执行文本中的公式，危险开头的文本会添加保护性单引号。

### Agent、配置与备份

Agent 使用网站签发的独立、可撤销凭证，只能通过 `/mcp` 查询资产与提交建议，不能调用普通业务写入接口。建议由同一 SSO 用户在网站确认或拒绝，Agent 无法确认自己的建议。配置步骤见 [Agent 接入说明](docs/agent-access.md)。

变量示例见 [`.env.example`](.env.example)。当前启动入口不会自动读取 `.env`，请通过终端或进程管理器注入，或直接启动 Node.js 时显式指定 `--env-file`。环境变量、反向代理来源检查、SSO、数据库迁移和 PM2 上线步骤见 [配置与部署](docs/deployment.md)。

`npm run backup` 创建并验证 SQLite 在线备份，`npm run backup:check` 检查备份缺失、过期或失败。默认保留最近 30 份由任务验证的备份，仅在新备份成功后清理本任务管理的旧副本，默认目录在项目之外。定时任务、恢复演练与异地副本要求见 [备份与恢复](docs/personal-backup.md)；定时任务仍需服务器手动启用，异地副本需另外保管。

## 开发与验证

| 命令 | 检查内容 |
| --- | --- |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | Vitest 单元与交互测试 |
| `npm run build` | 生成前端部署产物到 `src/public/` |
| `npm run check` | 依次执行类型检查、单元测试与构建 |
| `npm run test:e2e` | Playwright 浏览器流程 |

首次运行浏览器测试前安装 Chromium：

```bash
npx playwright install chromium
npm run test:e2e
```

端到端测试配置覆盖 375px、768px、常规桌面和 1440px 页面，使用独立的临时数据库及模拟数据，不复用正在运行的本地网站。测试服务使用 5273 和 8187 端口，退出后自动清理。[GitHub 检查配置](.github/workflows/checks.yml)在 PR 和 `main` 更新时运行类型检查、测试、构建及浏览器流程；实际结果以对应提交的运行记录为准。

依赖审计可单独运行 `npm audit`。`src/public/` 当前随仓库保存，构建后请检查其差异；日常修改以 `client/` 为源文件，勿手工编辑压缩后的部署文件。协作要求见 [贡献指南](CONTRIBUTING.md)。

## 目录结构

```text
client/                    React + TypeScript 前端
src/server.cjs             Express 启动与原 SSO 边界
src/routes/v2.cjs          Stone Wealth API
src/mcp.cjs                MCP Agent 接入边界
src/services/              估值、行情、Trading212 与数据库服务
src/db/migrations.cjs      增量数据库迁移
src/public/                npm run build 生成的部署产物
tests/                     单元与端到端测试
docs/                      配置部署、Agent 接入、备份与产品路线图
deploy/systemd/            Linux 每日备份任务示例
```

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [配置与部署](docs/deployment.md) | 环境变量、SSO、反向代理、数据库迁移与 PM2 上线 |
| [Agent 接入](docs/agent-access.md) | 凭证创建、MCP 配置与网站确认流程 |
| [审核接口 OpenAPI](docs/agent-review.openapi.json) | 网站审核接口描述 |
| [备份与恢复](docs/personal-backup.md) | 在线备份、状态检查、每日任务及恢复步骤 |
| [产品路线图](docs/product-roadmap.md) | 当前家庭版本的范围与后续优化候选 |
| [贡献指南](CONTRIBUTING.md) | 开发检查、Issue、PR 与敏感数据处理 |

## 当前边界

- 当前版本供同一家庭使用：已获授权的家庭成员共用一套资产数据；尚未提供面向陌生用户的家庭隔离或公开注册。后续公开发布门槛见产品路线图。
- 家庭预算和计划与提醒暂时从页面、导航和首页撤下，相关 API 返回 410，不再接受新增或修改；原有记录仍保存在数据库中，供后续重新设计时恢复。
- 本地预览用于开发；正式使用需要既有 SSO、服务权限和服务器部署。定时备份、外部通知与异地保管仍需部署环境配置。
