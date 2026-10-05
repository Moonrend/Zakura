# 部署（分服务镜像）

本目录描述 **新栈** 的部署方式：Go 后端 `zakura-server` 与 Next.js 前端 `zakura-web`
拆成两个镜像 / 两个容器，取代早期「单一大镜像同时跑 Fastify:8787 与 Next:3001」的形态。

- `docker/server/Dockerfile` — `build context = 仓库根`；产出 `zakura-server`、`zakura-db`、
  `zakura-stdio-bridge` 三个二进制，并把 agent 各平台二进制打进 `/app/go/agent/dist`。
- `docker/web/Dockerfile` — `build context = 仓库根`；基于 Next standalone 输出。
- `legacy-fullstack-compose.yml` — 重写前根 `docker-compose.yml` 的历史副本，供回滚参考。

## 快速开始（默认 SQLite）

```bash
# 在仓库根
ZAKURA_SECRET=$(openssl rand -hex 32) docker compose up -d
```

- server: `http://localhost:8787`（`/livez`、`/readyz`、`/api/health`）
- web: `http://localhost:3001`
- 数据持久化在命名卷 `zakura-data` 的 `/data/zakura.db`。

`ZAKURA_SECRET` 必须至少 32 字节，未提供时 compose 内有一个占位默认值，**仅限本地**，
部署到真实环境前必须覆盖。

## 使用 Postgres

compose 内置一个带 pgvector 的 Postgres（默认不启动，`postgres` profile）：

```bash
ZAKURA_SECRET=$(openssl rand -hex 32) \
DATABASE_URL=postgresql://zakura:zakura@postgres:5432/zakura \
  docker compose --profile postgres up -d
```

也可以指向外部 Postgres：把 `DATABASE_URL` 换成你的连接串即可，无需启用 profile。
生产使用外部库时，`server` 的 `depends_on.postgres` 是 `required: false`，不会强制拉起本地库。

## 迁移（手动）

Go 后端把迁移 **内嵌在二进制里**，由 `AUTO_MIGRATE` 控制：

- `AUTO_MIGRATE=true`（默认）：进程启动时按版本顺序、原子提交地应用迁移。
- `AUTO_MIGRATE=false`：跳过迁移，仅提供已建好的库。

推荐流程：

1. **首次 / 升级**：让 **一个** 实例以 `AUTO_MIGRATE=true` 跑一次，应用迁移后再放开流量。
   在 compose 下可用一次性任务：

   ```bash
   docker compose run --rm -e AUTO_MIGRATE=true server
   ```

2. **日常副本**：设 `AUTO_MIGRATE=false` 启动，避免多副本同时迁移。

迁移 SQL 版本化在 `go/server/internal/platform/migrations/sql/`。外部 Postgres 若坚持用
`psql`/atlas 管理 schema，请以这些版本文件为准核对；SQLite 场景无法用 `psql`，只能用
上面的内嵌迁移路径。

## 健康检查

| 探针 | 路径 | 含义 |
|------|------|------|
| liveness | `GET /livez` | 进程存活 |
| readiness | `GET /readyz` | boot 完成 + DB 可用 |
| health | `GET /api/health` | DB ping + OAuth 签名密钥可用 |

compose 用 `/livez` 做 healthcheck；编排系统建议 `/livez` 做 liveness、`/readyz` 做 readiness。

## 升级步骤

1. 备份数据：
   ```bash
   docker compose exec server zakura-db backup -database "$DATABASE_URL" -out /data/zakura-$(date -u +%Y%m%dT%H%M%SZ).db
   docker compose exec server zakura-db verify -file /data/zakura-<timestamp>.db
   ```
2. 拉取新镜像：`docker compose pull server web`。
3. 视需要先跑一次性迁移（见上），再 `docker compose up -d server web`。
4. 确认 `curl -fsS http://localhost:8787/livez` 与 `http://localhost:8787/readyz` 返回 200。

## 兼容性说明

- 容器名：`zakura-server`、`zakura-web`；网络名 `zakura`（`driver: bridge`）。旧的单容器名为
  `zakura`，若从旧栈切换，请先停掉旧 `zakura` 容器，避免端口/网络别名冲突。
- 端口：server `8787`，web `3001`，与旧栈一致；反向代理（Caddy/nginx）的 upstream 由单一
  `zakura:8787` 改为按服务名 `server:8787` / `web:3001`。
- web 通过 Next 构建时的 `ZAKURA_API_URL`（默认 `http://server:8787`）把 `/api/*` 反代到
  server；换环境需用同一 build arg 重新构建镜像，或在反代层统一路由。
- 生产 `/opt/zakura` 的外部 Postgres、caddy 反代与工作区/runner 镜像用法不变，只是把
  单容器拆成两个容器。
