# Zakura Bot 远程渠道

`zakurabot` 是 first-party 私聊渠道，兼容 `Moonrend/zakura-bot@94fde6a` 的登录、bot/会话管理与 v1 消息协议。文件能力通过可选字段扩展 v1，客户端可按 capabilities 启用。它复用 `RemoteAgentIngress`、远程会话注册表和 `chat_*` 工具；Slack、Telegram 等继续使用原来的 Chat SDK 适配器。

## 连接 App

1. 升级服务端并应用迁移（正常启动会自动迁移，当前需要到 `0058_zakurabot_interactions`）。为 Agent 配置可用的 chat 模型；收发工作区文件还需要启用文件系统并绑定运行节点。
2. 在 Agent 的「平台」页添加 **Zakura Bot**，选择模型或跟随默认，保存。
3. App 首次启动输入实例 URL，点击 **Sign in with Zakura**，浏览器打开设备授权页。
4. 使用现有租户成员登录（支持 MFA/SSO），核对设备授权码，选择 1–16 个有权访问的绑定并批准。返回 App 后自动完成登录。

手动 fallback：在该绑定的「Zakura Bot 设备」中创建设备，将 Token 和 Base URL 填入 App 的 Advanced connection，关闭 Mock Channel。

浏览器授权需要新增迁移 `0056_zakurabot_authorization`。访问凭证有效 30 分钟，刷新凭证有效 90 天且每次使用后轮换；刷新保持同一个设备 ID 和会话历史。原生 App 使用 SecureStore，Web 使用当前标签页 sessionStorage；App 可保存多个实例并切换。登出撤销当前设备。

设备授权接口（JSON 请求体，公开接口不接受租户管理凭证来提升权限）：

- `POST /api/zakurabot/oauth/device-code {name,code_challenge?,code_challenge_method?}` → `device_code/user_code/verification_uri/verification_uri_complete/expires_in/interval`，10 分钟内有效。新客户端可同时传入 S256 challenge 和 `code_challenge_method:"S256"`；现有不带 PKCE 的设备码请求继续可用。
- `GET /api/zakurabot/authorization?user_code=…` → 设备名称和当前成员可授权的绑定；要求有效租户成员会话。
- `POST /api/zakurabot/authorization {user_code,approve,bindingIds}` → 批准或拒绝；成员只能授予自己可访问的绑定，管理员可授予当前租户的绑定。
- `POST /api/zakurabot/oauth/token {grant_type:"urn:ietf:params:oauth:grant-type:device_code",device_code,code_verifier?}` → 单次领取 `access_token/refresh_token/expires_in/refresh_expires_at/device/tenant/user/baseUrl`；使用 S256 的 grant 必须提供匹配的 verifier，不能省略或降级。等待时返回 `authorization_pending`，过快轮询返回 `slow_down`、`interval` 和 `Retry-After`。
- `POST /api/zakurabot/oauth/token {grant_type:"refresh_token",refresh_token}` → 轮换凭证。旧 refresh token 失效，已撤销或封禁的设备不能刷新。
- `POST /api/zakurabot/oauth/revoke {token}` → 撤销 access 或 refresh token 所属设备并关闭其 WS。

授权码、设备码和 refresh token 均只存哈希；凭证接口禁止缓存。设备码不进入浏览器 URL；授权码本身不能领取凭证。相同设备码只能消费一次，并发 refresh 只有一次成功。刷新后旧 WS 关闭，客户端以新凭据重连。`0057` 保留已有设备和未过期的授权请求。

手动设备 Token 默认有效 90 天，仅保存 SHA-256 哈希。受限绑定在签发时加入设备白名单；开放绑定保持开放，设备仍须拥有显式绑定授权。绑定禁用、白名单移除、设备撤销/过期或租户封禁都会阻止访问。浏览器授权的设备还跟随所属用户的成员状态和绑定权限。控制台可以撤销设备，已连接的 socket 会关闭。

## 管理 API

以下接口使用现有的**租户管理员会话** Bearer Token。设备 Token 仅能连接消息渠道及下列 App API，不能调用租户管理或其他 Zakura API。

```http
POST /api/remote-channels
Authorization: Bearer <admin-session-token>
Content-Type: application/json

{"agentId":"<agent-id>","platform":"zakurabot","label":"My Bot","enabled":true}
```

使用返回的 `binding.id` 签发设备：

```http
POST /api/zakurabot/devices
Authorization: Bearer <admin-session-token>
Content-Type: application/json

{"name":"My phone","bindingIds":["<binding-id>"],"expiresInDays":90}
```

返回 `{device, token, baseUrl}`，响应禁止缓存。`bindingIds` 可指定本租户的 1–16 个已启用绑定，同一 Agent 只能出现一次；这样一个设备能显示多个 Agent。`expiresInDays` 支持 1–365 天。

- `GET /api/zakurabot/devices`：列出本租户设备及有效期、撤销状态，不返回 Token 或哈希。
- `DELETE /api/zakurabot/devices/:id`：撤销设备，关闭连接并请求取消其正在运行的回合。
- 需要新凭据时创建设备并撤销旧设备；新设备有独立会话。

## App API 与文件通道

这些接口统一使用 `Authorization: Bearer <device-access-token>`，返回 `Cache-Control: no-store`。URL 基于凭据中的 `baseUrl`，保留反向代理的路径前缀。租户管理员 Token 不能替代设备 Token。

| 方法与路径 | 返回 / 用途 |
| --- | --- |
| `GET /api/zakurabot/me` | `{device,baseUrl,capabilities,groups:"client"}` |
| `DELETE /api/zakurabot/me` | 撤销当前设备并关闭 WS，返回 `{ok:true}` |
| `GET /api/zakurabot/agents` | `{agents: [...]}`，仅列出授权 bot |
| `GET /api/zakurabot/bots` | 相同列表，字段名为 `bots` |
| `GET /api/zakurabot/agents/:agentId` | `{agent}`，包含 `bindingId` 与 `capabilities:{files,desktop,interactions}` |
| `GET /api/zakurabot/agents/:agentId/history?limit=100` | `{messages:[...]}`，按时间排序的用户回执和 `chat_reply` 帧；limit 为 1–100 |
| `POST /api/zakurabot/agents/:agentId/files` | multipart/form-data，唯一的 `file` 字段；201 返回 `{file:{id,name,mime,size,type,url}}` |
| `GET /api/zakurabot/agents/:agentId/files/:fileId` | 原始文件字节；返回 MIME、字节数和 UTF-8 `Content-Disposition` |

先上传，再通过 WS 引用返回的文件 ID：

```json
{"type":"send","agentId":"<agent-id>","clientMessageId":"upload-1","text":"请查看附件","attachments":[{"fileId":"<file.id>"}]}
```

正文可省略，单条消息最多 8 个不重复的文件 ID，每个文件必须非空且不超过 **16 MiB**。multipart 请求额外允许 64 KiB 表单开销。上传只接受文件名，去除目录、替换控制字符，名称上限为 UTF-8 180 字节；客户端不能指定工作区目标路径。文件写入 Agent 工作区的生成目录，再以 `CloudAgentAttachment` 传给 runtime，图片保留 image 类型。WS 用户回执带 `attachments:[{id,name,mime,size,type,url}]`，不暴露本地路径或文件字节。

上传与下载均按 tenant/device/binding/agent 校验。即使另一个设备授权了同一 Agent，也不能引用或下载该文件 ID。上传和下载完成后再次检查权限；缺少设备凭据返回 401，无 Agent 授权或文件系统禁用返回 403，不属于当前会话或已删除的文件返回 404，超限返回 413，工作区暂不可用返回 503。原有文件被 Agent 移动后，需要重新上传才能发新消息；已经接受的 `clientMessageId` 重试仍能补回原始回执，不会重启回合。

`file.url` **每次下载都需要设备 Bearer Token**；Web 客户端可用带 Authorization 的 fetch 取得 Blob 再展示，不能把 Token 放入查询参数。URL 在权限和工作区文件有效期间可用。分组由客户端按实例本地保存，当前没有服务端分组同步 API。

## 交互消息：问题、授权与表单

启用后，实例 capabilities 包含 `interactions`，Bot 的 `capabilities.interactions` 为 `true`。`ask_user_request`、ACP `permission_request` 和 `elicitation_request` 经同一 `chat_reply` 工具转换为卡片；主会话及其同 Agent 的 ACP 派生会话都按原设备、绑定和会话授权。普通模型工具不能自行构造 interaction ID，询问用户应调用 `ask_user`。

协议仍为 v1，增加可选的 `payload.interaction`，同时保留 `kind:"card"` 和普通 `card`：

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

`interaction.type` 为 `approval | question | form`；`status` 为 `pending | answered | cancelled | skipped | timeout | resolved`。问题还可带 `allowMultiple/secret/mode:"sync"|"async"/expiresAt/placeholder`；表单带 `mode:"form"|"url"/url/fields`，字段包含 `id/type/title?/required?/options?`。状态变更使用原 `messageId` 和 `createdAt` 再发 `chat_reply`，客户端应原位 upsert，只有 `pending` 可回答。

接口均使用设备 Bearer Token、`Cache-Control: no-store`，保留实例 URL 前缀：

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| `GET /api/zakurabot/agents/:agentId/interactions` | 当前会话未完成的交互，最多 100 条：`{interactions:[{messageId,createdAt,interaction}]}` |
| `GET /api/zakurabot/agents/:agentId/interactions/:messageId` | 单条状态快照：`{messageId,createdAt,interaction,replyTo?}`；也可查询旧会话的已结束卡片 |
| `POST /api/zakurabot/agents/:agentId/interactions/:messageId` | 提交答案；成功返回 `{ok:true,messageId,createdAt,interaction,replyTo?}` |

回答使用卡片外层的 `messageId` 定位，客户端不能传 tenant/device/session/run ID。JSON 请求体按类型填写：

- approval：`{"optionId":"allow"}`，只能选择服务端提供的选项。
- question：`{"selected":["option-1"],"text":"补充说明"}`，选项与文本至少一项非空；多选必须有 `allowMultiple:true`。
- form：`{"content":{"methodId":"browser","count":1}}`，只接受已声明的字段，校验必填项、类型及选项。URL 模式可在外部授权结束后提交 `{}` 确认，或由 ACP 的完成事件自动更新。
- 任意类型取消：`{"cancelled":true}`。

请求体限 64 KiB、文本限 8000 字符、选项最多 32 项。缺少或无效设备凭据返回 401，无 Bot 权限返回 403，交互不属于当前设备/会话返回 404，过期、重复回答或原运行已结束返回 409，非法答案返回 400，超限返回 413，服务不可用返回 503。并发回答只有一个请求能认领交互；HTTP 成功响应和单条快照可用于 WS 断线时确认最终状态。

回答正文、密钥和原始工具参数/结果不写入渠道 transcript、交互元数据或 WS。`secret:true` 使用密码输入，提交后清空；原始答案仅交给已有的 ask_user/ACP 处理服务。同步问题在运行结束后失效；异步问题在原回合完成后仍可回答，并通过原远程会话发起后续回合。新建会话会取消旧问题，重连/重启会重放状态并补齐遗漏的卡片。

`zakura-bot@f895388` 可显示普通 fallback 卡片；可回答 UI 需读取新增的 `interaction` 字段、调用上述接口，并按 `messageId` 更新状态。实例 capability 表示服务端支持，不代表旧版客户端已经具有回答控件。

## WS v1

App 会话管理使用设备 Bearer Token：`GET /api/zakurabot/sessions/:agentId` 返回 `bindingId/agentId/sessionId/status/title`；`POST` 同一路径携带 `{action:"start"|"stop"|"new"}`。start 在没有会话时创建；stop 等待当前运行取消；new 打断旧运行后建立新上下文。操作与 send 共用队列，并重新校验设备及绑定权限。历史消息继续保留在设备会话的 transcript 中。

连接 `{baseUrl}/api/zakurabot/ws`（HTTP→WS，HTTPS→WSS，保留部署路径前缀）。Token 只放在首个 `hello` JSON 文本帧中；不使用 URL、cookie 或客户端自报的租户/设备 ID。

```json
{"type":"hello","protocol":1,"token":"zbot_…","client":{"name":"zakura-bot","version":"1.0"}}
{"type":"send","agentId":"<ready 中的 Agent ID>","clientMessageId":"user-1","text":"你好"}
{"type":"interrupt","agentId":"<agent-id>"}
{"type":"ping"}
```

服务端先返回 `ready {protocol:1, agents[], capabilities:["agents","history","files","interactions"]}`（具体能力取决于服务配置），之后发送：

| 帧 | 用途 |
| --- | --- |
| `agents` | 权限或状态变化后的 Agent 列表 |
| `message {message}` | 用户回执；保留 `clientMessageId`，确认已存储的入站消息 |
| `chat_reply {agentId,messageId,createdAt,payload}` | 助手可见回复；支持 `text/kind/format/reply_to/attachments/actions/card/interaction` |
| `typing {agentId,active}` | 运行中及完成/取消后的输入状态 |
| `tool_activity {agentId,message}` | 工具名称、开始/结束/取消状态；不转发原始参数、结果或推理内容 |
| `error {message,agentId?,clientMessageId?,fatal?}` | 可关联到失败发送的错误 |
| `pong` | 心跳回应 |

每条用户消息限 4000 字符，JSON 帧限 1 MB；5 秒内未完成握手会关闭。无效凭据使用关闭码 `4401`，无授权绑定使用 `4403`，协议错误使用 `1008`。连接期间也会重新检查权限和有效期。

## 会话与回复

线程由服务端按 **tenant/device/binding/agent** 确定，设备不能指定别人的会话。相同 `clientMessageId` 的重试只补用户回执，不再次启动回合；重复 ID 携带不同正文或文件 ID 列表会被拒绝。新消息和 `interrupt` 使用现有远程入口的取消机制。

Agent 必须通过 `chat_reply` 发出可见文字，默认引用入站消息 ID。post/channel/DM 变体也编码为 `chat_reply`，目标限定在当前设备会话。普通 assistant delta 和 reasoning 不进入 WS；静默回合沿用现有 runtime 的一次 `chat_reply` 兜底，已送达的交互卡片也计为可见回复。异步答案触发的后续回合恢复远程工具并重新计算兜底状态。当前服务端每次工具调用发送完整回复，未使用可选的 `message_delta/message_done`。

用户回执和 `chat_reply` 持久化后才计为送达；断线不取消已启动回合。重连或服务重启后会补发每个授权会话最近 100 条消息，ID 保持稳定，客户端可直接 upsert。typing/tool 活动只实时发送。

助手通过 `chat_reply` 发出的附件最多 8 个，工作区文件每个不超过 16 MiB。服务端复用文件分享服务，将路径转换为有效 60 分钟的 HTTP(S) 下载链接；该分享链接持有者可在有效期内下载，本地路径和文件字节不进入 WS。已有公开 URL、URL 按钮和结构化卡片会保留，非 HTTP(S) 或含用户名/密码的 URL 会被拒绝。分享链接到期后需要重新发送附件。这与上述需要设备凭据的上传文件下载 URL 分别使用各自的鉴权方式。

## 部署与验证

设置 `ZAKURA_PUBLIC_URL` 为 App 能访问的地址，公网使用 HTTPS。反向代理必须将 `/api/zakurabot/ws` 的 `Upgrade` / `Connection` 头转发给 API 服务；仓库的 `docker/nginx/proxy_locations.conf` 已包含专用规则。开发时可直接使用 API 的 `http://localhost:8787`（手机应使用能访问的主机地址）。

v1 的 socket 投递和会话工具句柄驻留在当前服务进程。使用单个 API/runtime 实例，或保证同一设备始终路由到同一实例；当前没有跨进程 socket 广播。

```sh
REDIS_URL=off pnpm --filter @zakura/server exec tsx --test --test-force-exit --test-concurrency=2 'test/zakurabot-*.test.ts' test/remote-channel-tools.test.ts test/remote-channel-commands.test.ts test/remote-agent-ingress.test.ts test/acp-elicitation.test.ts test/db-migrations.test.ts
pnpm typecheck
```

集成测试使用真实 WS、PGlite、RemoteAgentIngress 和会话存储，以受控 runtime 验证鉴权、隔离、幂等、打断、附件下载、交互回答/超时/恢复、ACP 派生会话归属及 Socket.IO 共存。ACP URL 完成关联另用真实 SDK 消息流验证，无需外部模型或聊天平台凭据。
