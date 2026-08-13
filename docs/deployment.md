# 部署要求（生产 / 云端）

本文约定 **反向代理无关** 的生产要求：任意网关（nginx / Caddy / Traefik / Cloudflare / ALB）均可，只要满足下列行为。仓库里的 `docker/caddy`、`docker/nginx` 仅作参考实现。

## 1. 必备组件

| 组件 | 本地开发 | 生产 / 云端 |
|------|----------|-------------|
| 应用（API + Web） | `pnpm dev` | 容器或进程 |
| 数据库 | 默认 **PGlite**（可无外部库） | **Postgres + pgvector**（见 `docs/database.md`） |
| **Redis** | **默认强制**（自配 `REDIS_URL`） | **必开** |
| 反向代理 / TLS | 可选 | 按你的基础设施 |

### Redis（`REDIS_URL`，默认强制）

Redis **默认开启**，热路径对齐 Memoh `session_runtime` 思路：**活状态进 Redis，Postgres 做权威落库**。

| Key 前缀 | 内容 |
|----------|------|
| `zakura:cloud:seq:` | 会话事件序号 INCR |
| `zakura:cloud:pending:` | 待批落库的 delta |
| `zakura:cloud:events:` | 近期事件环（最多 500，实时续传/listEvents 热读） |
| `zakura:cloud:meta:` | 会话元数据快照 |
| `zakura:cloud:run:` | Run 状态快照 |
| `zakura:cloud:evt:` | Pub/Sub 会话事件 fan-out（按会话） |
| `zakura:platform:evt:` | Pub/Sub 平台事件 fan-out（按租户，`:all` 为 host 级广播） |
| `zakura:auth:key:` | API Key 鉴权短缓存（30s） |
| `zakura:tools:agent:` | Agent 工具列表短缓存（5s） |
| `zakura:gw:client:` | Gateway clientSessionKey → sessionId |

地址只从环境变量读取：

| `REDIS_URL` | 行为 |
|-------------|------|
| 未设置 | 默认 `redis://127.0.0.1:6379` |
| `redis://…` | 使用你配置的地址（强制连接；失败则进程启动失败） |
| `off` / `false` / `0` / `none` | 显式关闭（回退同步写库；仅本地/测试） |

开启后：

- 会话序号用 Redis `INCR` 分配
- 实时事件用 Redis Pub/Sub 跨实例推送
- `assistant_delta` / `reasoning_delta` **先推送、再异步批落库**，避免每 token 一次 DB 事务
- `listEvents` / Socket.IO `subscribe:session` 续传优先读事件环，减少打 Postgres
- 鉴权与工具列表走短 TTL 缓存

```env
# 必配（或依赖默认本机 6379）
REDIS_URL=redis://redis:6379
# 或带密码：redis://:password@redis:6379/0
# 本地无 Redis 时：REDIS_URL=off
```

Compose 示例：

```bash
COMPOSE_PROFILES=postgres docker compose up -d
# 默认 REDIS_URL=redis://redis:6379（compose 内 redis 服务默认启动）
# DATABASE_URL=postgresql://zakura:zakura@postgres:5432/zakura
```

要求：

- Redis 6+（推荐 7）
- 与 API 同低延迟网络（同 VPC / 同 compose 网络）
- 持久化可选（AOF/RDB）；丢短时 delta 可接受，终态事件仍同步写 Postgres
- 多副本 API **必须** 共用同一 Redis，否则会话事件与平台事件跨实例都收不到
- **启动时连不上 Redis 会直接退出**（除非 `REDIS_URL=off`）

## 1.1 平台探针与遥测

stdout 仍是进程生命周期和依赖状态（JSON 一行一条）。每条日志带 `user.id` / `tenant.id`（纯平台或未登录为 `"0"`；API Key 的 `user.id` 为 `"0"`，`tenant.id` 为对应租户）。租户事件正文（Agent 回合、工具调用）仍走产品存储，不把路径、URL、邮箱、密钥打进日志。Prometheus 标签仍然只有粗粒度 `route_class` / `dep` / `kind`，不要把 id 做成指标标签。

| 探针 | 含义 | 成功 | 失败 |
|------|------|------|------|
| `GET /livez`（`/api/health`） | 进程存活 | 200 | 进程挂了才失败 |
| `GET /readyz`（`/api/ready`） | 可接流量：boot 完成 + DB；Redis 开启时也必须通 | 200 | 503 |
| `GET /metrics` | Prometheus 文本。标签只有粗粒度 `route_class` / `dep` / `kind`，没有租户或路径 | 200 | — |

编排用 `/livez` 做 liveness、`/readyz` 做 readiness。日志级别：`ZAKURA_LOG_LEVEL=info`（默认）。

### OpenTelemetry 日志采集

前后端都走官方 OpenTelemetry Logs SDK，协议是 **OTLP/HTTP**。采集端用 [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)（或 Grafana Alloy / SigNoz / Grafana Cloud 等任意 OTLP 兼容端）。未配置 endpoint 时只写 stdout，不外发。

后端读官方 Logs 导出变量（和 Axiom 示例一样：完整 `/v1/logs` URL + Header 里的 dataset）：

```env
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://us-east-1.aws.edge.axiom.co/v1/logs
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>,X-Axiom-Dataset=<dataset>
```

未配置 `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` 时只写 stdout。启动日志里 `otel: "on"|"off"`。`GET /api/otel/config` 的 `collector` / `dest` 是导出器是否挂上、目标主机名（不含密钥）。

不要用 Axiom 的 `/v1/ingest/<dataset>`（那是事件 API，不是 OTLP）。Traces 示例里的 `/v1/traces` 对应日志就是 `/v1/logs`。

前端错误发到 `POST /api/otel/v1/logs`，服务端盖上可信的 `user.id` / `tenant.id` 后再按 OTLP 转发。浏览器不要直连采集端。

在 Loki / Grafana / SigNoz 里按属性过滤：

```
user.id = "<用户 id>"
tenant.id = "<租户 id>"
user.id = "0"          # 纯平台
```

用户用量（**仅 SaaS**）：同一套 Postgres/PGlite，启动时 migrate 会建 `user_usage_*` 两张小表，不用另开库、不用装扩展。OSS 不注册接口、不写数据。控制台：**设置 → 成员用量**。

## 2. 反向代理：实时连接与流式禁缓冲

前后端实时通信走 **Socket.IO**（`/api/socket.io`，WebSocket 优先、HTTP long-polling 兜底）；OpenAI Gateway 流式接口仍是 **SSE**（`text/event-stream`）。任何缓冲都会表现为「模型本身很快，经 Zakura 后首字/流式很慢」。

### 硬性要求（与代理品牌无关）

对转发到 Zakura API 的路径（至少 `/api/`、`/v1/`，以及长连接 `/mcp`）：

1. **关闭响应缓冲**（不得攒包再刷）——对 SSE 与 Socket.IO 的 polling 传输都必需
2. **关闭或绕过响应缓存**
3. **读/写超时 ≥ 3600s**（对话与工具轮可能很长）
4. 保留上游头：`X-Accel-Buffering: no`（nginx）、以及 `Cache-Control: no-cache`
5. HTTP/1.1 或 HTTP/2 均可；不要对 SSE 做 body 压缩再缓冲
6. **透传 WebSocket 升级头**（`Upgrade` / `Connection: upgrade`）到 `/api/socket.io`。不透传不会致命——Socket.IO 会自动降级到 polling 继续工作——但会白白损失 WebSocket 的低开销
7. 若前面还有 CDN / Cloudflare：**对该路径关闭缓冲型代理或改用 Workers/直回源**；橙色云代理可能无视 `X-Accel-Buffering`
8. 多副本 + polling 传输需要**会话粘滞**（sticky session），否则握手会在副本间跳转失败

### nginx 示例

> 注意：`/api/` 这类流式路径惯用的 `proxy_set_header Connection "";` 会**清掉 WebSocket 升级头**。
> 因此 `/api/socket.io` 必须单独用一个 location，并按 `$connection_upgrade` 透传。

```nginx
# 放在 http {} 块中
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# 实时连接：必须放在 /api/ 之前（nginx 前缀 location 取最长匹配）
location /api/socket.io {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_pass http://zakura_api;
}

location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_pass http://zakura_api;
}

location /v1 {
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_pass http://zakura_api;
}
```

### Caddy 示例

```caddy
handle /api/* {
    reverse_proxy zakura:8787 {
        flush_interval -1
        transport http {
            read_timeout 3600s
            write_timeout 3600s
        }
    }
}

handle /v1* {
    reverse_proxy zakura:8787 {
        flush_interval -1
        transport http {
            read_timeout 3600s
            write_timeout 3600s
        }
    }
}
```

> 注意：仅给「API 子域」配 `flush_interval -1`、而 Web 同源 `/api/*` 未配时，浏览器走同源 API 仍会缓冲。两条入口都要关缓冲。

### Traefik 示例

```yaml
http:
  middlewares:
    sse-flush:
      buffering:
        maxResponseBodyBytes: 0
  routers:
    api:
      rule: "PathPrefix(`/api`) || PathPrefix(`/v1`)"
      middlewares: [sse-flush]
      service: zakura
  services:
    zakura:
      loadBalancer:
        serversTransport: long
        servers:
          - url: "http://zakura:8787"
  serversTransports:
    long:
      forwardingTimeouts:
        dialTimeout: 30s
        responseHeaderTimeout: 3600s
        idleConnTimeout: 3600s
```

（Traefik 版本差异较大：核心是 **不要启用 buffering middleware 攒响应**，并拉长 timeout。）

### Cloudflare / 其它 CDN

- 对 `/api/*`、`/v1/*` 优先 **DNS only（灰云）** 或 Spectrum / Tunnel 直回源
- 若必须橙云：关闭 Rocket Loader、确认无 Worker 二次缓冲；橙云对 WebSocket 支持良好，SSE 兼容性以实测为准

## 3. 环境变量清单（生产）

```env
# 必选（生产）
DATABASE_URL=postgresql://zakura:zakura@postgres:5432/zakura
REDIS_URL=redis://redis:6379   # 自配；未设默认本机 6379；off 才关闭
ZAKURA_PUBLIC_URL=https://api.example.com
ZAKURA_WEB_URL=https://app.example.com
ZAKURA_SECRET=...          # 或依赖 data/secret.key
ZAKURA_EDITION=oss         # 或 saas

# 常用
HOST=0.0.0.0
PORT=8787
ZAKURA_DATA_DIR=/data
```

## 4. 验收清单

部署完成后建议用真实对话测一次：

- [ ] Web 聊天流式：**首字延迟**接近直连上游（Redis 默认开启，不应再被 Postgres 每 token 拖住）
- [ ] 进程启动日志含 `redis: redis://…`；连不上时应直接失败（除非 `REDIS_URL=off`）
- [ ] 同一会话刷新后仍能看到完整正文、工具卡片、思考记录
- [ ] 浏览器 DevTools → Network → WS：`/api/socket.io` 帧中 `cloud` 事件逐条到达，而非结束时一次性到齐
- [ ] DevTools → Network → WS：`/api/socket.io/?EIO=4&transport=websocket` 持续收帧
- [ ] （多实例）两个 API 副本时，连在 A 上的会话事件能收到 B 上产生的事件
- [ ] 代理 access log 中流式请求 duration 与对话时长一致（而不是固定几秒就结束）

## 5. 与「展示缺失」相关的路径说明

Web UI 只渲染 **已落库 / 已推送的 Cloud Agent 事件**。若会话经 OpenAI Gateway 产生：

- 服务端已写入 `reasoning_delta`、`tool_call_*` 时，控制台与本地 Web 表现一致
- 纯客户端工具或客户端自带 Zakura MCP 时，工具可能只在最终 `assistant_message.toolCalls` 中出现（设计如此）

排查时先看会话 `events` 是否含 `reasoning_delta` / `tool_call_start`，再查代理是否缓冲流式响应或阻断 WebSocket 升级。
