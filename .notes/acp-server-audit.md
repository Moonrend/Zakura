# ACP 服务端 / shared 审计报告

审计范围：`packages/shared/src/acp-*.ts`、`apps/server/src/api/acp-routes.ts`、`apps/server/src/services/acp/*`、`scripts/acp-sync-registry.mjs`。未修改任何源码。

## ① 数据流与常量 / env

**核心结论：仓库里并存两套互不相通的 ACP registry。**

**A. 旧「workspace registry」（服务端真正在用）**
- 常量 `ACP_REGISTRY_URL`（`packages/shared/src/acp-registry.ts:28`）。
- `AcpRegistryService.getIndex()`（`apps/server/src/services/acp/registry.ts:131-162`）用 `fetchImpl(ACP_REGISTRY_URL)` 拉取，`REFRESH_INTERVAL_MS` 缓存 6h，`FETCH_TIMEOUT_MS` 超时；失败时返回上一次 `this.index`（陈旧兜底，不清空）。
- 纯内存缓存：`index / fetchedAt / inFlight`（`registry.ts:104-106`），**进程重启即丢，不落库**。`inFlight` 做并发去重。
- 产物是 npx / uvx / binary 安装计划（`registry.ts:217-225`），装进 workspace 容器。
- UA 仍写死 `"zakura/1.0"`（`registry.ts:139`）。

**B. 新「curated 容器 registry」（Moonrend/acp-registry）**
- 源：`https://raw.githubusercontent.com/Moonrend/acp-registry/main/dist/index.json`，可用 `ZAKURA_ACP_REGISTRY_URL` 覆盖（`scripts/acp-sync-registry.mjs:15-16`）。
- **该 env 只在构建期同步脚本里生效**；`acp-registry-client.ts:10` 的注释声称「可在运行时用 `ZAKURA_ACP_REGISTRY_URL` 刷新」，但运行时无任何 fetch 代码，注释与实现不符。
- 运行时数据 100% 来自 vendored 快照 `ACP_REGISTRY_SNAPSHOT`（`acp-registry-client.ts:14,71,73`），模块加载即 `reindex(active)`（`:81`）。
- `applyAcpRegistryIndex()`（`:119-128`）与 `resetAcpRegistry()`（`:131-134`）**除测试外无任何生产调用点**（仅 `packages/shared/src/index.ts:507-509` 导出、`packages/shared/test/acp-registry-client.test.ts` 使用）→ 事实上的死代码，「云端拉取→落库→回退快照」这条链**根本没有接通**。
- 唯一消费点：`acpEnabledAgents()` 在 `registry.ts:354` 把容器 agent 并入状态列表；`acpAdapterSource()` 在 `acp-sources.ts:128` 用 `agent?.enabled` 决定走容器还是本地安装。

关键类型（`acp-registry-client.ts:64-69`）：
```ts
export interface AcpCuratedIndex {
  schemaVersion: number;
  imagePrefix: string;
  digest: string;
  agents: AcpCuratedAgent[];
}
```

## ② HTTP API 清单（apps/server/src/api/acp-routes.ts）

鉴权：整个路由文件挂在受保护的 agent 作用域下，统一经 agent 归属校验解析 `:agentId`，无独立 ACP 权限位；无按路由细分的角色控制。

- `GET /catalog` — query `force?`, `allowUnverifiedBinary?` → `AcpCatalogEntry[]`
- `GET /status` — query `force?` → `AcpAdapterStatus[]`
- `POST /install` — body `{ id, version? }` → 安装结果（含 `installed: boolean`）
- `POST /uninstall` — body `{ id }` → `{ removed: boolean }`
- `POST /gc` — 无入参 → `{ pruned: string[] }`
- 其余为 ACP 会话 / 配置 / provision 相关端点（session 生命周期、config 读写、凭据写入），合计 23 个路由定义。

核心返回类型（`apps/server/src/services/acp/registry.ts:78-96`）：
```ts
export type AcpAdapterStatus = {
  id: string;
  installed: string[];
  latest: string | null;
  updateAvailable: boolean;
  diskKb: Record<string, number>;
  source: "workspace" | "container";
  image?: string;
};
```

## ③ DB schema 字段

**结论：ACP 没有任何专属数据表。** 在 `apps/server/src/db/schema.ts` 全文 grep `acp` 仅命中一处：
- `schema.ts:1336` — `CloudAgentSessionKind` 注释，会话类型枚举含 `acp`（`chat | subagent | delegate | acp | system`），即 ACP 只作为**会话种类标记**存在于 cloud agent session 表。
- `apps/server/drizzle/` 下 0000–0046 共 47 个迁移，**无一个与 ACP registry / adapter / image 相关**。

推论：registry 索引、已安装版本、镜像 digest、更新状态**全部无持久化**，每次都靠内存缓存 + 进入容器执行 shell 脚本现场扫描（`registry.ts:309-310`）。

## ④ 更新逻辑现状与缺口

**workspace 类（npx/uvx/binary）——有更新链路：**
- 版本比对：`registry.ts:343-349`，`updateAvailable = Boolean(latest && !entry.installed.includes(latest))`。仅做**字符串包含判断**，非 semver 比较，降级发布会误报为「有更新」。
- 已装版本来自容器内 `acpInstalledVersionsScript()` 扫描（`registry.ts:309`），磁盘占用来自 `acpDiskUsageScript()`（`:310`）。
- `force` 可绕过 6h TTL（`registry.ts:311-313`），支撑 UI「检查更新」。
- 更新入口＝重新 `POST /install`；`collectGarbage()`（`:373+`）在安装后清理非 pin 版本。

**container 类（ghcr.io/moonrend/acp-registry）——更新链路缺失：**
- `registry.ts:354-365` 对容器 agent **硬编码** `installed:[version]`、`latest: version`、`updateAvailable: false` → **永远显示「已是最新」**。
- 无 image digest 漂移检测：镜像 digest 探针 `collectNodeImages` 只覆盖 runner + workspace 镜像，**不含 ACP adapter 镜像**。
- 无按 agent 的「更新 / 重装」入口，无强制 re-pull；镜像更新只能靠 tag 变化 + 快照重新 vendored + 重新发版。
- 无后台定时刷新：只有请求驱动的 6h 惰性 TTL，没有 scheduler / cron 主动拉取。
- 失败处理：fetch 失败仅 `log.warn("acp_registry.fetch_failed")` 并沿用陈旧索引（`registry.ts:151-156`），**不向 API 返回 stale 标记**，前端无法区分「真最新」与「拉取失败」。

## ⑤ 遗留 / 过时代码

1. **`enabled` 字段线上已消失（最严重）**：vendored 快照 digest `0a6a228e92596db0`，线上 `0aac197b945017dd`。逐字段 diff：39 个 agent、id/version/image 全部一致，**唯一差异是线上 index 完全删除了 `enabled` 字段**（快照中 5 个 agent 带 `enabled: true`）。而 `AcpCuratedAgent.enabled` 仍是必填（`acp-registry-client.ts:54`），`isValidIndex()`（`:97-108`）**不校验 `enabled`** → 线上 index 能通过校验，但 `acpEnabledAgents()`（`:94-95`）会返回**空数组**，`acp-sources.ts:128` 的 `agent?.enabled` 全部 falsy，所有容器 agent 静默回退到本地安装路径。这是一颗定时炸弹。
2. **死代码**：`applyAcpRegistryIndex` / `resetAcpRegistry` 无生产调用点，运行时刷新能力名存实亡。
3. **注释与实现不符**：`acp-registry-client.ts:10` 宣称运行时可用 `ZAKURA_ACP_REGISTRY_URL` 刷新，实际仅构建期脚本使用。
4. **zakura 旧命名残留**：包名 `@zakura/shared`（`registry.ts:28` 等各处 import）、env 前缀 `ZAKURA_ACP_REGISTRY_URL`、UA 字符串 `"zakura/1.0"`（`registry.ts:139`）。
5. **两套 registry 并存**：`acp-registry.ts`（旧 npm/binary）与 `acp-registry-client.ts`（新容器）职责重叠，`AcpAdapterStatus.source` 用 union 打补丁弥合，重构后应收敛为一套。
6. **npx/uvx/binary 本地安装路径**：若容器化是既定方向，`registry.ts:217-225` 的安装计划、install/uninstall/gc 三个路由及容器内 shell 扫描脚本均属待收敛资产。

## ⑥ 改进点排序（按影响）

1. **修复 `enabled` 契约**：改为 `enabled?: boolean` 且缺省视为 `true`，或在 `isValidIndex` 中强制校验并拒绝无该字段的 index；否则一旦接通线上拉取，容器 agent 全线失效。
2. **接通或删除运行时刷新**：让服务端真正调用 `applyAcpRegistryIndex`（fetch → 校验 → 落库 → 失败回退快照），否则删除死代码并明确「快照即唯一真相」。
3. **给容器 agent 建立更新链路**：按 image digest 而非 tag 比对，纳入 digest 漂移探针，提供单 agent 更新 / 强制 re-pull 入口，去掉 `updateAvailable: false` 硬编码。
4. **索引与状态持久化**：新增 ACP registry 缓存表（digest、拉取时间、来源、agents 快照），消除重启即冷启动与重复容器扫描。
5. **暴露 stale / 数据来源**：`AcpAdapterStatus` 与 catalog 返回增加 `stale`、`source: remote|snapshot|cache`、`fetchedAt`，让前端能如实呈现降级状态。
6. **版本比对改 semver**：替换 `!installed.includes(latest)` 的字符串判断。
7. **收敛两套 registry 与旧命名**：统一为单一 registry 抽象，清理 `@zakura/` 命名、UA、env 前缀。
8. **后台定时刷新**：加低频 scheduler 主动预热索引，替代纯请求驱动 TTL。
