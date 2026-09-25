# Zakura Bot 用户渠道

`zakurabot` 是 first-party 私聊渠道。Zakura Bot 是 Zakura 的一等功能：**App 通过标准 OAuth 2.1（授权码 + PKCE）登录，以登录用户自身的权限访问租户内全部 Agent**——无需管理员预配、没有设备记录、没有独立的令牌体系。它复用 `RemoteAgentIngress`、远程会话注册表和 `chat_*` 工具；Slack、Telegram 等继续使用原来的 Chat SDK 适配器。

## 登录与权限

1. App 首次使用 `POST /oauth/register` 动态注册一个公共客户端（PKCE、`token_endpoint_auth_method:"none"`、scope 含 `api`）。
2. 浏览器打开 `/authorize`（标准 OAuth 2.1），用户用现有租户账号登录（含 MFA/SSO）并同意。
3. App 以授权码换取 `POST /token` 的 JWT access token（1 小时）与可轮换的 refresh token（30 天）。
4. 之后所有请求（REST、WS、文件、桌面）都带这个 Bearer token，权限即用户在 Zakura 的权限：成员可见并可使用租户内**全部** Agent；管理员额外可以创建/编辑/删除 Agent（走标准 `/api/agents`）。

没有专门的同意页、绑定选择或信任开关。撤销登录 = 标准 `POST /token/revoke`（吊销 refresh token）；成员被停用或租户被封禁后立即失去渠道访问。迁移 `0061_zakurabot_oauth_user` 删除了旧的 `zakurabot_devices`/`zakurabot_authorizations` 表，历史消息保留。

## Agent 资源

roster 即租户的 Agent 列表，新 Agent 自动出现；每个 Agent 首次被访问时自动获得一条启用的 `zakurabot` 绑定（内部路由实现，`allowAll` ACL），设备时代的「空白名单=拒绝」旧绑定会在首次使用时升级为开放。管理员禁用某 Agent 的 Zakura Bot 绑定即可切断其渠道访问。

Agent 管理直接使用标准租户 API（与控制台同权同限制）：

- `GET /api/agents` → 序列化后的 Agent 数组。
- `POST /api/agents {name, description?, enableComputer?, enableMemory?}` → 创建（201）。开启 Computer 即同时启用文件系统、Shell、浏览器与桌面。
- `PATCH /api/agents/:id` / `DELETE /api/agents/:id` → 更新/删除。

`/api/*` 中间件接受 scope 含 `api` 的 OAuth access token：校验签名、有效期与租户后，以「用户会话」上下文进入原有权限体系（成员角色、封禁检查全部照常）。MCP 专用的 token（仅 `mcp` scope）不能调用这些 API。

## App API 与文件通道

这些接口使用 `Authorization: Bearer <access-token>`（OAuth token 或控制台会话均可），返回 `Cache-Control: no-store`。URL 基于实例 URL，保留反向代理的路径前缀。

| 方法与路径 | 返回 / 用途 |
| --- | --- |
| `GET /api/zakurabot/agents` | `{agents: [...]}`，租户全部 Agent |
| `GET /api/zakurabot/bots` | 相同列表，字段名为 `bots` |
| `GET /api/zakurabot/agents/:agentId` | `{agent}`，包含 `bindingId` 与 `capabilities:{files,desktop,interactions}` |
| `GET /api/zakurabot/agents/:agentId/history?limit=100` | `{messages:[...]}`，按时间排序的用户回执和 `chat_reply` 帧；limit 为 1–100 |
| `POST /api/zakurabot/agents/:agentId/files` | multipart/form-data，唯一的 `file` 字段；201 返回 `{file:{id,name,mime,size,type,url}}` |
| `GET /api/zakurabot/agents/:agentId/files/:fileId` | 原始文件字节；返回 MIME、字节数和 UTF-8 `Content-Disposition` |

先上传，再通过 WS 引用返回的文件 ID：

```json
{"type":"send","agentId":"<agent-id>","clientMessageId":"upload-1","text":"请查看附件","attachments":[{"fileId":"<file.id>"}]}
```

正文可省略，单条消息最多 8 个不重复的文件 ID，每个文件必须非空且不超过 **16 MiB**。上传只接受文件名，名称上限为 UTF-8 180 字节；文件写入 Agent 工作区的生成目录。上传与下载按 tenant/用户/binding/agent 校验，用户之间互不可见对方上传的文件。缺少凭据返回 401，成员无权或文件系统禁用返回 403，文件不属于当前会话返回 404，超限返回 413。`file.url` 每次下载都需要 Bearer Token，不能放入查询参数。

## 桌面查看

| 方法与路径 | 返回 / 用途 |
| --- | --- |
| `GET /api/zakurabot/agents/:agentId/desktop` | 桌面能力和配置尺寸，以及截图路径、鉴权方式和建议刷新间隔 |
| `GET /api/zakurabot/agents/:agentId/desktop/frame` | 完整 `image/png` 字节，最大 8 MiB |

```json
{
  "enabled": true, "supported": true, "status": "running", "width": 1280, "height": 720,
  "coordinateSpace": "desktop pixels, origin top-left",
  "frameUrl": "https://zakura.example/prefix/api/zakurabot/agents/agent-1/desktop/frame",
  "frameAuthorization": "Bearer", "maxFrameBytes": 8388608, "suggestedIntervalMs": 2000
}
```

不支持桌面的工作区返回 `supported:false` 和 `frameUrl:null`。信息不返回 Runner 地址、CDP/noVNC 端口或容器 ID。每次捕获都重新校验成员与 Computer 权限，慢截图完成后再次校验。凭据失效返回 401，Computer 未启用或工作区不支持返回 409，截图失败返回 503。

## 交互消息：问题、授权与表单

启用后，Bot 的 `capabilities.interactions` 为 `true`。`ask_user_request`、ACP `permission_request` 和 `elicitation_request` 经同一 `chat_reply` 工具转换为卡片；按登录用户、绑定和会话授权。协议仍为 v1，增加可选的 `payload.interaction`，同时保留 `kind:"card"`：

```json
{
  "type": "chat_reply", "agentId": "<agent-id>", "messageId": "zbi_…", "createdAt": 1789689600000,
  "payload": {
    "kind": "card", "text": "允许执行此操作？", "reply_to": "user-1",
    "card": {"title": "允许执行此操作？", "subtitle": "等待回答"},
    "interaction": {
      "type": "approval", "requestId": "request-1", "status": "pending", "title": "允许执行此操作？",
      "options": [{"id": "allow", "label": "允许一次", "kind": "allow_once"}, {"id": "deny", "label": "拒绝", "kind": "reject_once"}]
    }
  }
}
```

`interaction.type` 为 `approval | question | form`；`status` 为 `pending | answered | cancelled | skipped | timeout | resolved`。状态变更使用原 `messageId` 和 `createdAt` 再发 `chat_reply`，客户端原位 upsert，只有 `pending` 可回答。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| `GET /api/zakurabot/agents/:agentId/interactions` | 当前会话未完成的交互，最多 100 条 |
| `GET /api/zakurabot/agents/:agentId/interactions/:messageId` | 单条状态快照 |
| `POST /api/zakurabot/agents/:agentId/interactions/:messageId` | 提交答案；成功返回 `{ok:true,messageId,createdAt,interaction,replyTo?}` |

- approval：`{"optionId":"allow"}`；question：`{"selected":["option-1"],"text":"补充"}`；form：`{"content":{...}}`；取消：`{"cancelled":true}`。
- 请求体限 64 KiB。缺凭据 401，交互不属于当前用户/会话 404，过期或重复回答 409，非法答案 400。并发回答只有一个能认领。
- 回答正文与密钥不写入渠道 transcript 或交互元数据；`secret:true` 使用密码输入。同步问题在运行结束后失效；异步问题在原回合完成后仍可回答并发起后续回合。

## WS v1

会话管理：`GET /api/zakurabot/sessions/:agentId` 返回 `bindingId/agentId/sessionId/status/title`；`POST` 同一路径携带 `{action:"start"|"stop"|"new"}`。start 在没有会话时创建；stop 等待当前运行取消；new 打断旧运行后建立新上下文。操作与 send 共用队列并重新校验成员权限。

连接 `{baseUrl}/api/zakurabot/ws`（HTTP→WS，HTTPS→WSS，保留部署路径前缀）。OAuth access token 只放在首个 `hello` JSON 文本帧中（JWT 较长，上限 4096 字符）；不使用 URL 或 cookie。

```json
{"type":"hello","protocol":1,"token":"eyJhbGciOiJSUzI1Ni…","client":{"name":"zakura-bot","version":"1.0"}}
{"type":"send","agentId":"<ready 中的 Agent ID>","clientMessageId":"user-1","text":"你好"}
{"type":"interrupt","agentId":"<agent-id>"}
{"type":"ping"}
```

服务端先返回 `ready {protocol:1, agents[], capabilities:[...]}`，之后发送：

| 帧 | 用途 |
| --- | --- |
| `agents` | 权限或状态变化后的 Agent 列表 |
| `message {message}` | 用户回执；保留 `clientMessageId` |
| `chat_reply {agentId,messageId,createdAt,payload}` | 助手可见回复 |
| `typing {agentId,active}` | 运行状态 |
| `tool_activity {agentId,message}` | 工具名称与状态；不转发原始参数或推理内容 |
| `error {message,agentId?,clientMessageId?,fatal?}` | 可关联到失败发送的错误 |
| `pong` | 心跳回应 |

每条用户消息限 4000 字符，JSON 帧限 1 MB；5 秒内未完成握手以 `4408` 关闭。无效凭据关闭码 `4401`，无权访问该 Agent `4403`，协议错误 `1008`——三者伴随 `error {fatal:true}`，客户端不应自动重连。连接期间也会重新检查成员状态与绑定。

## 会话与回复

线程由服务端按 **tenant/用户/binding/agent** 确定。相同 `clientMessageId` 的重试只补用户回执，不再次启动回合；重复 ID 携带不同正文或文件 ID 列表会被拒绝。Agent 必须通过 `chat_reply` 发出可见文字，默认引用入站消息 ID；普通 assistant delta 和 reasoning 不进入 WS；静默回合沿用 runtime 的一次 `chat_reply` 兜底。

用户回执和 `chat_reply` 持久化后才计为送达；断线不取消已启动回合。重连或服务重启后补发每个会话最近 100 条消息，ID 保持稳定。`chat_reply` 附件最多 8 个、每个 16 MiB，复用文件分享服务转换为 60 分钟有效的下载链接；该链接持有者可在有效期内下载，本地路径和文件字节不进入 WS。

## 部署与验证

设置 `ZAKURA_PUBLIC_URL` 为 App 能访问的地址，公网使用 HTTPS。反向代理必须将 `/api/zakurabot/ws` 的 `Upgrade`/`Connection` 头转发给 API 服务（`docker/nginx/proxy_locations.conf` 已包含），并转发 `/oauth/*`、`/token`、`/authorize`、`/.well-known/*`（已有规则）。开发时直接使用 `http://localhost:8787`。

v1 的 socket 投递和会话工具句柄驻留在当前服务进程。使用单个 API/runtime 实例，或保证同一用户始终路由到同一实例；当前没有跨进程 socket 广播。
