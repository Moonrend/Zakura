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
| `zakura:cloud:events:` | 近期事件环（最多 500，SSE/listEvents 热读） |
| `zakura:cloud:meta:` | 会话元数据快照 |
| `zakura:cloud:run:` | Run 状态快照 |
| `zakura:cloud:evt:` | Pub/Sub 实时 fan-out |
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
- `listEvents` / SSE 续传优先读事件环，减少打 Postgres
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
- 多副本 API **必须** 共用同一 Redis，否则 SSE 跨实例收不到事件
- **启动时连不上 Redis 会直接退出**（除非 `REDIS_URL=off`）

## 2. 反向代理：SSE 必须禁用缓冲

Cloud Agent 事件流与 OpenAI Gateway 流式接口均为 **SSE**（`text/event-stream`）。任何缓冲都会表现为「模型本身很快，经 Zakura 后首字/流式很慢」。

### 硬性要求（与代理品牌无关）

对转发到 Zakura API 的路径（至少 `/api/`、`/v1/`，以及长连接 `/mcp`）：

1. **关闭响应缓冲**（不得攒包再刷）
2. **关闭或绕过响应缓存**
3. **读/写超时 ≥ 3600s**（对话与工具轮可能很长）
4. 保留上游头：`X-Accel-Buffering: no`（nginx）、以及 `Cache-Control: no-cache`
5. HTTP/1.1 或 HTTP/2 均可；不要对 SSE 做 body 压缩再缓冲
6. 若前面还有 CDN / Cloudflare：**对该路径关闭缓冲型代理或改用 Workers/直回源**；橙色云代理可能无视 `X-Accel-Buffering`

### nginx 示例

```nginx
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

location /v1/ {
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

handle /v1/* {
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
- 若必须橙云：关闭 Rocket Loader、确认无 Worker 二次缓冲；SSE 兼容性以实测为准

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
- [ ] 浏览器 DevTools → EventStream：`/api/agents/.../events` 持续收到 `cloud` 事件，而非结束时一次性到齐
- [ ] （多实例）两个 API 副本时，连在 A 上的 SSE 能收到 B 上产生的事件
- [ ] 代理 access log 中流式请求 duration 与对话时长一致（而不是固定几秒就结束）

## 5. 与「展示缺失」相关的路径说明

Web UI 只渲染 **已落库 / 已推送的 Cloud Agent 事件**。若会话经 OpenAI Gateway 产生：

- 服务端已写入 `reasoning_delta`、`tool_call_*` 时，控制台与本地 Web 表现一致
- 纯客户端工具或客户端自带 Zakura MCP 时，工具可能只在最终 `assistant_message.toolCalls` 中出现（设计如此）

排查时先看会话 `events` 是否含 `reasoning_delta` / `tool_call_start`，再查代理是否缓冲 SSE。
