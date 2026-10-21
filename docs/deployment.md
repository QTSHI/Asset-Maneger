# 配置与部署

本说明适用于已有统一登录的单家庭 Stone Wealth 实例。本地预览方式见 [README](../README.md#快速开始)，备份与恢复操作见 [个人家庭版备份说明](personal-backup.md)。

## 环境变量

变量示例见 [`.env.example`](../.env.example)。当前启动入口不会自动读取 `.env`，请通过终端或进程管理器注入；也可在直接启动 Node.js 时显式指定 `--env-file`。不要把真实密钥提交到 Git。

| 变量 | 用途与默认行为 |
| --- | --- |
| `PORT` | 后端端口，默认 `8080`；前端开发代理也使用 `8080` |
| `ASSET_TRACKER_DB_PATH` | 数据库路径；正式环境默认 `database.sqlite`，开发启动必须使用独立路径 |
| `T212_API_KEY` / `T212_API_SECRET` | 可选的 Trading212 同步凭据 |
| `ASSET_TRACKER_PUBLIC_ORIGIN` | 正式网站来源，用于写入来源检查及登录回跳 |
| `ASSET_TRACKER_MCP_ALLOWED_HOSTS` | MCP 允许的 Host，逗号分隔 |

备份路径、保留份数与有效期限见 [备份配置](personal-backup.md)。

## SSO 与反向代理

生产认证使用既有 SSO，包括 Token 验证、五分钟缓存、服务权限、登录跳转、401 行为及用户注入。业务接口统一挂载在认证之后的 `/api/v2`。

`/api/v2` 的所有写入请求必须带有匹配网站来源的 `Origin`；前端正常操作会自动发送。若反向代理向应用转发的是内部 Host，可设置 `ASSET_TRACKER_PUBLIC_ORIGIN=https://asset.stoneking.top`；换域名时同步更新该值及 `ASSET_TRACKER_MCP_ALLOWED_HOSTS`。

Agent 使用独立的 `/mcp` 入口，凭证与网站 SSO 分开。详见 [Agent 接入说明](agent-access.md) 与 [网站审核接口 OpenAPI](agent-review.openapi.json)。

## 数据与迁移

- 正式数据：`database.sqlite`。
- 本地预览副本：`database.dev.sqlite`（已忽略）。
- 版本记录：`schema_migrations`。
- 业务删除采用软删除，写操作记录 SSO 用户名。
- 旧资产、平台、货币和类型 ID 不变。
- `daily_summary` 历史数据迁入 `portfolio_snapshots`。

上线前至少同时备份 `database.sqlite` 和当前代码版本。上传构建产物和后端代码时不要覆盖正式数据库，再由新版启动过程执行增量迁移。运行中的 SQLite 数据库采用 WAL 模式，请使用 [在线备份与恢复流程](personal-backup.md)，不要只复制主数据库文件。

## 上线步骤

服务器需要 Node.js 20.19+（20.x）、22.12+（22.x）或 24.x；现有部署使用 PM2 管理进程，运行前应已安装并配置 PM2。

```bash
npm ci
npm run check
pm2 startOrReload ecosystem.config.js
```

`npm run check` 已包含类型检查、单元测试和前端构建；前端输出为 `src/public/`。PM2 进程名仍为 `asset-tracker`，保持与现有运维脚本一致。每日快照可由服务内定时任务完成，也可单独执行 `daily-update.sh`。

备份任务不会随网站启动自动安装或启用。每日任务模板、状态检查、恢复演练、外部通知与异地副本要求见 [个人家庭版备份说明](personal-backup.md)。
