# 工具发现与 Code Mode

Zakura Agent 和 Space MCP 使用同一套工具命名、展示配置、搜索参数与调用参数。

## 工具展示

- Zakura 已启用的内置工具始终直接列出，包括电脑/文件/Shell/桌面/浏览器、记忆、Skill、会话、Routine、网页等；不会压缩到搜索入口中。功能开关、权限和 sandbox 限制仍然有效。
- 下游 MCP 也直接列出内置电脑、记忆、Skill 等工具；不依赖任何上游 MCP 安装。
- MCP 实例的 `exposure` 默认是 `deferred`，可选 `direct`（始终列出）、`deferred`（按需发现）、`hidden`（隐藏）。
- `toolExposure` 按上游工具原名覆盖默认值，支持 `*` 通配。精确名称优先，其次按字典序匹配通配规则。
- `direct` 工具在 Zakura Agent 的模型声明和下游 MCP `tools/list` 中始终出现。权限策略仍优先，固定展示不授予额外权限。
- `hidden` 工具不进入发现结果，也不能通过执行入口、Code Mode 或旧名称调用。
- MCP 实例的 `description` 作为能力简介，与少量工具名称一起提示 Agent 何时搜索这个服务器。

在「MCP 服务器 → 工具」页设置默认展示方式、逐工具展示方式及能力简介。例如：

```json
{
  "exposure": "deferred",
  "description": "搜索代码仓库、读取 Issue、管理 Pull Request",
  "toolExposure": {
    "search_issues": "direct",
    "get_*": "deferred",
    "delete_repository": "hidden"
  }
}
```

新的调用或下一次工具目录刷新采用设置。已连接的下游客户端应刷新工具列表；运行中的 Agent 回合保留其声明快照，但调用时会重新检查实际权限。

## 统一接口

`tool_search` 支持 `query`、`names`、`server`、`limit`、`offset`、`includeSchemas`。

```json
{"query":"search issues","server":"github","includeSchemas":true,"limit":3}
```

关键字搜索和空 query 浏览只返回上游 MCP 工具；`names` 精确查询也支持查看已直接列出的内置工具 Schema。返回 `tools`、`total`，有下一页时返回 `nextOffset`。默认 8 条，最多 20 条。默认只返回简短描述；`includeSchemas: true` 或 `names` 精确查询返回完整 JSON Schema 和调用示例。上游 MCP 的分页会被完整读取（最多 100 页）。搜索不会把工具追加到后续每轮的模型声明中。

`tool_execute` 使用发现结果中的确切名称：

```json
{"name":"mcp__github__search_issues","arguments":{"query":"is:open bug"}}
```

MCP 结果保留 `content`、`structuredContent`、`isError` 等原有结构。Zakura Agent 对实际目标工具执行审批、项目 hooks 和审计；包装入口不会重复要求审批。下游保持其原有 Space / Agent / API key / OAuth 权限及审计路径。

下游 MCP 默认列出获准的 Zakura 内置工具、`tool_search`、`tool_execute` 和用户设为 `direct` 的上游工具。内置工具保持与 Agent 一致的名称，上游工具采用相同的 `mcp__server__tool` 名称；历史的 `server__tool`、`re_server__tool`、`instanceId:tool` 调用仍兼容。需要完整声明的客户端可连接 `/mcp/spaces/{slug}?tools=expanded`，隐藏及被策略禁止的工具仍不会出现。

## 下游内置工具的范围

- `list_computers`、文件、Shell、桌面和浏览器工具直接使用连接所属 Space。`computerId` 可选择同 Space 已连接的电脑；不会自动创建电脑，也不会失败后切换到另一台。临时电脑仍须通过 Agent 会话使用。
- `list_skills`、`read_skill` 读取 Space 已安装的 Skill；Agent 绑定凭据只读取该 Agent 启用的 Skill。`read_skill({name, path})` 默认读取 `SKILL.md`，支持读取安装包中的辅助文件。
- 记忆、会话、Routine 等 Agent 所属数据沿用现有归属。Space MCP 调用必须提供同 Space 的 `agentId`；Agent 绑定凭据自动采用其绑定 Agent，不能切换。不会为 Space 创建或借用宿主 Agent。
- `includeBuiltin: false`、工具允许/拒绝列表、功能禁用和 Agent sandbox 限制仍生效。需要交互审批或 AI 审批的 Agent 操作须在 Agent 会话中完成；下游不会绕过审批直接执行。
- `ask_user`、`chat_reply`、`delegate_agent`、`codemode` 等需要当前 Agent run 的入口仍在 Agent 中直接列出，下游使用自己的会话交互与代码编排。MCP 资源继续通过标准 `resources/*` 接口提供。

## Code Mode

内置 Code Mode 继续在 Space workspace 中运行 Node.js，不在 API 服务进程中执行用户 JavaScript。它沿用 workspace 的执行权限，不是 QuickJS、Workers isolate 或其他受限 JavaScript 沙箱。下游 MCP 的 `tool_execute` 接收工具名及参数，不接收任意 JavaScript；客户端可以用自己的 Code Mode 编排这些 MCP 调用。

```js
const matches = await searchTools("search issues", { server: "github", limit: 3 });
text(matches);
const schema = await describeTool("mcp__github__search_issues");
text(schema);
```

已知参数后，可在同一脚本中组合独立调用并筛选结果：

```js
const results = await Promise.allSettled([
  tools["mcp__github__search_issues"]({ query: "is:open label:bug" }),
  tools["mcp__github__search_issues"]({ query: "is:open label:feature" })
]);
return results.map((result) => result.status === "fulfilled"
  ? result.value.structuredContent ?? result.value
  : { error: result.reason.message });
```

- 最多 4 个并发调用，每段脚本最多 128 次调用（包括发现）。单次工具调用限时 60 秒；脚本默认 120 秒，最大 600 秒。
- `await` 所有工具调用。脚本结束或取消后，未完成调用的上下文会取消。已经完成的工具副作用不会回滚。
- 大型 MCP 中间结果保留结构，分片传给 workspace，避免执行前就被预览文本替代。
- 只有 `text(...)`、`console.log(...)` 和 `return` 输出交给模型，文本预算约 24 KB，截断时返回 `truncated`。脚本抛错时保留已输出内容，并返回 `isError` 和错误原因。
- 内部调用事件保留用于 UI 与审计，重建模型历史时只放入外层调用的输出。
- 禁止递归启动 `codemode` 或 `tool_execute`。脚本直接调用目标工具即可。

## Agent 执行轮次

普通 Agent 调用、`tool_execute` 的实际目标、Code Mode 内部调用和下游 MCP 共用 JSON Schema 参数预检。参数必须是对象，并满足工具声明的必填、类型、枚举及其他 Schema 约束；错误会在审批和项目 hooks 前返回。校验不会填默认值或转换类型，不加载网络/文件等外部 Schema 引用。参数上限 4 MiB，Schema 上限 1 MiB；不合法的上游 Schema 会明确报错。

参考 Pi 的工具批次边界，Zakura 仅在整个批次都是 `fs_read` / `fs_list` 且没有工具 hooks 时启用最多 4 路并发。其他批次继续串行。预检和审批按声明顺序完成；结果一完成就记录事件，交给模型及历史回放的结果仍按原调用顺序排列。取消会停止派发、取消已启动调用并记录剩余结果；无法确认是否完成的调用标记为结果未知。

OpenAI `length`、Anthropic `max_tokens` 和 Responses `incomplete` 不再触发该回复中的工具执行。可识别的调用获得配对失败结果，长度截断最多允许一次带修正提示的继续；再次截断或其他 incomplete 原因明确结束运行。重复或冲突的调用 ID 会拒绝整个批次，缺失 ID 则生成运行内唯一标识。

引导消息在首次模型请求前及每轮工具完成后注入。对应的用户消息和队列移除在同一事务中提交；数据库失败不会丢失已出队消息。一次可合并多条兼容的引导消息，遇到会改变当前运行选项的消息时保留它及后续引导消息，等待独立运行应用这些设置。新图片会在下一次模型请求前读取，仍只发送最新两个含图片的用户消息。外部 hooks 不属于数据库事务，不能保证恰好执行一次。停止当前运行后继续处理队列。

## 参考

- Pi Agent loop：<https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts>

- Pi Code Mode：<https://pi.dev/docs/latest/codemode>
- OpenCode Code Mode：<https://github.com/anomalyco/opencode/blob/dev/packages/codemode/README.md>
- Cloudflare MCP Code Mode：<https://developers.cloudflare.com/agents/tools/codemode/mcp/>
