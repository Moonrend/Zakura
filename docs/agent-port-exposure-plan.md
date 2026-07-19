# Zakura 网络、隧道与端口暴露 — 技术计划书

> 版本：v0.2 · 2026-07-15  
> 状态：选型已定稿（见 §15）；**Phase 0–1 已落地**（路由适配为 `/dashboard/network`）  
> 依赖：Runner Agent 架构（`runner-agent-workspace-plan.md`）  
> 目标：**独立配置页**统一管理 Runner 组网（Tailscale）、端口暴露（默认 Cloudflare Quick Tunnel）、后台安全策略

---

## 1. 产品定位

### 1.1 两大能力（同一设置入口，职责分离）

| 能力 | 用途 | 默认 Provider |
|------|------|---------------|
| **Runner 组网** | Server ↔ Runner、Runner ↔ Runner 私有连通 | **Tailscale**（tailnet mesh） |
| **端口暴露** | 将 Agent workspace 内端口分享至外部 | **Cloudflare Quick Tunnel**（默认启用） |

```
/settings/network  （独立配置页）
├── 概览              ← 连接状态、活跃隧道数、Runner 在线
├── Runner 组网       ← Tailscale OAuth、一键接入、节点列表
├── 端口暴露          ← Provider 卡片、默认项、测试连接
├── 活跃暴露          ← 全平台 exposure 列表、批量关闭
└── 安全策略          ← 管理员：端口黑名单、TTL、权限、审计
```

**原则**：Tailscale 解决 **「机器怎么连起来」**；Cloudflare Tunnel 等解决 **「某个端口怎么给外人访问」**。不混为一谈。

### 1.2 典型场景

| 场景 | 用哪个能力 | 示例 |
|------|-----------|------|
| 远程 Runner 在 NAT 后，Server 调 Agent API | **Tailscale 组网** | `runner-b.tailnet.ts.net:7443` |
| Runner 间迁移前校验连通性 | **Tailscale 组网** | Server ping 各 Runner |
| `npm run dev :3000` 分享给外网 | **端口暴露** | CF Quick → `*.trycloudflare.com` |
| Webhook 回调进 workspace | **端口暴露** | CF Named / Quick |
| 团队内预览 dev server | **端口暴露** | `tailscale-serve`（仅 tailnet，走已组网的 TS） |
| 远程 MCP 访问 Runner API | **Tailscale 组网** | 不经公网 |

### 1.3 现状（Zakura today）

| 能力 | 实现 | 缺口 |
|------|------|------|
| 容器端口 → 主机 | Docker publish + socat relay | 仅本机回环 |
| 外部隧道 | 无 | 需 CF Quick 等 |
| Runner 远程通信 | 计划中的 Runner Agent HTTP endpoint | 需 NAT 穿透或 VPN |
| 统一网络配置 UI | 无 | 需独立 `/settings/network` |

Memoh 参考：`webhook_tunnel` 仅 Server 级 CF Quick + Webhook，无 Tailscale mesh、无独立设置页。

---

## 2. 架构总览

### 2.1 双平面模型

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Zakura Server（控制面）                          │
│  NetworkSettingsService │ ExposureService │ TailscaleAdminService        │
│  SecurityPolicyService  │ AuditLog                                        │
└───────────────┬───────────────────────────────┬─────────────────────────┘
                │ Tailscale tailnet              │ 创建/停止 exposure
                │ (MagicDNS, 100.x)              │
    ┌───────────▼───────────┐         ┌───────────▼───────────┐
    │  Runner A             │         │  Runner B             │
    │  tailscale0           ◄──TS──► │  tailscale0           │
    │  zakura-runner :7443 │         │  zakura-runner :7443 │
    │  TunnelManager        │         │  TunnelManager        │
    │   └ cloudflared …     │         │   └ cloudflared …     │
    └───────────┬───────────┘         └───────────┬───────────┘
                │ LocalRelay                       │
                ▼                                  ▼
         workspace 容器                       workspace 容器
```

**控制面通信**（Server → Runner API）优先走 **Tailscale tailnet**（若已组网）；fallback 为用户配置的 `endpoint` 公网 URL。

**端口暴露**（外部用户 → 服务）走 **Tunnel Provider**（默认 CF Quick），与 tailnet 正交。

### 2.2 组件归属

| 组件 | 位置 |
|------|------|
| `/settings/network` 页面 | `apps/web` |
| `NetworkSettingsService` | `apps/server` |
| `TailscaleAdminService`（OAuth + API） | `apps/server` |
| `ExposureService` | `apps/server` |
| `SecurityPolicyService` | `apps/server` |
| `TunnelManager` + Mesh（Tailscale **sidecar 容器**） | `apps/runner` + Compose |
| `LocalRelay` | `apps/runner`（复用 socat） |

---

## 3. 独立配置页设计（`/settings/network`）

### 3.1 路由与导航

| 路径 | 名称 | 说明 |
|------|------|------|
| `/settings/network` | 网络概览 | 总览卡片 + 快捷操作 |
| `/settings/network/mesh` | Runner 组网 | Tailscale 连接与管理 |
| `/settings/network/exposure` | 端口暴露 | Tunnel Provider 配置 |
| `/settings/network/active` | 活跃暴露 | 全局 exposure 列表 |
| `/settings/network/security` | 安全策略 | 管理员策略与审计 |

设置侧栏（`settings-sidebar`）新增 **「网络」** 条目，与 Providers、Memory 等并列。

### 3.2 页面线框（概览 Tab）

```
┌─────────────────────────────────────────────────────────────────┐
│  网络与隧道                                                       │
├─────────────────────────────────────────────────────────────────┤
│  [Runner 组网: Tailscale ● 已连接]  [端口暴露: CF Quick ● 已启用] │
│                                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ Runners 3/3  │ │ 活跃隧道 2   │ │ 今日暴露 5   │             │
│  │ tailnet 在线 │ │ 自动 TTL     │ │ 审计事件 12  │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
│                                                                  │
│  [一键测试组网]  [测试默认隧道]  [查看安全策略]                    │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Runner 组网 Tab（Tailscale）

**首次连接（一键 OAuth）**：

```
┌─────────────────────────────────────────────────────────────────┐
│  Tailscale — Runner 组网                                         │
│  让 Server 与所有 Runner 在同一 tailnet 内安全互通，无需公网 IP。  │
│                                                                  │
│  状态：未连接                                                     │
│  [ 使用 Tailscale 登录并连接 ]  ← OAuth 授权                      │
│                                                                  │
│  或使用预授权密钥（高级）：                                         │
│  Auth Key: [________________________] [保存并应用]               │
└─────────────────────────────────────────────────────────────────┘
```

**已连接后**：

```
┌─────────────────────────────────────────────────────────────────┐
│  Tailnet: example.com  ·  已连接为 admin@example.com            │
│  [重新授权] [断开连接] [同步设备列表]                              │
│                                                                  │
│  Zakura 节点                                    [为所有 Runner  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ ● zakura-server    100.64.0.1   server    tag:zakura     │ │
│  │ ● zakura-runner-a  100.64.0.2   runner    tag:zakura    │ │
│  │ ○ zakura-runner-b  —            待接入   [生成接入密钥]    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  新 Runner 接入：复制安装命令                                      │
│  docker run ... -e ZAKURA_RUNNER_TS_AUTHKEY=tskey-auth-...      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 端口暴露 Tab（Provider 卡片）

**默认：Cloudflare Quick Tunnel 开箱启用**（无需账号）。

```
┌─────────────────────────────────────────────────────────────────┐
│  端口暴露 Provider                                                │
│  Agent / 用户一键暴露 workspace 端口时使用。                       │
│                                                                  │
│  ┌─ Cloudflare Quick Tunnel ──────────────── [默认 ✓] [已启用 ●] │
│  │  零配置，随机 *.trycloudflare.com，适合开发调试。               │
│  │  [测试：启动探针隧道]  状态：就绪                               │
│  └──────────────────────────────────────────────────────────────│
│  ┌─ Cloudflare Named Tunnel ──────────────── [ ] [未配置]       │
│  │  固定域名，适合 Webhook。Tunnel Token: [________] [保存]       │
│  └──────────────────────────────────────────────────────────────│
│  ┌─ Tailscale Serve（仅 tailnet）────────── [ ] [可选]          │
│  │  需先完成 Runner 组网。团队内 HTTPS，不暴露公网。               │
│  └──────────────────────────────────────────────────────────────│
│  ┌─ ngrok ────────────────────────────────── [ ] [未配置]       │
│  │  Authtoken: [________] [保存] [测试]                          │
│  └──────────────────────────────────────────────────────────────│
│  ┌─ frp（自托管）────────────────────────── [ ] [未配置]       │
│  │  Server: [________] Token: [________] [保存] [测试]           │
│  └──────────────────────────────────────────────────────────────│
│                                                                  │
│  默认 Provider: ( ● Cloudflare Quick ) ( ○ Cloudflare Named ) …  │
│  默认 TTL: [60] 分钟    每 Agent 最大并发: [3]                    │
└─────────────────────────────────────────────────────────────────┘
```

每个 Provider 卡片统一：**启用开关 · 设为默认 · 配置表单 · 测试连接 · 最近错误**。

### 3.5 安全策略 Tab（后台管理）

见 §8 完整策略模型；UI 面向 **admin** 角色。

---

## 4. Tailscale — Runner 组网（核心）

### 4.1 职责边界

| Tailscale 负责 | Tailscale 不负责 |
|---------------|-----------------|
| Server ↔ Runner 私有 API（`:7443`） | 公网随机 URL（交给 CF Quick） |
| Runner ↔ Runner 诊断、迁移辅助 | 替代 Cloudflare 边缘 HTTPS |
| MagicDNS 稳定主机名 | workspace 内端口自动暴露 |
| 可选：Tailscale Serve 作 tailnet 内端口暴露 | 无 TS 账号时的零配置（用 CF Quick） |

### 4.2 连接方式（按易用性排序）

#### A. OAuth 一键连接（推荐，设置页主路径）

复用 Zakura 已有 OAuth 基础设施（`OauthService`、DCR 模式可参考）。

```
1. 管理员打开 /settings/network/mesh
2. 点击「使用 Tailscale 登录并连接」
3. 跳转 Tailscale OAuth（需平台预置或租户自带 OAuth Client）
4. 回调 /oauth/tailscale/callback → Server 存 refresh_token（加密）
5. Server 调 Tailscale API：
   - GET /api/v2/tailnet/{tailnet}/devices
   - 创建 tag:zakura-runner / tag:zakura-server ACL 模板（可选）
6. UI 显示 tailnet 名称、已管理设备
```

**Tailscale OAuth Client**（租户或平台级配置）：

- 在 [Tailscale Admin → OAuth clients](https://login.tailscale.com/admin/settings/oauth) 创建。
- Scopes：`devices:read`, `devices:write`, `auth_keys:write`, `tailnet:read`。
- 存 `client_id` + `client_secret`（加密）于 `network_integrations` 表。

#### B. 预授权密钥（Auth Key，Runner 批量接入）

OAuth 连接后，Server 通过 API 创建 **可复用、带 tag 的 auth key**：

```http
POST /api/v2/tailnet/{tailnet}/keys
{
  "capabilities": {
    "devices": {
      "create": {
        "reusable": true,
        "ephemeral": false,
        "preauthorized": true,
        "tags": ["tag:zakura-runner"]
      }
    }
  },
  "expirySeconds": 86400
}
```

- 新 Runner 注册时 UI 展示 **一键 docker run 命令**（含 `TS_AUTHKEY`）。
- Runner 启动：`tailscale up --auth-key=... --hostname=zakura-runner-{slug} --accept-routes`

#### C. 手动 Auth Key（高级用户）

设置页提供文本框直接粘贴 Tailscale Admin 生成的 key，不经过 OAuth API。

### 4.3 Runner：官方 Tailscale 容器（sidecar，推荐）

**不要**在 Runner 镜像内安装 / 运行 `tailscaled`。使用官方 `tailscale/tailscale` 容器独占 TUN，
Runner 通过 `network_mode: service:zakura-ts` 共享其网络命名空间：

```yaml
services:
  zakura-ts:
    image: tailscale/tailscale:latest
    hostname: zakura-runner-${SLUG}
    environment:
      TS_AUTHKEY: ${ZAKURA_RUNNER_TS_AUTHKEY}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      TS_EXTRA_ARGS: --advertise-tags=tag:zakura-runner --accept-routes
    volumes:
      - zakura-ts-state:/var/lib/tailscale
    devices:
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
      - NET_RAW
    ports:
      - "7443:7443"   # 端口声明在 sidecar 上

  zakura-runner:
    image: zakura/runner:latest
    network_mode: service:zakura-ts   # 共享 Tailscale 网卡
    depends_on: [zakura-ts]
    privileged: true
    environment:
      ZAKURA_RUNNER_TOKEN: ${ZAKURA_RUNNER_TOKEN}
      # …
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - zakura-runner-data:/var/lib/zakura
```

设置页「新 Runner 接入」会生成上述 Compose（含已存储的 Auth Key）。

**Server 本机（local Runner）**：可选另起一个 `tailscale/tailscale` 容器，或使用宿主机已安装的 Tailscale。

### 4.4 Server 如何使用 tailnet

| 场景 | 行为 |
|------|------|
| 调 Runner API | `endpoint` 优先 `http://zakura-runner-{slug}.{tailnet}.ts.net:7443` |
| Runner 心跳 | Runner 上报 `tailscaleIp` + `magicDnsName` |
| UI 展示 | Runner 卡片显示 tailnet 地址 vs 公网地址 |
| 未组网 fallback | 使用用户填写的 `ZAKURA_RUNNER_PUBLIC_URL` |

`runtime_nodes.host_info_json` 扩展：

```typescript
interface RunnerHostInfo {
  // ... 现有网卡字段
  tailscale?: {
    connected: boolean;
    ip: string;           // 100.x.x.x
    magicDnsName: string; // zakura-runner-a.tailnet.ts.net
    hostname: string;
    tags: string[];
  };
}
```

### 4.5 ACL 建议模板（可选一键应用）

```json
{
  "tagOwners": {
    "tag:zakura-server": ["autogroup:admin"],
    "tag:zakura-runner": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:zakura-server"],
      "dst": ["tag:zakura-runner:7443"]
    },
    {
      "action": "accept",
      "src": ["tag:zakura-runner"],
      "dst": ["tag:zakura-server:8787"]
    }
  ]
}
```

设置页提供「应用 Zakura 推荐 ACL」按钮（需 OAuth `acl:write` scope，高级可选）。

---

## 5. 端口暴露 — Tunnel Provider

### 5.1 默认策略（已定稿）

- **默认启用** `cloudflare-quick`，无需 Cloudflare 账号。
- 租户可在设置页 **切换默认 Provider** 或 **禁用** 某 Provider。
- Agent 创建 exposure 时未指定 provider → 用租户默认（即 CF Quick）。

### 5.2 Provider 一览

| Provider ID | 用途 | 配置难度 | 默认 |
|-------------|------|---------|------|
| `cloudflare-quick` | 公网临时 HTTPS | 零配置 | **✓ 默认启用** |
| `cloudflare-named` | 公网固定域名 | Tunnel Token | 可选 |
| `tailscale-serve` | 仅 tailnet 访问 | 需先组网 | 可选 |
| `ngrok` | 公网 | Authtoken | 可选 |
| `frp` | 自托管 | Server + Token | 可选 |

> **注意**：公网暴露不再默认走 Tailscale Funnel；Tailscale 主责组网。若需 tailnet 内分享端口，用 `tailscale-serve`。

### 5.3 流量路径（端口暴露）

```
外部用户 → Cloudflare Edge（Quick Tunnel）→ Runner cloudflared
         → 127.0.0.1:relayPort → LocalRelay → workspace:3000
```

Tailscale 组网后，**Server 到 Runner** 的路径不再经公网；但 **外部用户访问 dev server** 仍走 CF Quick（除非选 tailscale-serve）。

### 5.4 Cloudflare Quick Tunnel 实现要点

```bash
cloudflared tunnel --url http://127.0.0.1:<relayPort> --metrics 127.0.0.1:<metricsPort>
```

- Memoh `webhooktunnel` 同款 metrics 轮询取 `*.trycloudflare.com`。
- 设置页「测试默认隧道」：启动探针 → 显示测试 URL → 10s 后自动关闭。

---

## 6. 数据模型

### 6.1 `network_integrations`（OAuth 与集成凭证）

```sql
CREATE TABLE network_integrations (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- tailscale-oauth | tailscale-authkey | cloudflare-named | ngrok | frp
  status        TEXT NOT NULL DEFAULT 'disconnected',
  -- disconnected | connected | error
  display_name  TEXT,            -- tailnet 名、账号邮箱
  credentials_enc TEXT NOT NULL DEFAULT '{}',  -- OAuth tokens、API keys（加密）
  meta_json     TEXT NOT NULL DEFAULT '{}',    -- tailnet id、device id、scopes
  last_sync_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind)
);
```

### 6.2 `tunnel_provider_settings`（端口暴露 Provider 开关与默认）

```sql
CREATE TABLE tunnel_provider_settings (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,   -- cloudflare-quick | cloudflare-named | ...
  enabled       BOOLEAN NOT NULL DEFAULT false,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  config_enc    TEXT NOT NULL DEFAULT '{}',
  last_test_at  TIMESTAMPTZ,
  last_test_ok  BOOLEAN,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- 种子数据（租户首次 setup）：
-- cloudflare-quick: enabled=true, is_default=true
```

### 6.3 `network_security_policies`（后台安全策略）

```sql
CREATE TABLE network_security_policies (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'tenant',  -- platform | tenant
  enabled         BOOLEAN NOT NULL DEFAULT true,

  -- 端口暴露
  exposure_enabled        BOOLEAN NOT NULL DEFAULT true,
  default_ttl_minutes     INTEGER NOT NULL DEFAULT 60,
  max_ttl_minutes         INTEGER NOT NULL DEFAULT 1440,
  max_active_per_agent    INTEGER NOT NULL DEFAULT 3,
  max_active_per_tenant   INTEGER NOT NULL DEFAULT 50,
  denied_ports_json       TEXT NOT NULL DEFAULT '[22,2375,2376,5432,6379,27017,5900,6080,9222,8787]',
  allow_desktop_exposure  BOOLEAN NOT NULL DEFAULT false,
  allow_public_exposure   BOOLEAN NOT NULL DEFAULT true,
  allow_tcp_exposure      BOOLEAN NOT NULL DEFAULT false,

  -- Agent / MCP 权限
  agents_can_expose       BOOLEAN NOT NULL DEFAULT true,
  require_user_approval   BOOLEAN NOT NULL DEFAULT false,

  -- 组网
  require_tailscale_for_remote_runners BOOLEAN NOT NULL DEFAULT false,

  -- 审计
  audit_retention_days    INTEGER NOT NULL DEFAULT 90,

  updated_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope)
);
```

### 6.4 `port_exposures`（活跃暴露，结构同 v0.1，略）

```sql
-- 见 v0.1；provider 枚举去掉 tailscale-funnel 作为默认路径，保留 tailscale-serve
-- 增加 integration_id 可选关联 named tunnel 配置
```

### 6.5 `network_audit_logs`

```sql
CREATE TABLE network_audit_logs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  actor_type  TEXT NOT NULL,   -- user | agent | system
  actor_id    TEXT,
  action      TEXT NOT NULL,   -- exposure.create | exposure.stop | mesh.connect | policy.update | ...
  target_type TEXT,
  target_id   TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX network_audit_tenant_time ON network_audit_logs(tenant_id, created_at);
```

---

## 7. Server API

### 7.1 网络设置（设置页专用）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings/network/overview` | 概览统计 |
| GET | `/api/settings/network/mesh` | Tailscale 状态 + 设备列表 |
| POST | `/api/settings/network/mesh/oauth/start` | 返回 OAuth authorize URL |
| GET | `/oauth/tailscale/callback` | OAuth 回调 |
| POST | `/api/settings/network/mesh/disconnect` | 断开 OAuth |
| POST | `/api/settings/network/mesh/sync` | 同步 Tailscale 设备 |
| POST | `/api/settings/network/mesh/auth-key` | 生成 Runner 接入密钥 |
| GET | `/api/settings/network/exposure/providers` | Provider 卡片列表 |
| PATCH | `/api/settings/network/exposure/providers/:id` | 启用/默认/保存配置 |
| POST | `/api/settings/network/exposure/providers/:id/test` | 测试连接 |
| GET | `/api/settings/network/security` | 安全策略 |
| PUT | `/api/settings/network/security` | 更新策略（admin） |
| GET | `/api/settings/network/audit` | 审计日志分页 |

### 7.2 端口暴露（Agent 级，同 v0.1）

| 方法 | 路径 |
|------|------|
| GET/POST | `/api/agents/:id/exposures` |
| DELETE | `/api/exposures/:id` |
| GET | `/api/settings/network/active-exposures` | 全局活跃列表 |

### 7.3 MCP 工具（Agent 最终面）

```typescript
list_exposers({})
  // → { default_provider, exposers: [{ id, name, usable, reason, ... }] }

expose_port({ port, provider?, name?, ttl_minutes? })
  // → { exposure_id, url, address, provider, port, expires_at }

unexpose_port({ exposure_id?, port? })
  // → { ok, exposure_id, port, status }

list_exposures({})
  // → { exposures: [{ exposure_id, port, url, status, ... }] }  // 辅助查询
```

受 `network_security_policies.agents_can_expose` 约束。`list_exposers.usable=true` 才可调用 `expose_port`。

---

## 8. 安全设计（后台统一管理）

### 8.1 策略层级

```
platform 默认策略（单租户 setup 时种子）
    ↓ 租户 admin 可收紧（不可放宽平台硬限制，可选）
tenant 策略
    ↓ 可选 per-agent override（agents.configJson.exposurePolicy）
agent 策略
```

### 8.2 默认安全基线

| 项 | 默认值 |
|----|--------|
| 端口暴露总开关 | **启用** |
| 默认 Provider | **cloudflare-quick** |
| 默认 TTL | 60 分钟 |
| 每 Agent 最大活跃隧道 | 3 |
| 拒绝端口 | 22, 2375, 5432, 5900, 6080, 9222, 8787… |
| 允许暴露桌面 noVNC/CDP | **否** |
| Agent MCP 自助暴露 | **是**（admin 可关） |
| 远程 Runner 必须 Tailscale | **否**（可 tighten） |

### 8.3 审计事件

- `mesh.oauth.connect` / `mesh.disconnect`
- `mesh.auth_key.create`
- `exposure.create` / `stop` / `expire`
- `provider.test` / `provider.config.update`
- `security.policy.update`

### 8.4 风险披露

设置页与 exposure 创建对话框内置简短说明：Quick Tunnel URL 知道即可访问；Tailscale 组网不等于端口已对公网暴露。

---

## 9. Runner 侧实现

### 9.1 模块划分

```
apps/runner/src/
├── tunnel/
│   ├── manager.ts
│   ├── cloudflare-quick.ts
│   ├── cloudflare-named.ts
│   ├── tailscale-serve.ts
│   ├── ngrok.ts
│   └── frp.ts
└── relay/
    └── local-relay.ts    # socat，复用 docker.openTcpTunnel
```

Tailscale 组网由 Compose sidecar（`tailscale/tailscale`）提供，不在 Runner 进程内启动 `tailscaled`。
Runner 心跳仍可上报 `hostInfo.tailscale`（从共享 netns / MagicDNS 探测）。

### 9.2 启动顺序

```
1. Compose 拉起 zakura-ts（tailscale/tailscale）+ zakura-runner（共享 netns）
2. 向 Server register + heartbeat（含网卡 / 可选 tailscale 信息）
3. 等待 Server 指令（workspace / exposure）
```

---

## 10. 实施阶段

### Phase 0 — 设置页骨架 + 数据模型（1 周）

- [x] DB：`network_integrations`、`tunnel_provider_settings`、`network_security_policies`、`network_audit_logs`、`port_exposures`
- [x] 种子：`cloudflare-quick` enabled + default
- [x] `/dashboard/network` 路由 + 侧栏 + UI（Zakura 使用 dashboard，非 `/settings`）
- [x] SecurityPolicy CRUD API

### Phase 1 — Cloudflare Quick + 端口暴露 MVP（2 周）

- [x] Server 侧 CF Quick Tunnel（本地 Docker workspace）+ LocalRelay（socat）
- [x] Agent exposure API + MCP tools（`list_exposers` / `expose_port` / `unexpose_port` / `list_exposures`）
- [x] 设置页 Provider 卡片 + 测试连接
- [x] 安全策略 Tab（admin）
- [x] 活跃暴露列表
- [ ] Runner `TunnelManager` 完整接线（远程 Runner；本地已由 Server 承接）

### Phase 2 — Tailscale 组网（2–3 周）

- [x] Tailscale OAuth Client Credentials 连接（`/mesh/oauth/connect`）+ 打开 Admin 创建 Client
- [x] 手动 Auth Key 保存 + Runner 接入命令展示
- [x] Tailscale API：设备列表同步、auth key 生成
- [x] Runner 接入：官方 **Tailscale sidecar 容器**（Compose `network_mode: service:`，非进程内 tailscaled）
- [x] 设置页 Mesh Tab：OAuth Client 连接、生成 Key、节点/设备列表、sidecar Compose
- [x] **平台托管 Headscale**：独立 `docker/headscale` Compose + Headplane；每租户 User + ACL `autogroup:self`；主节点 `tag:platform`；Mesh 页模式切换；`--login-server` 安装包
- [ ] Server → Runner 优先 tailnet endpoint
- [x] Cloudflare Named：API Token + Account ID 连接；API 创建隧道（**无 Tunnel OAuth**，官方限制）

### Phase 3 — 更多 Provider + 生产化（2 周）

- [ ] CF Named、ngrok、frp 运行时
- [x] `tailscale-serve`：本机 `tailscale serve --bg` + Docker relay（远程 Runner 仍待 TunnelManager）
- [ ] ACL 模板一键应用（可选）
- [ ] 审计导出、租户配额
- [ ] 迁移/Runner 下线时自动关 exposure + 撤销 auth key

---

## 11. 已定稿决策（v0.2）

| # | 决策 |
|---|------|
| 1 | **独立配置页** `/settings/network`，不散落在 Agent 详情里 |
| 2 | **默认启用 Cloudflare Quick Tunnel**，零账号开箱 |
| 3 | Provider **卡片式**配置：启用 / 默认 / 表单 / 测试 |
| 4 | **Tailscale 主责 Runner 组网**，非默认公网暴露手段 |
| 5 | Tailscale 支持 **OAuth 一键连接** + Auth Key 批量接入 Runner |
| 6 | **后台安全策略**独立 Tab，admin 统一管理 TTL、黑名单、权限、审计 |
| 7 | Source 端迁移策略见 runner 计划；暴露与迁移解耦 |
| 8 | **SaaS 平台托管 Headscale**：租户共用一个 tailnet，ACL 隔离；与 Tailscale 云 OAuth 模式互斥切换 |

---

## 11.1 平台托管 Mesh（Headscale）

部署：`docker/headscale/`（独立 Compose，含 Headscale + Headplane）。

主应用：SaaS 超管后台配置平台 Headscale（URL / API Key 存数据库）。OSS 不支持 Headscale，使用 Tailscale 云并可选择将主设备入网。

隔离：每租户 Headscale User `tenant-<id>@`；设备不打 tag（`autogroup:self`）；主节点 `tag:platform` 可访问全部。

API：`POST /api/settings/network/mesh/platform/enable`；`generate` auth key 在平台模式下签发 Headscale preauth；Runner Compose 带 `--login-server`。

---

## 12. 成功标准

- [ ] 新装 Zakura 后，设置 → 网络 显示 CF Quick **已启用且为默认**
- [ ] 未配 Tailscale 时，仍可用 CF Quick 暴露端口
- [ ] OAuth 连接 Tailscale 后，Runner 一键 docker 命令接入 tailnet
- [ ] Server 经 tailnet 调用远程 Runner API（无需 Runner 公网 IP）
- [ ] 安全策略修改后，Agent MCP `expose_port` 行为即时生效
- [ ] 全平台活跃暴露可在设置页统一关闭

---

## 13. 附录

- Memoh webhook_tunnel：`参考资料/Memoh-main/internal/webhooktunnel/manager.go`
- Tailscale OAuth：`https://tailscale.com/kb/121/oauth-clients`
- Tailscale API keys：`https://tailscale.com/kb/1085/auth-keys`
- Runner Agent 计划：`docs/runner-agent-workspace-plan.md`

---

*文档维护：UI 路由或 Provider 变更时同步 §3、§5、§7。*
