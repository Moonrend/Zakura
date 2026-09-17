# Zakura Bot 远程渠道

`zakurabot` 是 first-party 私聊渠道，兼容 `Moonrend/zakura-bot@786d427` 的 v1 协议。它复用 `RemoteAgentIngress`、远程会话注册表和 `chat_*` 工具；Slack、Telegram 等继续使用原来的 Chat SDK 适配器。

## 连接 App

1. 升级服务端并应用迁移（正常启动会自动迁移，新增 `0055_zakurabot_channel`）。为 Agent 配置可用的 chat 模型。
2. 在 Agent 的「平台」页添加 **Zakura Bot**，选择模型或跟随默认，保存。
3. App 首次启动输入实例 URL，点击 **Sign in with Zakura**，浏览器打开设备授权页。
4. 使用现有租户登录（支持 MFA/SSO），核对设备授权码，选择 1–16 个绑定并批准。返回 App 后自动完成登录。

手动 fallback：在该绑定的「Zakura Bot 设备」中创建设备，将 Token 和 Base URL 填入 App 的 Advanced connection，关闭 Mock Channel。

浏览器授权需要新增迁移 `0056_zakurabot_authorization`。访问凭证有效 30 分钟，刷新凭证有效 90 天且每次使用后轮换；刷新保持同一个设备 ID 和会话历史。原生 App 使用 SecureStore，Web 使用当前标签页 sessionStorage；App 可保存多个实例并切换。登出撤销当前设备。

设备授权接口（JSON 请求体，公开接口不接受租户管理凭证来提升权限）：

- `POST /api/zakurabot/oauth/device-code {name}` → `device_code/user_code/verification_uri/verification_uri_complete/expires_in/interval`，10 分钟内有效。
- `GET /api/zakurabot/authorization?user_code=…` → 设备名称和当前租户可授权绑定；要求有效租户管理员会话。
- `POST /api/zakurabot/authorization {user_code,approve,bindingIds}` → 批准或拒绝；要求租户管理员，绑定必须属于当前租户。
- `POST /api/zakurabot/oauth/token {grant_type:"urn:ietf:params:oauth:grant-type:device_code",device_code}` → 单次领取 `access_token/refresh_token/expires_in/refresh_expires_at/device/tenant`；等待时返回 `authorization_pending`。
- `POST /api/zakurabot/oauth/token {grant_type:"refresh_token",refresh_token}` → 轮换凭证。旧 refresh token 失效，已撤销或封禁的设备不能刷新。
- `POST /api/zakurabot/oauth/revoke {token}` → 撤销 access 或 refresh token 所属设备并关闭其 WS。

授权码、设备码和 refresh token 均只存哈希；凭证接口禁止缓存。设备码不进入浏览器 URL；授权码本身不能领取凭证。相同设备码只能消费一次，并发 refresh 只有一次成功。

设备 Token 默认有效 90 天，仅保存 SHA-256 哈希。签发设备会将设备 ID 加入所选绑定的白名单；设备还必须拥有该绑定的显式授权。绑定禁用、白名单移除、设备撤销/过期或租户封禁都会阻止访问。控制台可以撤销设备，已连接的 socket 会关闭。

## 管理 API

以下接口使用现有的**租户管理员会话** Bearer Token。设备 Token 仅能连接消息渠道，不能管理设备或调用其他 Zakura API。

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

## WS v1

App 会话管理使用设备 Bearer Token：`GET /api/zakurabot/sessions/:agentId` 返回 `bindingId/agentId/sessionId/status/title`；`POST` 同一路径携带 `{action:"start"|"stop"|"new"}`。start 在没有会话时创建；stop 等待当前运行取消；new 打断旧运行后建立新上下文。操作与 send 共用队列，并重新校验设备及绑定权限。历史消息继续保留在设备会话的 transcript 中。

连接 `{baseUrl}/api/zakurabot/ws`（HTTP→WS，HTTPS→WSS，保留部署路径前缀）。Token 只放在首个 `hello` JSON 文本帧中；不使用 URL、cookie 或客户端自报的租户/设备 ID。

```json
{"type":"hello","protocol":1,"token":"zbot_…","client":{"name":"zakura-bot","version":"1.0"}}
{"type":"send","agentId":"<ready 中的 Agent ID>","clientMessageId":"user-1","text":"你好"}
{"type":"interrupt","agentId":"<agent-id>"}
{"type":"ping"}
```

服务端先返回 `ready {protocol:1, agents[]}`，之后发送：

| 帧 | 用途 |
| --- | --- |
| `agents` | 权限或状态变化后的 Agent 列表 |
| `message {message}` | 用户回执；保留 `clientMessageId`，确认已存储的入站消息 |
| `chat_reply {agentId,messageId,createdAt,payload}` | 助手可见回复；支持 `text/kind/format/reply_to/attachments/actions/card` |
| `typing {agentId,active}` | 运行中及完成/取消后的输入状态 |
| `tool_activity {agentId,message}` | 工具名称、开始/结束/取消状态；不转发原始参数、结果或推理内容 |
| `error {message,agentId?,clientMessageId?,fatal?}` | 可关联到失败发送的错误 |
| `pong` | 心跳回应 |

每条用户消息限 4000 字符，JSON 帧限 1 MB；5 秒内未完成握手会关闭。无效凭据使用关闭码 `4401`，无授权绑定使用 `4403`，协议错误使用 `1008`。连接期间也会重新检查权限和有效期。

## 会话与回复

线程由服务端按 **tenant/device/binding/agent** 确定，设备不能指定别人的会话。相同 `clientMessageId` 的重试只补用户回执，不再次启动回合；重复 ID 携带不同正文会被拒绝。新消息和 `interrupt` 使用现有远程入口的取消机制。

Agent 必须通过 `chat_reply` 发出可见文字，默认引用入站消息 ID。post/channel/DM 变体也编码为 `chat_reply`，目标限定在当前设备会话。普通 assistant delta 和 reasoning 不进入 WS；静默回合沿用现有 runtime 的一次 `chat_reply` 兜底。当前服务端每次工具调用发送完整回复，未使用可选的 `message_delta/message_done`。

用户回执和 `chat_reply` 持久化后才计为送达；断线不取消已启动回合。重连或服务重启后会补发每个授权会话最近 100 条消息，ID 保持稳定，客户端可直接 upsert。typing/tool 活动只实时发送。

附件最多 8 个，工作区文件每个不超过 16 MB。服务端复用文件分享服务，将路径转换为有效 60 分钟的 HTTP(S) 下载链接；本地路径和文件字节不进入 WS。已有公开 URL、URL 按钮和结构化卡片会保留，非 HTTP(S) 或含用户名/密码的 URL 会被拒绝。分享链接到期后需要重新发送附件。

## 部署与验证

设置 `ZAKURA_PUBLIC_URL` 为 App 能访问的地址，公网使用 HTTPS。反向代理必须将 `/api/zakurabot/ws` 的 `Upgrade` / `Connection` 头转发给 API 服务；仓库的 `docker/nginx/proxy_locations.conf` 已包含专用规则。开发时可直接使用 API 的 `http://localhost:8787`（手机应使用能访问的主机地址）。

v1 的 socket 投递和会话工具句柄驻留在当前服务进程。使用单个 API/runtime 实例，或保证同一设备始终路由到同一实例；当前没有跨进程 socket 广播。

```sh
pnpm --filter @zakura/server exec tsx --test 'test/zakurabot-*.test.ts' test/remote-channel-tools.test.ts test/remote-agent-ingress.test.ts test/db-migrations.test.ts
pnpm typecheck
```

集成测试使用真实 WS、PGlite、RemoteAgentIngress 和会话存储，以受控 runtime 验证鉴权、隔离、幂等、打断、附件下载、重连补发及 Socket.IO 共存，无需外部模型或聊天平台凭据。
