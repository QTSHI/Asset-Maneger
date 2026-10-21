# 贡献指南

## 开始之前

Stone Wealth 当前服务于一个共享资产数据的家庭。请先阅读 [README](README.md) 与 [产品路线图](docs/product-roadmap.md)，确认提议属于当前范围；预算、计划提醒和面向公众的多家庭产品仍需单独设计。

`package.json` 声明 `MIT`，仓库当前尚未提供独立的 `LICENSE` 文件。维护者需确认版权信息并补齐正式文本；文档整理不代替该决定，也不变更现有声明。

## 开发与验证

按 README 安装受支持的 Node.js 并执行 `npm ci`，使用独立的 `database.dev.sqlite` 启动预览。Windows PowerShell 的启动方式见 [快速开始](README.md#快速开始)。

- 代码改动执行 `npm run check`；涉及页面或用户流程时，先执行 `npx playwright install chromium`，再运行 `npm run test:e2e`。
- 仅改文档时，检查链接、命令和 `git diff --check` 即可，无需为排版调整运行全套应用测试。
- 记录实际结果与尚未执行的检查，不把工作流配置当作测试通过的证据。

## 提交 Issue

使用 [问题反馈](.github/ISSUE_TEMPLATE/bug_report.md) 或 [功能建议](.github/ISSUE_TEMPLATE/feature_request.md) 模板，提供版本、复现步骤、预期与实际表现，或说明需要解决的家庭使用场景。

请使用虚构账户与金额，截图和日志先移除家庭资产及身份信息。不要在公开 Issue 中发送密钥或可利用的安全细节。

## 提交 PR

按照 [PR 模板](.github/pull_request_template.md) 说明目的与改动、验证结果和影响范围。保持改动集中，并同步更新受影响的文档；未执行的检查说明原因。

涉及数据时，说明迁移、软删除、审计与恢复流程的影响；涉及权限时，保留网站 SSO 与 `/mcp` 边界。Agent 只能提交待确认建议，确认操作必须来自网站用户。

## 数据与生成文件

- 前端源文件在 `client/`，业务路由与服务在 `src/`，数据库增量迁移在 `src/db/migrations.cjs`。
- `src/public/` 是受 Git 跟踪的前端构建产物，只通过 `npm run build` 更新，提交前核对生成差异。
- 保留现有数据库 ID、软删除与审计规则；数据库变更采用增量迁移，并使用临时测试库验证。
- 不提交真实数据库、备份、金额明细、账户信息、SSO Token、MCP 凭证或 Trading212 密钥；合并前检查完整差异。
