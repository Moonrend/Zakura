# Zakura 远程 Runner Agent 与 Workspace 迁移 — 技术计划书

> 版本：v0.2 · 2026-07-15  
> 状态：选型已定稿，可进入 Phase 0  
> 范围：Runner Agent 节点（容器化部署）、Worker 本地 FS、跨节点 Workspace 迁移

---

## 1. 背景与目标

### 1.1 现状

Zakura 当前为**单节点 Docker 直连**架构：

| 模块 | 现状 | 路径 |
|------|------|------|
| 容器运行时 | `DockerRuntime` 直连本机 dockerode | `apps/server/src/runtime/docker.ts` |
| Workspace FS | Server 本地 `data/agents/<id>/workspace` | `apps/server/src/services/agent-fs.ts` |
| 容器挂载 | bind mount 同上路径 → `/workspace` | `apps/server/src/services/agent-workspace.ts` |
| MCP `fs_*` | 直接读写 Server 主机路径 | `apps/server/src/services/agent-tools.ts` |
| Web FS API | 同上，Memoh 风格 REST | `apps/server/src/api/agent-fs-routes.ts` |

该模型在「控制面与容器同机」时工作良好，但无法将 Agent 工作区调度到其他设备。

### 1.1.1 「Runner 现在跑在哪？」— 重要澄清

**当前项目里没有独立的 Runner Agent 进程。** 所谓「跑容器的能力」全部嵌在 **Zakura Server** 里：

| 部署方式 | Server 进程 | Docker 调用方 | Workspace 数据 |
|----------|------------|--------------|----------------|
| `pnpm dev`（本机开发） | 主机 Node.js | 主机 `docker.sock` | `./data/agents/<id>/workspace` |
| `docker compose up` | `zakura` 容器内 Node.js | 容器内 dockerode → **挂载的** `/var/run/docker.sock` | volume `zakura-data:/data` |

```
今天 docker compose 的实际拓扑：

  ┌─────────────────────────────────────────────┐
  │  zakura 容器（Server + Web）                 │
  │  - apps/server → DockerRuntime (dockerode)   │
  │  - 挂载 docker.sock ────────────────────────┼──► 宿主机 Docker Engine
  │  - 挂载 zakura-data:/data                   │         │
  └─────────────────────────────────────────────┘         │
                                                            ▼
                                              ┌─────────────────────────┐
                                              │ zakura-ws-* 容器        │
                                              │ （Agent workspace 沙箱）  │
                                              │ bind mount 宿主机路径     │
                                              └─────────────────────────┘
```

也就是说：**Server 自己就是「隐式 Runner」**——它既做控制面，又通过 docker.sock 在宿主机上创建 sibling 容器。  
`zakura/workspace:debian` 是 **Agent 工作区沙箱**，不是 Runner Agent。

本计划要拆出独立的 **`apps/runner`**，并且 **Runner Agent 本身也跑在容器里**（见 §4.6），Server 只保留控制面；本机则通过 **隐式 local Runner** 兼容现有行为。

### 1.2 目标

1. **Runner Agent 模式**：每台运行容器的设备部署轻量 Agent，Server 通过 Agent API 管理生命周期与 FS。
2. **Worker 本地 FS 为唯一真相源**：每个 Agent 的 workspace 主副本位于其绑定的 Runner 本地磁盘。
3. **Workspace 迁移**：支持将 Agent 从 Runner A 迁移到 Runner B（打包 → 传输 → 解压 → 切换绑定）。
4. **向后兼容**：未注册远程 Runner 时，本机仍可作为默认 `local` Runner 运行，现有部署无需立即改造。

### 1.3 非目标（本阶段不做）

- 多 Runner 间实时双向 FS 同步
- Git 作为主 FS 层
- NFS 共享盘（可作为后续增强）
- Docker Swarm / Kubernetes 编排
- Worker 间 P2P 直传（首版经 Server 或对象存储中转）

---

## 2. 架构总览

```
                         ┌─────────────────────────────────────┐
                         │           Zakura Server            │
                         │  ┌─────────┐  ┌──────────────────┐  │
                         │  │ API/Web │  │ Migration Service │  │
                         │  └────┬────┘  └────────┬─────────┘  │
                         │       │                │             │
                         │  ┌────▼────────────────▼─────────┐  │
                         │  │     WorkspaceFsRouter          │  │
                         │  │  local / remote → AgentClient   │  │
                         │  └────┬────────────────┬─────────┘  │
                         │       │                │             │
                         │  ┌────▼────┐    ┌──────▼──────┐     │
                         │  │ Local   │    │ RemoteAgent │     │
                         │  │ Runtime │    │ Runtime     │     │
                         │  └────┬────┘    └──────┬──────┘     │
                         └───────┼─────────────────┼─────────────┘
                                 │                 │ HTTPS+mTLS
                    docker.sock  │                 │
                         ┌───────▼──────┐   ┌──────▼──────────┐
                         │ Local Runner │   │  Remote Runner   │
                         │ (同机默认)    │   │  Agent 进程       │
                         │              │   │                  │
                         │ /data/.../   │   │ /data/zakura/   │
                         │  workspace   │   │  agents/<id>/ws  │
                         │      ▲       │   │       ▲          │
                         │      │ mount │   │       │ mount    │
                         │  workspace   │   │  workspace ctr   │
                         │  container   │   │                  │
                         └──────────────┘   └──────────────────┘

迁移路径（Runner A → Runner B）：
  A: export(tar.zst) → Blob Store → B: import → Server 更新 runtimeNodeId
```

### 2.1 设计原则

| 原则 | 说明 |
|------|------|
| 单一真相源 | 任意时刻，Agent workspace 只有一个活跃主副本 |
| FS 与 Exec 同源 | `fs_*` 与 `shell_exec` 必须经同一 Runner，保证看到相同文件 |
| 控制面集中 | Server 持有绑定关系、迁移状态、审计日志；Runner 不对外暴露 Docker Socket |
| 渐进演进 | Phase 1 本机 Agent 与远程 Agent 共用接口；Phase 2 完善迁移与 UI |
| 失败可恢复 | 迁移任一步失败可回滚或重试，不产生双写 |

---

## 3. 技术选型（已定稿）

| 项 | 决策 |
|----|------|
| Agent 实现语言 | **TypeScript**（`apps/runner`，复用 `@zakura/core`） |
| 通信协议 | **REST + JSON**（MVP）；迁移进度 SSE |
| 鉴权 | **预共享 Token**（`rnr_xxx`）；不单独考虑公网场景，但 Runner **回传网卡信息**供 Server/UI 展示 |
| 迁移包存储 | **Server 本地磁盘**（`data/migrations/`） |
| 压缩格式 | 迁移内部 **tar.zst**；用户下载仍可 tar.gz |
| 默认 Runner | **Server 本机 = 隐式 local Runner**（`runtime_node_id = null`） |
| Runner 部署形态 | **容器化**（privileged + docker.sock + 数据卷 + 能力目录挂载，见 §4.6） |
| 迁移排除项 | **默认常见语言包目录** + **允许用户自定义** |
| Source 清理 | 迁移成功后 **Source 端保留**，由用户 **手动删除** |

### 3.1 Runner Agent 实现

- MVP：`apps/runner/` TypeScript 包，与 Server 同 monorepo。
- 镜像：`zakura/runner:latest`（见 `docker/runner/Dockerfile`）。
- 长期可选：编译为独立二进制，非 MVP 范围。

### 3.2 Server ↔ Agent 通信

- MVP 全 REST，字段与现有 `agent-fs-routes` 对齐。
- 大文件：分块 HTTP；迁移进度：Server SSE。
- gRPC 流式留 Phase 4 优化。

### 3.3 鉴权

- 注册时 Server 签发 `rnr_xxx`，只展示一次；库存 `token_hash`。
- Agent 每次请求：`Authorization: Bearer rnr_xxx`。
- mTLS 留 Phase 4，不作为 MVP 阻塞项。

### 3.4 迁移包存储

- MVP：`ZAKURA_MIGRATION_DIR`（默认 `data/migrations/`）。
- 接口预留 `storageBackend: local | s3`，后续可扩展。

### 3.5 默认迁移排除项

内置默认（可在发起迁移时追加/覆盖）：

```text
.cache/
**/.cache/
**/node_modules/
**/.npm/
**/.pnpm-store/
**/.yarn/
**/.venv/
**/venv/
**/__pycache__/
**/.pytest_cache/
**/.mypy_cache/
**/.tox/
**/target/          # Rust/Cargo build
**/.gradle/
**/.m2/
**/vendor/          # PHP composer（若用户未用 vendor 作源码可手动取消排除）
**/.git/objects/
**/.git/lfs/
**/.next/
**/.nuxt/
**/.turbo/
**/dist/
**/build/
**/.chrome-user-data/
**/.config/chromium/
```

用户可通过迁移 API / UI 传入 `excludePatterns`、`includePatterns`（白名单优先于黑名单）。

### 3.6 Source 端清理策略

- 迁移 **completed** 后，Source Runner 上 workspace **不自动删除**。
- Server 记录 `sourceRetained: true`；UI 显示「原 Runner 仍保留副本，可手动清理」。
- 提供 API：`DELETE /api/runtime-nodes/:nodeId/agents/:agentId/workspace-residual`（用户确认后删 Source 残留）。
- 可选：Runner 详情页展示「残留 workspace 占用」列表。

---

## 4. 核心模块设计

### 4.1 包结构（建议）

```
Zakura/
├── apps/
│   ├── server/          # 控制面（现有）
│   ├── web/             # 管理 UI（现有）
│   └── runner/          # 新增：Runner Agent 守护进程
│       ├── src/
│       │   ├── index.ts           # HTTP server 入口
│       │   ├── auth.ts            # Token 校验
│       │   ├── docker.ts          # 本地 Docker 操作（复用 dockerode）
│       │   ├── workspace-fs.ts    # 本地 FS 实现（从 server agent-fs 抽取）
│       │   ├── workspace-lifecycle.ts
│       │   ├── migration-export.ts
│       │   ├── migration-import.ts
│       │   └── register.ts        # 向 Server 注册 + 心跳
│       └── package.json
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── runtime.ts         # 现有 ContainerRuntime
│   │       ├── workspace-fs.ts    # 新增：WorkspaceFs 接口
│   │       └── runner-client.ts   # 新增：Server 调 Agent 的客户端
│   └── shared/
│       └── src/
│           └── runner.ts          # 新增：Runner/Migration 共享类型
```

### 4.2 WorkspaceFs 抽象

将 FS 从「Server 本地路径」提升为可路由接口：

```typescript
/** packages/core/src/workspace-fs.ts */
export interface WorkspaceFs {
  stat(path: string): Promise<FsEntry>;
  list(path: string, opts?: ListOpts): Promise<ListResult>;
  read(path: string, opts?: ReadOpts): Promise<ReadResult>;
  write(path: string, content: string, opts?: { expectedRevision?: string }): Promise<WriteResult>;
  edit(path: string, oldText: string, newText: string): Promise<WriteResult>;
  mkdir(path: string): Promise<{ path: string }>;
  delete(path: string, recursive?: boolean): Promise<{ path: string }>;
  move(from: string, to: string): Promise<{ path: string }>;
  /** 可选：流式读写供迁移/上传 */
  readRaw?(path: string): AsyncIterable<Uint8Array>;
}

export interface WorkspaceFsProvider {
  forAgent(agentId: string): Promise<WorkspaceFs>;
}
```

实现：

| 实现类 | 场景 |
|--------|------|
| `LocalWorkspaceFs` | local Runner：直接调用现有 `agent-fs.ts` 逻辑 |
| `RemoteWorkspaceFs` | 远程 Runner：HTTP 调 Agent `/v1/agents/:id/fs/*` |

**改造点**：

- `agent-tools.ts`：`fs_*` 改调 `WorkspaceFsProvider`
- `agent-fs-routes.ts`：同上
- `AgentWorkspaceService.ensureLocal()` → `resolveWorkspaceRoot()` 仅 local Runner 使用

### 4.3 ContainerRuntime 扩展

```typescript
/** 现有接口保持不变，新增实现 */
class RemoteAgentRuntime implements ContainerRuntime {
  readonly kind = "runner-agent";
  constructor(private client: RunnerClient, private nodeId: string) {}
  // createAndStart → POST /v1/workspaces
  // exec → POST /v1/workspaces/:id/exec
  // ...
}

/** Server 侧工厂 */
class RuntimeRouter {
  resolve(nodeId: string | null): ContainerRuntime {
    if (!nodeId || nodeId === LOCAL_NODE_ID) return this.local;
    return this.remoteClients.get(nodeId)!;
  }
}
```

### 4.4 Runner Agent 职责边界

Agent **提供**：

| 能力 | API 前缀 |
|------|----------|
| 健康检查 / 版本 / 能力上报 | `GET /v1/ping` |
| Workspace 容器 CRUD | `/v1/workspaces` |
| 容器 exec | `POST /v1/workspaces/:id/exec` |
| FS 操作（与 Server agent-fs-routes 对齐） | `/v1/agents/:agentId/fs/*` |
| 迁移 export | `POST /v1/agents/:agentId/migration/export` |
| 迁移 import | `POST /v1/agents/:agentId/migration/import` |
| 磁盘用量 | `GET /v1/agents/:agentId/workspace/usage` |

Agent **禁止**：

- 暴露原始 Docker Socket 给 Server
- 自行决定 Agent 绑定关系（由 Server 授权每次操作）

### 4.5 Migration Service（Server 侧）

独立服务协调状态机，不阻塞 HTTP 主线程：

```
MigrationJob 状态机：

  pending → exporting → uploaded → importing → verifying → completed
                ↓            ↓           ↓           ↓
              failed       failed      failed      failed
                ↓
            rolled_back (可选：恢复到 source Runner)
```

### 4.6 Runner Agent 容器化部署（已定稿）

Runner Agent **以容器方式运行**，通过挂载宿主机 Docker Socket 创建 **sibling workspace 容器**（与 today `zakura` 容器模式相同，但职责分离）。

#### 4.6.1 目标拓扑

```
宿主机 Docker Engine
├── zakura          ← 控制面（API/Web/DB），Phase 2+ 不再挂 docker.sock
├── zakura-runner   ← Runner Agent 容器（privileged + docker.sock）
│   └── 监听 :7443，管理本机 workspace 容器
└── zakura-ws-*     ← Agent workspace 沙箱（由 Runner 创建）
```

**local Runner（兼容模式）**：Server 进程内嵌 `LocalRunnerAdapter`，行为等同 today，**不强制**再跑 `zakura-runner` 容器；用户可渐进切换。

**远程 / 专用 Runner**：必须跑 `zakura-runner` 容器（或等价 compose 服务）。

#### 4.6.2 `docker-compose.yml` 示例（远程 Runner 节点）

```yaml
services:
  zakura-runner:
    image: zakura/runner:latest
    container_name: zakura-runner
    restart: unless-stopped
    privileged: true                    # workspace 内 display/设备节点需要
    ports:
      - "7443:7443"                     # Server → Agent API
    environment:
      ZAKURA_RUNNER_SERVER_URL: http://192.168.1.10:8787
      ZAKURA_RUNNER_TOKEN: rnr_xxxx    # Server 创建节点时生成
      ZAKURA_RUNNER_STORAGE_ROOT: /var/lib/zakura
      ZAKURA_RUNNER_PORT: "7443"
      ZAKURA_RUNNER_PUBLIC_HOST: 192.168.1.20   # CDP/noVNC 对外可达 IP/域名
      DOCKER_HOST: unix:///var/run/docker.sock
    volumes:
      # --- 必需 ---
      - /var/run/docker.sock:/var/run/docker.sock
      - zakura-runner-data:/var/lib/zakura
      # --- 推荐：X11 / 显示栈 ---
      - /tmp/.X11-unix:/tmp/.X11-unix
      # --- 推荐：网卡信息（只读，供上报） ---
      - /sys/class/net:/host/sys/class/net:ro
      - /proc/net/dev:/host/proc/net/dev:ro
    networks:
      - zakura-runner
    # 可选：Linux 上若 CDP 端口发布有问题，可改用 host 网络
    # network_mode: host

volumes:
  zakura-runner-data:

networks:
  zakura-runner:
    name: zakura-runner
```

#### 4.6.3 为何 `privileged: true`

| 需求 | 说明 |
|------|------|
| Workspace display 栈 | Xvnc、Chrome、输入设备在 sibling 容器内；部分内核 capability 依赖 privileged 或细粒度 `cap_add` |
| `/dev/shm` 大小 | 浏览器容器常需 `--shm-size`；Runner 创建容器时指定 |
| 与 today 一致 | 当前 `zakura` 容器创建 workspace 时已假设宿主机 Docker 能力完整 |

MVP 先 **整体 privileged**；Phase 4 可拆为最小 `cap_add` + `security_opt` 清单。

#### 4.6.4 挂载清单

| 挂载 | 模式 | 用途 |
|------|------|------|
| `/var/run/docker.sock` | rw | 创建/管理 workspace 容器（**不暴露给 Server**） |
| `zakura-runner-data` → `/var/lib/zakura` | rw | workspace 主副本、`agents/<id>/workspace` |
| `/tmp/.X11-unix` | rw | 可选 X11 共享 |
| `/sys/class/net` | ro | 读取宿主机网卡名、MAC、operstate |
| `/proc/net/dev` | ro | 读取流量统计 |

#### 4.6.5 网卡信息上报

Runner 在 **register** 与 **heartbeat** 时上报 `hostInfo`（Server 写入 `runtime_nodes.host_info_json`）：

```typescript
interface RunnerHostInfo {
  hostname: string;
  platform: string;       // linux / darwin
  arch: string;           // amd64 / arm64
  primaryIp?: string;     // Runner 自选：用于 ZAKURA_RUNNER_PUBLIC_HOST 或探测
  interfaces: Array<{
    name: string;
    mac?: string;
    ipv4: string[];
    ipv6: string[];
    internal: boolean;    // docker0 / veth / lo
    operstate?: string;   // up / down
  }>;
  publicUrl?: string;     // ZAKURA_RUNNER_PUBLIC_URL 解析结果
  dockerVersion?: string;
  storageRoot: string;
  disk?: { totalBytes: number; freeBytes: number };
}
```

采集逻辑：

1. `os.networkInterfaces()` — Runner 容器内可见接口（含 bridge）。
2. 读取 `/host/sys/class/net/*` — 宿主机网卡名与 MAC。
3. 合并去重，标记 `internal: true`（`lo`、`docker*`、`veth*`、`br-*`）。
4. `primaryIp`：优先 env `ZAKURA_RUNNER_PUBLIC_HOST`，否则取第一个非 internal 的 IPv4。

Server UI 在 Runner 详情页展示网卡列表，供用户配置 CDP/noVNC 地址时参考。

#### 4.6.6 Server 容器改造（Phase 2 后）

| 阶段 | `zakura` 容器 |
|------|----------------|
| Phase 1 | 仍挂 `docker.sock`（local Runner 内嵌） |
| Phase 2+ | 默认 **移除** `docker.sock`；本机若要跑 workspace，另起 `zakura-runner` 服务 |
| 过渡 | env `ZAKURA_LEGACY_LOCAL_DOCKER=1` 保留旧行为 |

#### 4.6.7 镜像构建

```
docker/
├── Dockerfile              # zakura server（现有）
└── runner/
    └── Dockerfile          # zakura/runner（新增，基于 node:22-bookworm-slim + docker CLI 可选）
```

Runner 镜像内需：**Node 22**、**zstd**（迁移压缩）、**tar**、**curl**；docker CLI 可选（调试用，实际用 dockerode 连 socket）。

---

## 5. 数据模型

### 5.1 新表：`runtime_nodes`

```sql
CREATE TABLE runtime_nodes (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'runner',  -- 'local' | 'runner'
  status        TEXT NOT NULL DEFAULT 'offline', -- online | offline | draining
  endpoint      TEXT,                             -- https://runner-a:7443
  capabilities_json TEXT NOT NULL DEFAULT '{}',  -- { docker, display, arch, os }
  host_info_json    TEXT NOT NULL DEFAULT '{}',  -- 网卡、磁盘、docker 版本（heartbeat 刷新）
  storage_root  TEXT NOT NULL,                    -- /var/lib/zakura
  agent_version TEXT,
  last_seen_at  TIMESTAMPTZ,
  token_hash    TEXT,                             -- 注册 token 哈希（local 节点为空）
  labels_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
```

### 5.2 新表：`workspace_migrations`

```sql
CREATE TABLE workspace_migrations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_node_id  TEXT NOT NULL REFERENCES runtime_nodes(id),
  target_node_id  TEXT NOT NULL REFERENCES runtime_nodes(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | exporting | transferring | importing | verifying | completed | failed | cancelled
  phase           TEXT,
  progress_pct    INTEGER NOT NULL DEFAULT 0,
  message         TEXT,
  manifest_json   TEXT,          -- 文件清单 + sha256
  archive_path    TEXT,          -- local: data/migrations/xxx.tar.zst
  archive_size    BIGINT,
  archive_sha256  TEXT,
  exclude_patterns_json TEXT NOT NULL DEFAULT '[]',
  source_retained   BOOLEAN NOT NULL DEFAULT false,  -- completed 后 Source 是否仍保留副本
  error           TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspace_migrations_agent ON workspace_migrations(agent_id);
CREATE INDEX workspace_migrations_status ON workspace_migrations(status);
```

### 5.3 `agents` 表扩展

```sql
ALTER TABLE agents ADD COLUMN runtime_node_id TEXT REFERENCES runtime_nodes(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN workspace_status TEXT NOT NULL DEFAULT 'ready';
-- ready | locked | migrating
ALTER TABLE agents ADD COLUMN workspace_revision TEXT;  -- 最近成功迁移/快照的 manifest hash
ALTER TABLE agents ADD COLUMN last_migration_id TEXT REFERENCES workspace_migrations(id) ON DELETE SET NULL;
```

### 5.4 `managed_containers` 表扩展

```sql
ALTER TABLE managed_containers ADD COLUMN runtime_node_id TEXT REFERENCES runtime_nodes(id) ON DELETE SET NULL;
```

---

## 6. API 设计

### 6.1 Server — Runner 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/runtime-nodes` | 列出节点 |
| POST | `/api/runtime-nodes` | 创建节点（生成注册 token，仅展示一次） |
| GET | `/api/runtime-nodes/:id` | 详情 + 在线状态 |
| PATCH | `/api/runtime-nodes/:id` | 改名、draining |
| DELETE | `/api/runtime-nodes/:id` | 删除（需无绑定 Agent） |
| POST | `/api/runtime-nodes/register` | Agent 自注册（带 token + hostInfo） |
| POST | `/api/runtime-nodes/:id/heartbeat` | Agent 心跳（刷新 hostInfo） |
| DELETE | `/api/runtime-nodes/:nodeId/agents/:agentId/workspace-residual` | 用户确认后删除 Source 残留 workspace |

### 6.2 Server — Agent 迁移

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:id/migrations` | 发起迁移 `{ targetNodeId, excludePatterns? }` |
| GET | `/api/agents/:id/migrations` | 历史列表 |
| GET | `/api/migrations/:jobId` | 任务详情 + 进度 |
| GET | `/api/migrations/:jobId/events` | SSE 进度流 |
| POST | `/api/migrations/:jobId/cancel` | 取消（仅 early phase） |
| POST | `/api/agents/:id/migrations/preview` | 预估大小、耗时、冲突检查 |

### 6.3 Runner Agent — 内部 API（Server 调用）

#### 6.3.1 FS（与现有 `agent-fs-routes` 字段对齐）

```
GET    /v1/agents/:agentId/fs
GET    /v1/agents/:agentId/fs/list
GET    /v1/agents/:agentId/fs/read
POST   /v1/agents/:agentId/fs/write
POST   /v1/agents/:agentId/fs/edit
POST   /v1/agents/:agentId/fs/mkdir
POST   /v1/agents/:agentId/fs/delete
POST   /v1/agents/:agentId/fs/rename
POST   /v1/agents/:agentId/fs/upload
GET    /v1/agents/:agentId/fs/download
POST   /v1/agents/:agentId/fs/archive
POST   /v1/agents/:agentId/fs/extract
```

#### 6.3.2 Workspace 生命周期

```
POST   /v1/workspaces                    # 创建并启动 { agentId, spec }
GET    /v1/workspaces/:agentId           # 状态
POST   /v1/workspaces/:agentId/stop
DELETE /v1/workspaces/:agentId
POST   /v1/workspaces/:agentId/exec      # { command, workingDir, env }
GET    /v1/workspaces/:agentId/endpoints # CDP / noVNC URLs
```

#### 6.3.3 迁移

```
POST   /v1/agents/:agentId/migration/export
       → 流式响应 tar.zst，或写入 Agent 本地 staging 后通知 Server 拉取

POST   /v1/agents/:agentId/migration/import
       ← Server 流式上传 tar.zst，或 Agent 从 Server/ S3 URL 拉取

GET    /v1/agents/:agentId/workspace/usage
       → { bytesUsed, fileCount, path }
```

---

## 7. 迁移流程（详细）

### 7.1 前置条件检查

发起迁移前，Server 执行：

1. Agent 存在且 `workspace_status != migrating`
2. Source / Target Runner 均为 `online`（heartbeat < 60s）
3. Target 磁盘剩余 > 预估 workspace 大小 × 1.2
4. Target 具备 Agent 所需能力（`display` / `docker`）
5. 若无活跃容器，跳过 stop；否则先 stop workspace 容器

### 7.2 标准迁移序列

```
用户: POST /api/agents/:id/migrations { targetNodeId }

1. [Server] 创建 MigrationJob，agents.workspace_status = locked
2. [Server → Source Agent] stop workspace container
3. [Server → Source Agent] POST migration/export
      - 生成 manifest（相对路径, size, sha256, mtime）
      - 默认排除：见 §3.5（常见语言包目录）；用户可追加 excludePatterns / includePatterns
      - 流式压缩 tar.zst
4. [Server] 接收/archive 存至 data/migrations/<jobId>.tar.zst
      - 校验 archive_sha256
5. [Server → Target Agent] POST migration/import
      - 解压至 staging: <storage_root>/agents/<agentId>/workspace.incoming
      - 校验 manifest
6. [Server → Target Agent] 原子切换
      - rename workspace → workspace.bak.<ts>（保留，不删）
      - rename workspace.incoming → workspace
7. [Server] 更新 agents.runtime_node_id = targetNodeId
8. [Server] 若 Agent 需要容器：Target Agent start workspace
9. [Server] Source 端 **不自动删除**；job.source_retained = true
      - UI 提示用户可在确认无误后手动清理 Source 残留
10. [Server] job.status = completed，agents.workspace_status = ready
```

### 7.3 失败与回滚

| 失败点 | 策略 |
|--------|------|
| export 中断 | job=failed，解锁 Agent，Source 不变 |
| 传输 corrupt | 重试 export（最多 3 次） |
| import 校验失败 | 删除 Target staging，不切换，Source 仍有效 |
| 切换后 start 失败 | runtime_node_id 已更新；标记 degraded，保留 Target 文件，UI 提供「重试启动」 |
| 需回滚 | 若 Target 未切换：取消即可；若已切换但 Source 仍保留 old：反向迁移 |

### 7.4 Manifest 格式

```json
{
  "version": 1,
  "agentId": "clxxx",
  "exportedAt": "2026-07-15T03:00:00Z",
  "sourceNodeId": "node_a",
  "compression": "zstd",
  "excludePatterns": [".cache/**", "**/node_modules/**"],
  "files": [
    { "path": "README.md", "size": 128, "sha256": "abc...", "mode": "644" },
    { "path": "src/main.ts", "size": 4096, "sha256": "def...", "mode": "644" }
  ],
  "totalBytes": 1048576,
  "fileCount": 42
}
```

manifest 写入 archive 内 `_zakura/manifest.json` 便于离线校验。

### 7.5 增量迁移（Phase 2 可选）

首版全量 tar.zst。后续可：

- 对比 manifest sha256，仅打包变更文件
- 要求 Source 在 `locked` 态导出，避免增量期间写入

---

## 8. 安全

| 项 | 措施 |
|----|------|
| Agent 认证 | 注册 token 只显示一次，存 `token_hash`（bcrypt/sha256） |
| 传输 | 公网 HTTPS；内网可配置但文档警告 |
| 授权 | Server 代 Agent 操作时带 `X-Zakura-Agent-Id` + job 级 nonce，防 Agent 被误调未绑定 Agent |
| Path jail | Agent 侧复用 `resolveInRoot`，禁止路径逃逸 |
| 迁移包 | 仅 Server 可读 `data/migrations/`；完成后按 retention 删除（默认 7 天） |
| Docker | Agent 本地访问 docker.sock；不对 WAN 暴露 |
| 审计 | `workspace_migrations` + 结构化日志 |

---

## 9. 与现有功能的关系

### 9.1 本机兼容（local Runner）

Server 启动时：

```typescript
ensureLocalRuntimeNode(db, config) {
  // id = "local", kind = "local", storage_root = config.dataDir
  // 现有 data/agents/<id>/workspace 路径不变
}
```

`agents.runtime_node_id = null` 解析为 local。现有用户无感知。

### 9.2 MCP 工具

| 工具 | 改造 |
|------|------|
| `fs_*` | → `WorkspaceFsProvider` |
| `shell_exec` | → `RuntimeRouter.exec()` |
| `browser_*` / `computer_*` | CDP URL 从 Target Agent `endpoints` 获取 |
| `agent_info` | 增加 `runtimeNode`, `workspaceStatus`, `migration` |

### 9.3 Web UI

| 页面 | 改动 |
|------|------|
| 设置 → Runners | 新页：节点列表、注册 token、在线状态 |
| Agent 详情 → 工作区 | 显示当前 Runner、磁盘用量 |
| Agent 详情 → 迁移 | 选择目标 Runner、排除规则、进度条 |
| 文件浏览器 | 无 UX 变化（API 透明路由） |

---

## 10. 实施阶段

### Phase 0 — 准备（1 周）

- [ ] 确认本文「待确认」技术选型
- [ ] 抽取 `agent-fs.ts` → `packages/core` 可共享模块
- [ ] 定义 `WorkspaceFs` / `RunnerClient` 类型
- [ ] DB migration 草案评审

### Phase 1 — Local Runner 抽象（2 周）

- [ ] 新表 `runtime_nodes`，seed local 节点
- [ ] `WorkspaceFsProvider` + 改造 `agent-tools` / `agent-fs-routes`
- [ ] `RuntimeRouter`（仅 local 分支）
- [ ] `agents.runtime_node_id` 字段（默认 null）
- [ ] 回归：现有 MCP fs/shell/browser 测试通过

**交付物**：架构就绪，行为与 today 一致。

### Phase 2 — Runner Agent MVP（3 周）

- [ ] `apps/runner` 包 + `docker/runner/Dockerfile` + compose 示例
- [ ] ping、register、heartbeat（含 hostInfo / 网卡上报）
- [ ] Agent FS API（对齐 server routes）
- [ ] Agent workspace lifecycle + exec
- [ ] `RemoteAgentRuntime` + `RemoteWorkspaceFs`
- [ ] Server Runner 管理 API + Web 节点页
- [ ] 手动测试：第二台机器注册 Agent，创建 Agent 绑定远程 Runner

**交付物**：Agent 可跑在远程设备，FS/Shell 正常。

### Phase 3 — Workspace 迁移（2–3 周）

- [ ] `workspace_migrations` 表 + MigrationService 状态机
- [ ] export/import API（Agent + Server 协调）
- [ ] SSE 进度推送
- [ ] Web 迁移向导 UI
- [ ] 失败重试 / 取消 / 基础回滚
- [ ] Source 残留标记 + 手动清理 API / UI

**交付物**：完整跨 Runner 迁移闭环；Source 副本保留至用户手动删除。

### Phase 4 —  hardened（2 周，可并行）

- [ ] mTLS 或短期 JWT
- [ ] S3 迁移包后端
- [ ] 增量迁移
- [ ] Runner draining（不接受新 Agent，允许迁出）
- [ ] 监控指标：迁移耗时、失败率、Runner 磁盘

---

## 11. 测试计划

| 类型 | 内容 |
|------|------|
| 单元 | `resolveInRoot`、manifest 生成/校验、状态机转换 |
| 集成 | Local/Remote FS 一致性；exec 后 fs_read 可见 |
| E2E | 远程 Runner 上 full agent 流程（fs + shell + browser） |
| 迁移 | 小/大 workspace（10MB / 1GB）、含 node_modules 排除、中断重试 |
| 回归 | `runtime_node_id=null` 与本机 today 行为一致 |
| 安全 | 路径逃逸、无 token 拒绝、跨 Agent 访问拒绝 |

---

## 12. 运维与配置

### 12.1 Runner Agent 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `ZAKURA_RUNNER_SERVER_URL` | Server 地址 | 必填 |
| `ZAKURA_RUNNER_TOKEN` | 注册 token | 必填 |
| `ZAKURA_RUNNER_STORAGE_ROOT` | workspace 根 | `/var/lib/zakura` |
| `ZAKURA_RUNNER_PORT` | 监听端口 | `7443` |
| `ZAKURA_RUNNER_DOCKER_HOST` | Docker 连接 | `unix:///var/run/docker.sock` |
| `ZAKURA_RUNNER_PUBLIC_HOST` | CDP/noVNC 对外 IP/域名 | 自动从网卡探测 |
| `ZAKURA_RUNNER_PUBLIC_URL` | Agent 自身 URL（Server 回连） | `http://<detected>:7443` |

心跳 payload 携带完整 `hostInfo`（见 §4.6.5）。

### 12.2 Server 新增配置

| 变量 | 说明 | 默认 |
|------|------|------|
| `ZAKURA_MIGRATION_DIR` | 迁移包目录 | `data/migrations` |
| `ZAKURA_MIGRATION_RETENTION_DAYS` | 包保留天数 | `7` |
| `ZAKURA_RUNNER_HEARTBEAT_TIMEOUT_SEC` | 判定 offline | `60` |

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 迁移期间 Agent 不可用 | 用户感知停机 | UI 明确预估时间；支持维护窗口 |
| 大 workspace 超时 | 迁移失败 | 分块传输 + 断点续传（Phase 4） |
| Runner 磁盘满 | import 失败 | 前置 usage 检查；告警 |
| Server 单点存迁移包 | 磁盘压力 | 尽早支持 S3；限制并发迁移数 |
| Windows Runner | 路径/docker 差异 | MVP 仅支持 Linux Runner；Windows 作 Server+local |

---

## 14. 已定稿决策记录

| # | 问题 | 决策 |
|---|------|------|
| 1 | Agent 语言 | TypeScript（`apps/runner`） |
| 2 | 迁移包存储 | Server 本地磁盘 |
| 3 | 鉴权 | 预共享 Token + heartbeat 回传网卡信息 |
| 4 | 默认 Runner | Server 本机 = 隐式 local Runner |
| 5 | Runner 平台 | MVP Linux（x64/arm64） |
| 6 | 迁移排除项 | 默认常见语言包目录，允许用户自定义 |
| 7 | Source 清理 | 迁移成功后保留，用户手动删 |
| 8 | Runner 部署 | **容器化**，privileged + docker.sock + 数据卷 + 网卡只读挂载 |

---

## 15. 附录：与 Memoh 参考的关系

| Memoh 组件 | Zakura 计划 |
|------------|-------------|
| `internal/workspace/bridge` gRPC | Phase 4+ 优化大文件；MVP 用 REST |
| `RuntimeRouter` | 借鉴：local / remote 路由 |
| `bridge.proto` Exec/ReadFile | Agent FS + exec API 语义对齐 |
| mTLS TCP bridge | Phase 4 mTLS |

Memoh 参考代码位于 `参考资料/Memoh-main/`，不作为运行时依赖，仅设计参考。

---

## 16. 成功标准

- [ ] 至少 2 台 Linux Runner 注册并在线
- [ ] Agent 绑定远程 Runner 后，MCP `fs_*` / `shell_exec` / `browser_*` 功能正常
- [ ] 500MB workspace 迁移成功率 > 99%（局域网）
- [ ] 迁移失败不丢失 Source 数据
- [ ] 未配置远程 Runner 时，现有部署行为不变

---

*文档维护：实施过程中若选型变更，请更新 §3 与 §14 并 bump 版本号。*
