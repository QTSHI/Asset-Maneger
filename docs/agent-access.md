# Agent 接入与资产修改确认

Stone Wealth 提供 MCP 接口，让 Agent 查询家庭资产并提交修改建议。Agent 没有资产写入、删除、审批、数据库或服务器管理工具。资产最终只会在网站用户确认后由现有业务服务更新。

## 使用流程

1. 使用现有统一登录打开网站的「Agent 授权」页面，创建一个访问凭证。凭证只显示一次，复制后妥善保管。
2. 在支持 Streamable HTTP MCP 的 Agent 客户端中配置 `/mcp` 地址，并将凭证作为 `Authorization: Bearer <凭证>` 请求头发送。本地预览地址是 `http://127.0.0.1:8080/mcp`；正式环境上线后才使用正式 HTTPS 域名。
3. Agent 可调用 `list_assets`、`get_asset` 和 `propose_asset_change`。最后一个工具只建立待确认记录，不修改资产。提交建议时需附一个 8–120 字符的 `idempotencyKey`（例如 UUID）；同一次建议重试时复用它，新的建议使用新值。
4. 返回网站的「Agent 授权」页面，查看建议来源并核对每一项修改前后的值，再选择确认或拒绝。资产在确认时重新校验；期间若已被其他操作修改，旧建议不会覆盖新数据。
5. 不再使用某个 Agent 时，在网站撤销其访问凭证。

`/mcp` 采用 Streamable HTTP，仅接受服务端客户端发送的 POST 请求和 Bearer 凭证。默认允许 `asset.stoneking.top` 与本机 Host；如果将来换域名，可通过 `ASSET_TRACKER_MCP_ALLOWED_HOSTS` 设置逗号分隔的允许列表，并设置 `ASSET_TRACKER_PUBLIC_ORIGIN` 为网站的 HTTPS 来源（例如 `https://asset.stoneking.top`）。网站审核用的普通 REST 接口有单独的 [OpenAPI 描述](agent-review.openapi.json)。

## 权限边界

- Agent 凭证与统一登录会话分开。它只用于 `/mcp`，不能调用 `/api/v2` 或旧版资产写入接口。
- 凭证在数据库中只保存哈希值，支持到期和撤销。不要把凭证放在 URL、聊天内容、仓库或日志中。
- 当前网站是共享家庭资产库，获授权的家庭成员可看到同一组资产；修改建议和确认记录按凭证所属的统一登录用户关联。
- 网站确认是服务器端校验的必要步骤。Agent 客户端自己的“批准调用工具”提示不能代替网站确认。
- 每名用户最多保留 100 项待确认建议；请先处理旧建议，再提交更多修改。
- 已撤下的家庭预算和计划与提醒功能不提供给 Agent。

本地预览继续使用独立开发数据库和模拟身份。正式网站仍由用户自行上线，部署前应备份正式数据库，并在 HTTPS 环境中配置 Agent 客户端。
