# Zakura

AI 环境编排 + **多 Agent MCP 网关**。为每个 Agent 提供隔离的文件系统、Shell、电脑能力，并把网页搜索 / 抓取 / 记忆 / 上游 MCP 聚合成统一入口，供 Cursor、Claude 等使用。

## 能力

- **多 Agent**：独立配置与 MCP 工具面
- **电脑环境**：文件系统 / Shell / 浏览器 / 桌面作为一套能力开关
- **自研 MCP 工具**：`fs_*` · `shell_exec` · `browser_*` · `computer_*`
- **全局设置 vs Agent 设置**
  - 全局：网页搜索 / 抓取 / **记忆提供商**、MCP 导入、Keys、策略
  - 单 Agent：概览、电脑环境、**记忆数据**（按 Agent 隔离）、MCP
- **记忆**：Built-in（关键词 + 可选向量 + 图谱）/ 传统笔记 / mem0 / OpenViking；MCP 工具 `search_memory` / `add_memory` / …
- **统一 MCP**：仅按 Agent 接入 `/mcp/agents/{slug}`
- **MCP 服务器**：商店 / 导入管理上游；HTTP / Stdio 容器；上游 OAuth 2.1 DCR；详情页工具试用
- **对外 OAuth 2.1**：CIMD（ChatGPT 等）+ DCR/PKCE（VS Code 等）
- **ChatGPT Apps SDK**：tools/list 含 title / annotations / securitySchemes / `_meta`；WWW-Authenticate 使用 `resource_metadata`

| 入口 | 工具 |
|------|------|
| Agent Key → `/mcp/agents/{slug}` | Agent 功能 + 已绑定的搜索/抓取/记忆/MCP 上游 |

| 功能 | Docker | 说明 |
|------|--------|------|
| 文件系统 | 否* | 主机或 Runner 工作区 |
| Shell | 是 | 常驻容器 |
| 浏览器 | 是 | Chromium + CDP + 显示 |
| 桌面 | 是 | noVNC + 键鼠工具 |

\*开启电脑环境后文件系统也走同一工作区/容器栈。

## 快速开始（本机）

```bash
# 需要 Node >= 20、pnpm；Shell/浏览器/桌面需要 Docker
pnpm setup          # install + drizzle generate/migrate（默认 PGlite）
pnpm dev            # API :8787 + Web :3000
```

打开 http://localhost:3000 → **注册管理员** → **租户引导**（创建 Agent 等）→ 复制 MCP 配置。

默认 **开源版（oss）**：单账户、单租户；无自助注册、成员邀请与超管后台。

SaaS 能力（多租户、注册、邀请、超管）在可剥离包 `@zakura/saas` 中，详见 [docs/edition.md](docs/edition.md)。

### Env（均可省略）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DATABASE_URL` | `pglite:<dataDir>/pglite` | 嵌入式 PG；云端改为 `postgresql://...` |
| `ZAKURA_SECRET` | 自动生成的 `data/secret.key` | 加密配置 / 签名 session |
| `ZAKURA_DATA_DIR` | 仓库 `./data` | 数据与 Agent 工作区根目录 |
| `ZAKURA_EDITION` | `oss` | `saas` 启用多租户 / 自助注册 / 成员邀请（需 `@zakura/saas`） |

分发纯开源树：`pnpm strip:saas -- --out ../Zakura-oss`。

详见 [docs/database.md](docs/database.md)、[docs/edition.md](docs/edition.md)。

## Docker 一键

```bash
docker compose up -d --build
# Web http://localhost:3000  API http://localhost:8787  Agent MCP /mcp/agents/{slug}
```

可选：

```bash
docker compose --profile components up -d   # SearXNG / OpenViking 示例
docker compose --profile postgres up -d     # 外部 Postgres，再改 DATABASE_URL
```

## 发布镜像（GHCR + Docker Hub）

仓库需配置：

| 类型 | 名称 | 说明 |
|------|------|------|
| Actions Variable | `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| Actions Secret | `DOCKERHUB_TOKEN` | Docker Hub Access Token |

### Dev（每次提交 → `*-dev` 镜像）

推送到 `main` / `master` 触发 [Dev Containers](.github/workflows/dev-containers.yml)，推送到**独立镜像名**（仅 amd64）：

| 镜像 | 标签 |
|------|------|
| `zakura-dev` | `latest`、`sha-<7位>` |
| `zakura-runner-dev` | `latest`、`sha-<7位>` |
| `zakura-workspace-dev` | `latest`、`sha-<7位>`、`debian` |

```bash
docker pull sunwuyuan/zakura-dev:latest
docker pull sunwuyuan/zakura-dev:sha-abc1234
docker pull ghcr.io/moonrend/zakura-dev:latest
```

### Release（正式版 → 原镜像名）

推送 `v*` tag 触发 [Release Containers](.github/workflows/release-containers.yml)：多架构 + GitHub Release，按版本打标签并更新 `latest`。

```bash
git tag v0.1.0
git push origin v0.1.0
```

```bash
docker pull sunwuyuan/zakura:0.1.0
docker pull sunwuyuan/zakura:latest
docker pull sunwuyuan/zakura-runner:latest
docker pull sunwuyuan/zakura-workspace:debian
```

| 镜像 | 说明 |
|------|------|
| `sunwuyuan/zakura` · `ghcr.io/moonrend/zakura` | 主应用正式版 |
| `sunwuyuan/zakura-runner` · `ghcr.io/moonrend/zakura-runner` | Runner 正式版 |
| `sunwuyuan/zakura-workspace` · `ghcr.io/moonrend/zakura-workspace` | Workspace 正式版 |
| `sunwuyuan/zakura-*-dev` · `ghcr.io/moonrend/zakura-*-dev` | 开发调试版（main 最新） |

本地开发仍可用 `docker compose` / `pnpm workspace:image`（默认标签已对齐 Docker Hub：`sunwuyuan/zakura-dev`、`sunwuyuan/zakura-runner-dev`、`sunwuyuan/zakura-workspace-dev`）。GHCR 首次公开发布后，若需匿名拉取，请在 GitHub Packages 将对应包可见性设为 **Public**。

## 连接 MCP（Cursor 等）

**仅支持 Agent 接入** — 创建 Agent 时会生成绑定 Key：

```json
{
  "mcpServers": {
    "zakura-research": {
      "url": "http://127.0.0.1:8787/mcp/agents/research",
      "headers": {
        "Authorization": "Bearer zak_xxx"
      }
    }
  }
}
```

该连接下工具示例：`fs_read`、`web_search`、`web_fetch`、`shell_exec`、`browser_action`（按开启的功能与绑定的上游自动提供）。

上游 MCP 在控制台「MCP 服务器」中安装/导入，再于 Agent → MCP 页绑定后才会出现在该 Endpoint。
## 仓库结构

```
apps/server     # Hono API + MCP Gateway + Agent 工作区 + Providers
apps/web        # Next.js 控制台
packages/core   # Provider / Runtime 契约
packages/shared
packages/saas   # SaaS 扩展（可 pnpm strip:saas 剥离）
```

## 扩展 Provider

1. 在 `apps/server/src/providers/` 实现 `ProviderPlugin`
2. 在 `providers/index.ts` 注册
3. 启动时自动同步到 `ProviderCatalog`

Agent 侧扩展：`agents.configJson` 预留任意 JSON；后续可挂 skills、模型偏好、渠道等而不改表结构。

## 常用操作

| 操作 | 路径 / 说明 |
|------|-------------|
| 新建 Agent | 控制台 → Agents，或 `POST /api/agents` |
| 启动工作区 | Agent 详情 → 启动，或 `POST /api/agents/:id/start` |
| 绑定搜索/记忆 | Agent 详情 → 绑定组件 |
| 一键导入 MCP | 控制台 → 导入 MCP，或 `POST /api/mcp/import` |
| 切 Postgres | [docs/database.md](docs/database.md) |

## License

MIT
