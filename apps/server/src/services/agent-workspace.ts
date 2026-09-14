import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import {
  RunnerClient,
  ShellJobRegistry,
  ensureWorkspaceDir,
  log,
  mapContainerPathToHost,
  recordPlatformFault,
  type ShellJobSnapshot,
} from "@zakura/core";
import {
  AGENT_DESKTOP_HEIGHT,
  AGENT_DESKTOP_WIDTH,
  AGENT_PORT_CDP,
  AGENT_PORT_NOVNC,
  AGENT_WORKSPACE_ROOT,
  DEFAULT_ACP_SIDECAR_IMAGE,
  DEFAULT_WORKSPACE_IMAGE,
  DEFAULT_WORKSPACE_LITE_IMAGE,
  WORKSPACE_IMAGE_LOCAL,
  type RunnerHostInfo,
} from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  agents,
  managedContainers,
  newId,
  tenants,
  type Agent,
  type RuntimeNode,
} from "../db/schema.js";
import type { DockerPullEvent, DockerRuntime, TcpTunnel } from "../runtime/docker.js";
import {
  beginAgentProgress,
  finishAgentProgress,
  logAgentProgress,
} from "./agent-progress.js";
import { type RuntimeNodeService } from "./runtime-nodes.js";
import { workspaceReadyCommand } from "./workspace-readiness.js";
import { openWorkspaceTcpTunnel } from "./workspace-tcp-tunnel.js";

export const WORKSPACE_EXEC_PATH =
  "/opt/zakura/acp/bin:/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * HOME inside an ACP adapter container. Backed by a per-adapter docker volume
 * so each adapter's credentials (`~/.claude`, `~/.gemini`, ...) stay isolated.
 */
export const ACP_ADAPTER_HOME = "/opt/zakura/acp-home";

/** Per agent × adapter credential volume name. */
export function acpAdapterCredVolume(agentId: string, adapterId: string): string {
  return `zakura-acpcred-${adapterId}-${agentId}`
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 63);
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
}

/** Runner 若未配置 PUBLIC_HOST，endpoints 可能仍是 127.0.0.1 — 用节点 hostInfo 改写 */
function advertiseHostFromNode(node: RuntimeNode): string | null {
  let hi: RunnerHostInfo | Record<string, unknown> = {};
  try {
    hi = JSON.parse(node.hostInfoJson || "{}") as RunnerHostInfo;
  } catch {
    hi = {};
  }
  const primaryIp = typeof hi.primaryIp === "string" ? hi.primaryIp : null;
  if (primaryIp && !isLoopbackHost(primaryIp)) return primaryIp;

  const publicUrl = typeof hi.publicUrl === "string" ? hi.publicUrl : null;
  if (publicUrl) {
    try {
      const h = new URL(publicUrl).hostname;
      if (h && !isLoopbackHost(h)) return h;
    } catch {
      /* ignore */
    }
  }
  if (node.endpoint) {
    try {
      const h = new URL(node.endpoint).hostname;
      if (h && !isLoopbackHost(h)) return h;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function rewriteLoopbackUrl(
  url: string | null | undefined,
  advertiseHost: string | null,
): string | null {
  if (!url) return null;
  if (!advertiseHost || isLoopbackHost(advertiseHost)) return url;
  try {
    const u = new URL(url);
    if (!isLoopbackHost(u.hostname)) return url;
    u.hostname = advertiseHost;
    return u.toString();
  } catch {
    return url;
  }
}

export function agentDataDir(config: AppConfig, agentId: string): string {
  return join(config.dataDir, "agents", agentId);
}

export function agentWorkspaceHostPath(config: AppConfig, agentId: string): string {
  return join(agentDataDir(config, agentId), "workspace");
}

/**
 * Bind-mount source for an agent workspace, in host-filesystem terms.
 *
 * `agentWorkspaceHostPath` is *our* view of the directory (`<dataDir>/agents/…`).
 * Under compose the server is a container with `ZAKURA_DATA_DIR=/data`, while the
 * workspace container is created on the host daemon — so the bind source has to be
 * translated, or the host silently mounts a different, empty directory and the
 * workspace splits in two. See `mapContainerPathToHost`.
 */
export function agentWorkspaceBindSource(config: AppConfig, agentId: string): string {
  return mapContainerPathToHost(
    agentWorkspaceHostPath(config, agentId),
    config.dataDir,
    config.hostDataDir ?? undefined,
  );
}

export type StackMode = "none" | "shell" | "display";

export function resolveStackMode(agent: Agent): StackMode {
  if (agent.enableComputer) return "display";
  // All agents get at least a shell container (lite image) for ACP / MCP / exec.
  // Agents that genuinely need no container stay at "none" only when no
  // workspace-backed capability is in use — but since ACP and cloud-agent
  // sessions always call ensureStarted, defaulting to "shell" avoids the
  // "no container" failure path.
  return "shell";
}

/** Prefer env override, then published / local prebaked workspace image. */
export function resolveWorkspaceImage(configured: string | null | undefined): string {
  const fromEnv = process.env.ZAKURA_WORKSPACE_IMAGE?.trim();
  const preferred = fromEnv || WORKSPACE_IMAGE_LOCAL || DEFAULT_WORKSPACE_IMAGE;
  const raw = (configured?.trim() || preferred).trim() || preferred;
  // 历史本地标签 → 发布镜像（避免 DB / 旧默认值继续拉取 zakura/workspace:*）
  if (isLegacyWorkspaceImage(raw)) return preferred;
  return raw;
}

/** Lite workspace image for shell-only / ACP coding workloads. */
export function resolveWorkspaceLiteImage(): string {
  return (
    process.env.ZAKURA_WORKSPACE_LITE_IMAGE?.trim() ||
    DEFAULT_WORKSPACE_LITE_IMAGE
  );
}

/** Pick the image for a workspace. shell-only workloads (ACP / MCP / exec) use the
 *  lean lite image; display (browser / desktop / computer-use) needs the full image.
 *  A per-agent configured image always wins. */
export function resolveImageForMode(
  mode: StackMode,
  configured: string | null | undefined,
): string {
  if (configured?.trim()) return resolveWorkspaceImage(configured);
  if (mode === "shell") return resolveWorkspaceLiteImage();
  return resolveWorkspaceImage(null);
}

/** 旧版本地构建标签（docker build -t zakura/workspace:debian） */
export function isLegacyWorkspaceImage(image: string): boolean {
  return /^zakura\/workspace(?::|$)/i.test(image.trim());
}

export function isPrebakedWorkspaceImage(image: string): boolean {
  const t = image.trim();
  return (
    isLegacyWorkspaceImage(t) ||
    /(?:^|\/)zakura-workspace(?:-lite)?(?:-dev)?(?::|$)/i.test(t) ||
    /(?:^|\/)zakura-acp-sidecar(?:-dev)?(?::|$)/i.test(t)
  );
}

/**
 * Display/browser stack lives in docker/workspace/entrypoint.sh (prebaked image).
 * Server only starts the container with env flags — no runtime apt.
 */

export interface DesktopEndpoints {
  novncUrl: string | null;
  novncPort: number | null;
  cdpUrl: string | null;
  cdpPort: number | null;
  vncPort: number | null;
  width: number;
  height: number;
}

export class AgentWorkspaceService {
  /** agentId:containerPort → host tunnel (survives Docker Desktop port-publish failures) */
  private readonly tunnels = new Map<string, TcpTunnel>();
  private readonly shellJobs = new ShellJobRegistry();
  /** Serialize start/ensure so ACP draft + UI Start 不会互相拆掉对方刚拉起的容器 */
  private readonly startLocks = new Map<string, Promise<unknown>>();
  /**
   * dockerId → mount-validity cache. execInWorkspace used to run a `test -d
   * /workspace` probe before *every* command, adding a full docker exec round
   * trip to each call. Once a container's bind mount is confirmed valid it stays
   * valid for the container's lifetime, so cache it and only invalidate on
   * stop/remove.
   */
  constructor(
    private readonly db: Db,
    _runtime: DockerRuntime,
    private readonly config: AppConfig,
    private readonly nodes?: RuntimeNodeService,
  ) {
    // RuntimeNodeService owns the local Docker and remote Hub clients.
    void _runtime;
  }

  private withStartLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.startLocks.get(agentId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.startLocks.set(agentId, next);
    // Release the slot with `then(cb, cb)` rather than `void next.finally(cb)`.
    // `.finally()` returns a *new* promise that re-throws the original rejection;
    // nothing awaits that derivative, so every failed start (offline Runner, bad
    // image, …) surfaced as an unhandledRejection and could take the process down.
    // Passing the same callback to both arms keeps the bookkeeping while leaving
    // the rejection to be observed by our caller, who owns `next`.
    const release = () => {
      if (this.startLocks.get(agentId) === next) this.startLocks.delete(agentId);
    };
    next.then(release, release);
    return next;
  }

  async isWorkspaceRunning(agent: Agent): Promise<boolean> {
    try {
      await this.resolveDockerId(agent);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 工作区已在跑就直接复用。ACP / exec 热路径必须走这里：
   * `start()` 会停掉并重建整个电脑环境（含桌面就绪等待）。
   *
   * `require` 控制冷启动时阻塞到哪种就绪程度：
   * - "shell"（默认）：只等 .shell-ready，容器内 /workspace 挂载 + 工具链可用即可。
   *   ACP 编码 agent 走 stdio，不需要浏览器，不必为 Chrome 启动多等数十秒。
   * - "display"：额外等 .display-ready（Chrome CDP / VNC）。computer-use、
   *   desktop-proxy 等真正消费桌面的路径才需要。
   */
  async ensureStarted(
    agent: Agent,
    opts?: { require?: "shell" | "display" },
  ): Promise<Agent> {
    const require = opts?.require ?? "shell";
    if (require === "display" && this.isHostWorkspace(agent)) {
      throw new Error("本机工作区提供文件和终端；虚拟桌面与浏览器需要容器工作区（Docker）。");
    }
    return this.withStartLock(agent.id, async () => {
      if (await this.isWorkspaceRunning(agent)) {
        if (require === "display") {
          const { client } = await this.requireRunnerClient(agent);
          await this.waitUntilReady(agent, client, require);
        }
        return agent;
      }
      return this.startUnlocked(agent, { require });
    });
  }

  private async waitUntilReady(agent: Agent, client: RunnerClient, require: "shell" | "display") {
    if (this.isHostWorkspace(agent)) return;
    const result = await client.execWorkspace(agent.id, workspaceReadyCommand(require), {
      env: { DISPLAY: ":99" }, timeoutMs: 40_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Workspace ${require} readiness failed (exit ${result.exitCode}, DISPLAY=:99). Check workspace startup logs, Xvfb, x11vnc and Chromium; restart older containers to apply display flags.\n${result.stderr || result.stdout}`.slice(0, 3000));
    }
  }

  hostRoot(agent: Agent): string {
    return agentWorkspaceHostPath(this.config, agent.id);
  }

  ensureLocal(agent: Agent): string {
    const root = this.hostRoot(agent);
    ensureWorkspaceDir(root);
    return root;
  }

  /** An explicit local or remote binding is required; null never falls back. */
  private hasRuntimeNode(agent: Agent): boolean {
    return Boolean(agent.runtimeNodeId);
  }

  isHostWorkspace(agent: Agent): boolean {
    return (agent as Agent & { workspaceKind?: string }).workspaceKind === "host";
  }

  private async requireRunnerClient(
    agent: Agent,
  ): Promise<{ client: RunnerClient; node: RuntimeNode }> {
    if (!this.hasRuntimeNode(agent)) {
      throw new Error("请先绑定一台电脑或服务器");
    }
    if (!this.nodes) {
      throw new Error("运行节点服务不可用，请稍后重试");
    }
    return this.nodes.requireRunnerClient(agent.tenantId, agent.runtimeNodeId!, {
      workspaceKind: this.isHostWorkspace(agent) ? "host" : "container",
    });
  }

  async getWorkspaceContainer(agentId: string) {
    const rows = await this.db
      .select()
      .from(managedContainers)
      .where(
        and(
          eq(managedContainers.agentId, agentId),
          eq(managedContainers.purpose, "workspace"),
        ),
      );
    return rows.find((r) => r.status !== "removed") ?? rows[0] ?? null;
  }

  parsePorts(portsJson: string): Array<{ containerPort: number; hostPort?: number }> {
    try {
      return JSON.parse(portsJson) as Array<{ containerPort: number; hostPort?: number }>;
    } catch {
      return [];
    }
  }

  private publicHostname(): string {
    try {
      const host = new URL(this.config.publicBaseUrl).hostname || "127.0.0.1";
      return host === "0.0.0.0" ? "127.0.0.1" : host;
    } catch {
      return "127.0.0.1";
    }
  }

  getDesktopEndpoints(portsJson: string | null | undefined): DesktopEndpoints {
    const ports = portsJson ? this.parsePorts(portsJson) : [];
    const find = (containerPort: number) =>
      ports.find((p) => p.containerPort === containerPort)?.hostPort ?? null;

    const novncPort = find(AGENT_PORT_NOVNC);
    const cdpPort = find(AGENT_PORT_CDP);
    const host = this.publicHostname();

    return {
      novncPort,
      cdpPort,
      vncPort: find(5900),
      novncUrl: novncPort
        ? `http://${host}:${novncPort}/vnc.html?autoconnect=true&resize=scale&password=`
        : null,
      cdpUrl: cdpPort ? `http://127.0.0.1:${cdpPort}` : null,
      width: AGENT_DESKTOP_WIDTH,
      height: AGENT_DESKTOP_HEIGHT,
    };
  }

  private async probeHttp(url: string, timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private closeTunnelsForAgent(agentId: string) {
    for (const [key, tunnel] of this.tunnels) {
      if (key.startsWith(`${agentId}:`)) {
        tunnel.close();
        this.tunnels.delete(key);
      }
    }
  }

  async getCdpBaseUrl(agentId: string): Promise<string | null> {
    const resolved = await this.resolveCdp(agentId);
    return resolved.url;
  }

  /**
   * Resolve a host-reachable CDP endpoint, attempting Chrome recovery when needed.
   */
  async resolveCdp(agentId: string): Promise<{
    url: string | null;
    reason: string;
    containerStatus: string | null;
    chromeInside: boolean;
  }> {
    return this.withStartLock(agentId, async () => {
      const row = await this.getWorkspaceContainer(agentId);
      const unavailable = (reason: string, status: string | null = row?.status ?? null) => ({ url: null, reason, containerStatus: status, chromeInside: false });
      const agent = await this.db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent || !this.hasRuntimeNode(agent)) return unavailable("请先绑定一台在线的电脑或服务器");
      if (this.isHostWorkspace(agent)) return unavailable("本机工作区提供文件和终端；虚拟浏览器需要容器工作区（Docker）。");
      try {
        const { client } = await this.requireRunnerClient(agent);
        const ws = await client.getWorkspace(agentId);
        if (!ws || ws.status !== "running") return unavailable("工作区未运行，请先启动电脑。", ws?.status ?? null);
        const key = `${agentId}:${agent.runtimeNodeId}:${ws.dockerId}:${AGENT_PORT_CDP}`;
        const cached = this.tunnels.get(key);
        if (cached && await this.probeHttp(`${cached.url}/json/version`)) {
          return { url: cached.url, reason: "ok", containerStatus: ws.status, chromeInside: true };
        }
        this.closeTunnelsForAgent(agentId);
        const inside = await client.execWorkspace(agentId, ["curl", "--fail", "--silent", "--max-time", "2", `http://127.0.0.1:${AGENT_PORT_CDP}/json/version`], { timeoutMs: 3000 });
        if (inside.exitCode !== 0) return unavailable("Chromium CDP 尚未就绪。检查工作区启动日志和浏览器启用标志；旧容器需重新启动。", ws.status);
        // Chrome binds container localhost. Published ports and PUBLIC_HOST cannot
        // reach it reliably, especially behind NAT; carry HTTP + WS over Runner.
        const tunnel = await openWorkspaceTcpTunnel(
          () => client.startStdio(agentId, ["socat", "STDIO", `TCP:127.0.0.1:${AGENT_PORT_CDP},connect-timeout=5`], { workingDir: AGENT_WORKSPACE_ROOT }),
          (error) => recordPlatformFault("agent_ws.cdp_tunnel", error, { subsystem: "agent_ws" }),
        );
        this.tunnels.set(key, tunnel);
        if (!await this.probeHttp(`${tunnel.url}/json/version`, 8000)) {
          this.closeTunnelsForAgent(agentId);
          return unavailable("CDP 代理连接失败。检查 Runner 通道和工作区 socat/Chromium 日志。", ws.status);
        }
        return { url: tunnel.url, reason: "ok", containerStatus: ws.status, chromeInside: true };
      } catch (error) {
        this.closeTunnelsForAgent(agentId);
        return unavailable(error instanceof Error ? error.message : "运行节点或 CDP 代理不可用");
      }
    });
  }

  /**
   * 轻量桌面信息：仅同步端口映射与已有隧道，不做 CDP/Chrome 恢复。
   * 详情页与轮询会频繁调用；恢复逻辑留在 resolveCdp（工具实际使用时）。
   * 远程 Runner：从 Runner endpoints API 读取 noVNC/CDP。
   */
  async getDesktopInfo(agent: Agent) {
    const computerOn = Boolean(agent.enableComputer);
    const supported = computerOn && !this.isHostWorkspace(agent);
    const display = {
      enabled: supported,
      supported,
      computer: supported,
      browser: supported,
      display: supported ? ":99" : null,
      coordinateSpace: "desktop pixels, origin top-left",
      dimensionsSource: "configured",
      reason: !computerOn ? "电脑未启用" : this.isHostWorkspace(agent) ? "本机工作区提供文件和终端；虚拟桌面与浏览器需要容器工作区（Docker）。" : undefined,
    };
    const row = await this.getWorkspaceContainer(agent.id);

    if (this.hasRuntimeNode(agent)) {
      // Remote: never fall through to local Docker inspect
      try {
        const { client, node } = await this.requireRunnerClient(agent);
        const ws = await client.getWorkspace(agent.id);
        if (ws?.endpoints) {
          if (row && ws.status && ws.status !== row.status) {
            await this.db
              .update(managedContainers)
              .set({ status: ws.status, updatedAt: new Date() })
              .where(eq(managedContainers.id, row.id));
          }
          const advertise = advertiseHostFromNode(node);
          return {
            ...display,
            containerStatus: ws.status ?? row?.status ?? null,
            dockerId: row?.dockerId ?? null,
            novncUrl: rewriteLoopbackUrl(ws.endpoints.novncUrl, advertise),
            novncPort: ws.endpoints.novncPort,
            cdpUrl: rewriteLoopbackUrl(ws.endpoints.cdpUrl, advertise),
            cdpPort: ws.endpoints.cdpPort,
            vncPort: null as number | null,
            width: AGENT_DESKTOP_WIDTH,
            height: AGENT_DESKTOP_HEIGHT,
          };
        }
        return {
          ...display,
          containerStatus: ws?.status ?? row?.status ?? "idle",
          dockerId: row?.dockerId ?? null,
          novncUrl: null,
          novncPort: null,
          cdpUrl: null,
          cdpPort: null,
          vncPort: null,
          width: AGENT_DESKTOP_WIDTH,
          height: AGENT_DESKTOP_HEIGHT,
        };
      } catch (error) {
        return {
          ...display,
          reason: error instanceof Error ? error.message : "运行节点不可用",
          containerStatus: row?.status ?? "offline",
          dockerId: row?.dockerId ?? null,
          novncUrl: null,
          novncPort: null,
          cdpUrl: null,
          cdpPort: null,
          vncPort: null,
          width: AGENT_DESKTOP_WIDTH,
          height: AGENT_DESKTOP_HEIGHT,
        };
      }
    }

    return {
      ...display,
      containerStatus: row?.status ?? "unbound",
      dockerId: row?.dockerId ?? null,
      novncUrl: null,
      novncPort: null,
      cdpUrl: null,
      cdpPort: null,
      vncPort: null,
      width: AGENT_DESKTOP_WIDTH,
      height: AGENT_DESKTOP_HEIGHT,
    };
  }

  async start(agent: Agent): Promise<Agent> {
    return this.withStartLock(agent.id, () => this.startUnlocked(agent, { require: "display" }));
  }

  private async startUnlocked(
    agent: Agent,
    opts: { require: "shell" | "display" } = { require: "display" },
  ): Promise<Agent> {
    const mode = resolveStackMode(agent);
    const log = (step: string, message: string, percent?: number, phase?: string) =>
      logAgentProgress(agent.id, step, message, { percent, phase });

    this.closeTunnelsForAgent(agent.id);
    beginAgentProgress(agent.id, "starting", agent.tenantId);
    log("init", "准备工作区环境", 2, "init");

    if (!this.hasRuntimeNode(agent)) {
      throw new Error("请先绑定一台电脑或服务器，再启动工作区");
    }

    if (mode === "none") {
      const { client } = await this.requireRunnerClient(agent);
      await client.mkdir(agent.id, "/");
      log("fs", "已在所选节点准备目录", 100, "ready");
      const [updated] = await this.db
        .update(agents)
        .set({ lastError: null, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      finishAgentProgress(agent.id, { ok: true, message: "就绪" });
      return updated ?? agent;
    }

    // 仅清理上次错误；不把 Agent 标成 starting/running（状态在 managedContainers）
    await this.db
      .update(agents)
      .set({ lastError: null, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    log("runner", "正在连接运行节点…", 6, "docker");
    const { client: remoteClient } = await this.requireRunnerClient(agent);
    return this.startOnRunner(agent, remoteClient, log, opts.require);
  }

  /** Start workspace container on a remote Runner Agent. */
  private async startOnRunner(
    agent: Agent,
    client: RunnerClient,
    log: (step: string, message: string, percent?: number, phase?: string) => void,
    require: "shell" | "display",
  ): Promise<Agent> {
    try {
      log("runner", "连接远程 Runner…", 10, "docker");
      const ping = await client.ping();
      if (!ping.ok) throw new Error("运行节点不可达");
      const hostWs = this.isHostWorkspace(agent);
      if (!hostWs && ping.docker && ping.docker.ok === false) {
        throw new Error(`运行节点 Docker 不可用: ${ping.docker.error || "unknown"}`);
      }
      log("runner", `节点在线${ping.docker?.version ? ` · Docker ${ping.docker.version}` : ""}`, 20);

      const tenant = await this.db.query.tenants.findFirst({
        where: eq(tenants.id, agent.tenantId),
      });
      if (!tenant) throw new Error("Tenant not found");

      // Clear local container bookkeeping if any leftover
      const existing = await this.getWorkspaceContainer(agent.id);
      if (existing) {
        await this.db
          .update(managedContainers)
          .set({ status: "removed", dockerId: null, updatedAt: new Date() })
          .where(eq(managedContainers.id, existing.id));
      }

      const mode = resolveStackMode(agent);
      // The lite image is built/pushed by CI, so remote runners can pull it the
      // same way they pull the full image.
      const image = resolveImageForMode(mode, agent.workspaceImage);
      log("container", `在所选节点启动${mode === "display" ? "电脑环境" : "精简工作区"}（${image}）…`, 40, "container");

      const ws = await client.startWorkspace({
        agentId: agent.id,
        agentSlug: agent.slug,
        tenantSlug: tenant.slug,
        image,
        network: this.config.dockerNetwork,
        workspaceKind: hostWs ? "host" : "container",
        env: {
          DISPLAY: ":99",
          ZAKURA_ENABLE_COMPUTER: mode === "display" ? "1" : "0",
          ZAKURA_ENABLE_BROWSER: mode === "display" ? "1" : "0",
          ZAKURA_DESKTOP_WIDTH: String(AGENT_DESKTOP_WIDTH),
          ZAKURA_DESKTOP_HEIGHT: String(AGENT_DESKTOP_HEIGHT),
        },
        labels: {
          "zakura.agent": agent.id,
          "zakura.agent_slug": agent.slug,
        },
      });

      const now = new Date();
      await this.db.insert(managedContainers).values({
        id: newId(),
        tenantId: agent.tenantId,
        agentId: agent.id,
        dockerId: ws.dockerId,
        name: ws.name,
        image: ws.image,
        purpose: "workspace",
        status: ws.status,
        labelsJson: JSON.stringify(ws.labels ?? {}),
        portsJson: JSON.stringify(ws.ports ?? []),
        allocatedTo: agent.id,
        runtimeNodeId: agent.runtimeNodeId,
        createdAt: now,
        updatedAt: now,
      });

      log("container", `工作区已启动 ${ws.name.slice(0, 24)}…`, 70);
      if (ws.endpoints?.novncUrl) {
        log("desktop", `noVNC: ${ws.endpoints.novncUrl}`, 90);
      }

      let running = false;
      for (let i = 0; i < 15; i++) {
        const cur = await client.getWorkspace(agent.id);
        if (cur?.status === "running") { running = true; break; }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!running) throw new Error("工作区启动超时：容器未进入 running 状态，请查看启动日志。");
      const readiness = mode === "display" ? require : "shell";
      log("readiness", readiness === "display" ? "等待桌面、VNC 和浏览器就绪…" : "等待 Shell 就绪…", 90);
      await this.waitUntilReady(agent, client, readiness);
      log("ready", "工作区就绪", 100, "ready");

      const [updated] = await this.db
        .update(agents)
        .set({ lastError: null, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      finishAgentProgress(agent.id, { ok: true, message: "工作区运行中" });
      return updated ?? agent;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentProgress(agent.id, "failed", message, { level: "error", phase: "error" });
      finishAgentProgress(agent.id, { ok: false, error: message });
      const [updated] = await this.db
        .update(agents)
        .set({ lastError: message, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      throw Object.assign(err instanceof Error ? err : new Error(message), {
        agent: updated,
      });
    }
  }

  async stop(agent: Agent, opts?: { removeContainer?: boolean }): Promise<Agent> {
    this.closeTunnelsForAgent(agent.id);
    await this.shellJobs.killAgent(agent.id);

    if (this.hasRuntimeNode(agent)) {
      // Remote-bound: only stop on Runner — never touch local Docker
      let remoteErr: unknown = null;
      try {
        // allowOffline: still try stop if endpoint exists; requireRunnerClient rejects offline by default
        if (!this.nodes) throw new Error("Runtime node service 未配置");
        const { client } = await this.nodes.requireRunnerClient(
          agent.tenantId,
          agent.runtimeNodeId!,
          { allowOffline: true },
        );
        await client.stopWorkspace(agent.id, opts?.removeContainer !== false);
      } catch (err) {
        remoteErr = err;
        recordPlatformFault("agent_ws.remote_stop", err, { subsystem: "agent_ws" });
      }
      const row = await this.getWorkspaceContainer(agent.id);
      if (row) {
        await this.db
          .update(managedContainers)
          .set({
            status: opts?.removeContainer !== false ? "removed" : "exited",
            dockerId: opts?.removeContainer !== false ? null : row.dockerId,
            updatedAt: new Date(),
          })
          .where(eq(managedContainers.id, row.id));
      }
      if (remoteErr) {
        const msg = remoteErr instanceof Error ? remoteErr.message : String(remoteErr);
        if (/离线|offline|不可用|endpoint|token|不存在/i.test(msg)) {
          const [updated] = await this.db
            .update(agents)
            .set({ lastError: msg, updatedAt: new Date() })
            .where(eq(agents.id, agent.id))
            .returning();
          throw Object.assign(
            remoteErr instanceof Error ? remoteErr : new Error(msg),
            { agent: updated },
          );
        }
      }
    } else {
      throw new Error("请先绑定一台电脑或服务器");
    }

    const [updated] = await this.db
      .update(agents)
      .set({ lastError: null, updatedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .returning();
    return updated ?? agent;
  }

  async resolveDockerId(agent: Agent): Promise<string> {
    const row = await this.getWorkspaceContainer(agent.id);
    if (!row?.dockerId) {
      throw new Error("Workspace container not running. Start the agent first.");
    }
    const { client } = await this.requireRunnerClient(agent);
    const ws = await client.getWorkspace(agent.id);
    if (!ws || ws.status !== "running") {
      throw new Error("工作区未在所选节点运行");
    }
    return row.dockerId;
  }

  async execInWorkspace(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ) {
    let workingDir = AGENT_WORKSPACE_ROOT;
    if (opts?.workingDir) {
      const raw = opts.workingDir.replace(/\\/g, "/");
      workingDir = raw.startsWith(AGENT_WORKSPACE_ROOT)
        ? raw
        : `${AGENT_WORKSPACE_ROOT}/${raw.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
    }

    const env = {
      PATH: WORKSPACE_EXEC_PATH,
      HOME: AGENT_WORKSPACE_ROOT,
      ...opts?.env,
    };

    const { client } = await this.requireRunnerClient(agent);
    return client.execWorkspace(agent.id, command, { workingDir, env, timeoutMs: opts?.timeoutMs });
  }

  private shellCwd(workingDir?: string): string {
    if (!workingDir) return AGENT_WORKSPACE_ROOT;
    const raw = workingDir.replace(/\\/g, "/");
    return raw.startsWith(AGENT_WORKSPACE_ROOT)
      ? raw
      : `${AGENT_WORKSPACE_ROOT}/${raw.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  }

  private shellEnv(extra?: Record<string, string>, interactive = false): Record<string, string> {
    const env: Record<string, string> = {
      PATH: WORKSPACE_EXEC_PATH,
      HOME: AGENT_WORKSPACE_ROOT,
      TERM: "xterm-256color",
      PYTHONUNBUFFERED: "1",
    };
    if (interactive) {
      env.COLORTERM = "truecolor";
      env.FORCE_COLOR = "1";
    } else {
      env.CI = "1";
      env.NO_COLOR = "1";
      env.FORCE_COLOR = "0";
    }
    return { ...env, ...extra };
  }

  async startShellJob(
    agent: Agent,
    command: string[],
    opts?: {
      workingDir?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      stdin?: string;
      onOutput?: (snap: ShellJobSnapshot) => void;
      interactive?: boolean;
    },
  ): Promise<ShellJobSnapshot> {
    const workingDir = this.shellCwd(opts?.workingDir);
    const env = this.shellEnv(opts?.env, opts?.interactive);
    const timeoutMs = opts?.timeoutMs;

    const { client } = await this.requireRunnerClient(agent);
    return client.startExecJob(agent.id, command, {
      workingDir,
      env,
      timeoutMs,
      stdin: opts?.stdin,
    });
  }

  async waitShellJob(
    agent: Agent,
    jobId: string,
    waitMs: number,
    opts?: { stdin?: string; onOutput?: (snap: ShellJobSnapshot) => void },
  ): Promise<ShellJobSnapshot> {
    if (this.hasRuntimeNode(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      if (opts?.onOutput) {
        void client
          .getExecJob(agent.id, jobId)
          .then((snap) => opts.onOutput?.(snap))
          .catch(() => undefined);
        const poll = setInterval(() => {
          void client
            .getExecJob(agent.id, jobId)
            .then((snap) => opts.onOutput?.(snap))
            .catch(() => undefined);
        }, 400);
        try {
          return await client.waitExecJob(agent.id, jobId, waitMs, opts.stdin);
        } finally {
          clearInterval(poll);
        }
      }
      return client.waitExecJob(agent.id, jobId, waitMs, opts?.stdin);
    }
    throw new Error("请先绑定一台电脑或服务器");
  }

  async startStdio(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<{
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
    kill: () => Promise<void>;
    /** 订阅子进程 stderr；ACP 用它诊断 fx 等启动失败（Docker mux 解复用出的 stderr）。 */
    onStderr: (fn: (chunk: string) => void) => () => void;
  }> {
    const workingDir = this.shellCwd(opts?.workingDir);
    const env = this.shellEnv(opts?.env);
    const { client } = await this.requireRunnerClient(agent);
    return client.startStdio(agent.id, command, { workingDir, env });
  }

  async getShellJob(agent: Agent, jobId: string): Promise<ShellJobSnapshot> {
    const { client } = await this.requireRunnerClient(agent);
    return client.getExecJob(agent.id, jobId);
  }

  async killShellJob(agent: Agent, jobId: string): Promise<ShellJobSnapshot> {
    const { client } = await this.requireRunnerClient(agent);
    return client.killExecJob(agent.id, jobId);
  }

  async resizeShellJob(agent: Agent, jobId: string, cols: number, rows: number): Promise<void> {
    const { client } = await this.requireRunnerClient(agent);
    await client.resizeExecJob(agent.id, jobId, cols, rows);
  }

  // ── ACP Sidecar ────────────────────────────────────────────────────────────

  private resolveAcpSidecarImage(): string {
    return (
      process.env.ZAKURA_ACP_SIDECAR_IMAGE?.trim() ||
      DEFAULT_ACP_SIDECAR_IMAGE
    );
  }

  /**
   * Ensure an ACP sidecar container is running for this agent.
   *
   * The sidecar shares the same /workspace bind mount as the workspace
   * container but uses a minimal image (node + adapter toolchain only).
   * ACP adapter processes run inside the sidecar via docker exec, keeping
   * the adapter lifecycle independent of the workspace container.
   */
  async ensureAcpSidecar(
    agent: Agent,
  ): Promise<{ dockerId: string; image: string }> {
    const { client } = await this.requireRunnerClient(agent);
    const image = this.resolveAcpSidecarImage();
    const result = await client.ensureAcpSidecar({
      agentId: agent.id,
      image,
      network: this.config.dockerNetwork,
    });
    await this.upsertManagedContainer(agent, {
      dockerId: result.dockerId,
      name: `zakura-acp-${agent.id}`.slice(0, 63),
      image: result.image,
      purpose: "acp-sidecar",
      status: result.status,
      labels: { "zakura.agent": agent.id, "zakura.purpose": "acp-sidecar" },
    });
    return { dockerId: result.dockerId, image: result.image };
  }

  /** Execute a command inside the ACP sidecar container. */
  async execInSidecar(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ) {
    const { client } = await this.requireRunnerClient(agent);
    const workingDir = this.shellCwd(opts?.workingDir);
    const env = this.shellEnv(opts?.env);
    return client.execInSidecar(agent.id, command, { workingDir, env, timeoutMs: opts?.timeoutMs });
  }

  /** Start an ACP adapter stdio session inside the sidecar. */
  async startStdioInSidecar(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<{
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
    kill: () => Promise<void>;
    onStderr: (fn: (chunk: string) => void) => () => void;
  }> {
    const { client } = await this.requireRunnerClient(agent);
    const workingDir = this.shellCwd(opts?.workingDir);
    const env = this.shellEnv(opts?.env);
    return client.startStdioInSidecar(agent.id, command, { workingDir, env });
  }

  /** Tear down the ACP sidecar for an agent. */
  async stopAcpSidecar(agent: Agent): Promise<void> {
    const { client } = await this.requireRunnerClient(agent);
    await client.stopAcpSidecar(agent.id);
  }

  // ── ACP adapter containers (one per agent × adapter) ──────────────────────

  /**
   * Pull the adapter image so a later launch cannot fail on a missing image.
   *
   * Returns true when the image was actually fetched, false when it was already
   * present. The bound runner pulls the image and streams Docker layer progress
   * back through the Hub; image contents stay on the runner.
   */
  async ensureAcpAdapterImage(
    agent: Agent,
    image: string,
    onProgress?: (line: string, event?: DockerPullEvent) => void,
    opts: { forcePull?: boolean } = {},
  ): Promise<boolean> {
    const { client } = await this.requireRunnerClient(agent);
    if (!opts.forcePull) {
      const { images } = await client.checkImageUpdates({ images: [image] });
      const row = images[0];
      if (row?.localId && !row.error) {
        onProgress?.(`镜像已在绑定设备上：${image}`, {
          status: "镜像已在绑定设备上",
          zakura: { phase: "present", image },
        });
        return false;
      }
    }
    onProgress?.(`正在绑定设备拉取 ${image}`, {
      status: `正在绑定设备拉取 ${image}`,
      zakura: { phase: "pulling", image },
    });
    await client.pullImage(image, onProgress);
    return true;
  }

  /**
   * Report which of `images` are already present on the machine that would run
   * them.
   *
   * Returns `undefined` for an image when presence cannot be determined (remote
   * runner, or an unreachable runtime). Callers must treat `undefined` as
   * unknown and never as ready — reporting a missing image as installed is the
   * bug this exists to prevent.
   */
  async acpAdapterImagePresence(
    agent: Agent,
    images: string[],
  ): Promise<Map<string, boolean | undefined>> {
    const out = new Map<string, boolean | undefined>();
    const unique = [...new Set(images.filter(Boolean))];
    if (unique.length === 0) return out;
    if (!this.hasRuntimeNode(agent)) {
      for (const image of unique) out.set(image, undefined);
      return out;
    }
    try {
      const { client } = await this.requireRunnerClient(agent);
      const { images: rows } = await client.checkImageUpdates({ images: unique });
      const byImage = new Map(rows.map((row) => [row.image, row]));
      for (const image of unique) {
        const row = byImage.get(image);
        out.set(image, Boolean(row?.localId) && !row?.error);
      }
    } catch {
      for (const image of unique) out.set(image, undefined);
    }
    return out;
  }

  /**
   * Ensure the dedicated adapter container for (agent × adapter) is running.
   *
   * Unlike the sidecar, the adapter binary is the container CMD (PID 1): we
   * never `docker exec` into it. Credentials live on a per-adapter volume
   * mounted at HOME, so one adapter's login cannot read another's.
   *
   * `sessionKey` scopes the *process*. Callers must keep at most one attach
   * alive per container — see `acpAdapterContainerName` for why a second
   * attach corrupts the JSON-RPC stream.
   */
  async ensureAcpAdapterContainer(
    agent: Agent,
    adapterId: string,
    image: string,
    sessionKey: string,
    opts?: { env?: Record<string, string>; specHash?: string },
  ): Promise<{ dockerId: string; image: string }> {
    const { client } = await this.requireRunnerClient(agent);
    const result = await client.ensureAcpAdapterContainer(agent.id, adapterId, {
      image,
      network: this.config.dockerNetwork,
      env: opts?.env,
      sessionKey,
      specHash: opts?.specHash,
    });
    await this.upsertManagedContainer(agent, {
      dockerId: result.dockerId,
      name: result.name,
      image: result.image,
      purpose: "acp-adapter",
      status: result.status,
      labels: {
        "zakura.agent": agent.id,
        "zakura.purpose": "acp-adapter",
        "zakura.adapter": adapterId,
      },
    });
    return { dockerId: result.dockerId, image: result.image };
  }

  /** Attach to the adapter container's PID 1 stdio (adapter is the CMD). */
  /**
   * Write generated config files into a running ACP adapter container.
   *
   * Uses base64 + `sh -c` rather than a bind mount because the adapter's HOME
   * lives on a per-agent credential volume the server cannot write to directly,
   * and because the content (API keys) must not touch the host filesystem.
   *
   * Adapter images are minimal — `sh` is assumed, `bash` is not.
   */
  private async stageAcpAdapterFiles(
    agent: Agent,
    dockerId: string,
    files?: { dest: string; content: string }[],
  ): Promise<void> {
    if (!files?.length) return;
    for (const file of files) {
      if (!file.dest || typeof file.content !== "string") continue;
      const b64 = Buffer.from(file.content, "utf8").toString("base64");
      // Single-quote the path for the shell; escape any embedded quote.
      const dest = `'${file.dest.replace(/'/g, `'\\''`)}'`;
      const { client } = await this.requireRunnerClient(agent);
      const res = await client.execDocker(dockerId, [
        "sh",
        "-c",
        // 0600: these files carry credentials.
        `mkdir -p "$(dirname ${dest})" && printf %s '${b64}' | base64 -d > ${dest} && chmod 600 ${dest}`,
      ]);
      if (res.exitCode !== 0) {
        // Surface loudly: a silently missing credential file is exactly the
        // failure mode this method exists to prevent.
        throw new Error(
          `failed to stage ACP adapter file ${file.dest} (exit ${res.exitCode}): ${res.stderr || res.stdout}`,
        );
      }
      log.debug("acp.adapter.file.staged", {
        agentId: agent.id,
        dest: file.dest,
        bytes: file.content.length,
      });
    }
  }

  /**
   * Seed the adapter's persistent credential volume from the durable workspace
   * directory, for users who authenticated before adapters were containerized.
   *
   * Uses `cp -n` (no-clobber): once the volume holds real credentials this is a
   * no-op, so a fresh in-container login is never overwritten by a stale copy.
   * Best-effort — a missing source dir simply means "nothing to migrate".
   */
  private async seedAcpAdapterHome(
    agent: Agent,
    dockerId: string,
    seedFrom?: string,
  ): Promise<void> {
    if (!seedFrom) return;
    const src = `'${seedFrom.replace(/'/g, `'\\''`)}'`;
    const dst = `'${ACP_ADAPTER_HOME.replace(/'/g, `'\\''`)}'`;
    const { client } = await this.requireRunnerClient(agent);
    const res = await client.execDocker(dockerId, [
      "sh",
      "-c",
      // The trailing /. copies the directory *contents* (including dotfiles).
      `[ -d ${src} ] || exit 0; mkdir -p ${dst} && cp -an ${src}/. ${dst}/ 2>/dev/null || true`,
    ]);
    log.debug("acp.adapter.home.seeded", {
      agentId: agent.id,
      seedFrom,
      exitCode: res.exitCode,
    });
  }

  async attachStdioInAcpAdapter(
    agent: Agent,
    adapterId: string,
    image: string,
    sessionKey: string,
    opts?: {
      env?: Record<string, string>;
      /**
       * Generated config files (hermes `.env`, fast-agent secrets, …) that must
       * exist *inside the adapter container* before PID 1 reads them.
       *
       * These used to be written by the workspace staging exec, which the
       * containerized path skips entirely — so file-based credentials silently
       * never arrived and the adapter came up unauthenticated ("Missing
       * Authentication header"). Env vars alone are not a substitute: several
       * adapters only read their key from a dotenv/TOML file.
       *
       * Must be staged *before* the attach: PID 1 is the adapter itself and
       * typically loads its config at startup, so a later write is too late.
       */
      files?: { dest: string; content: string }[];
      seedFrom?: string;
      /** Hash of image + launch env + generated files. */
      specHash?: string;
    },
  ): Promise<{
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
    kill: () => Promise<void>;
    onStderr: (fn: (chunk: string) => void) => () => void;
  }> {
    const { dockerId } = await this.ensureAcpAdapterContainer(
      agent,
      adapterId,
      image,
      sessionKey,
      opts,
    );
    // Seed before staging: staged config files must win over migrated copies.
    const { client } = await this.requireRunnerClient(agent);
    await this.seedAcpAdapterHome(agent, dockerId, opts?.seedFrom);
    await this.stageAcpAdapterFiles(agent, dockerId, opts?.files);
    return client.attachContainer(dockerId);
  }

  /**
   * Remove the adapter container for (agent × adapter × chat session).
   * Keeps the cred volume so the next session does not re-authenticate.
   */
  async stopAcpAdapterContainer(
    agent: Agent,
    adapterId: string,
    sessionKey: string,
  ): Promise<void> {
    const { client } = await this.requireRunnerClient(agent);
    await client
      .removeAcpAdapterContainer(agent.id, adapterId, sessionKey)
      .catch(() => undefined);
  }

  private async upsertManagedContainer(
    agent: Agent,
    row: {
      dockerId: string;
      name: string;
      image: string;
      purpose: string;
      status: string;
      labels: Record<string, string>;
    },
  ): Promise<void> {
    const now = new Date();
    const existing = await this.db
      .select()
      .from(managedContainers)
      .where(and(eq(managedContainers.agentId, agent.id), eq(managedContainers.name, row.name)));
    if (existing[0]) {
      await this.db
        .update(managedContainers)
        .set({
          dockerId: row.dockerId,
          image: row.image,
          status: row.status,
          labelsJson: JSON.stringify(row.labels),
          runtimeNodeId: agent.runtimeNodeId,
          updatedAt: now,
        })
        .where(eq(managedContainers.id, existing[0].id));
      return;
    }
    await this.db.insert(managedContainers).values({
      id: newId(),
      tenantId: agent.tenantId,
      agentId: agent.id,
      dockerId: row.dockerId,
      name: row.name,
      image: row.image,
      purpose: row.purpose,
      status: row.status,
      labelsJson: JSON.stringify(row.labels),
      portsJson: "[]",
      allocatedTo: agent.id,
      runtimeNodeId: agent.runtimeNodeId,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Remove ACP adapter containers on the agent's bound computer. */
  async removeAcpAdapterContainers(agent: Agent, adapterId: string): Promise<number> {
    if (!this.hasRuntimeNode(agent)) return 0;
    const { client } = await this.requireRunnerClient(agent);
    const n = await client.removeAcpAdapterContainers(agent.id, adapterId);
    const rows = await this.db
      .select()
      .from(managedContainers)
      .where(
        and(eq(managedContainers.agentId, agent.id), eq(managedContainers.purpose, "acp-adapter")),
      );
    for (const row of rows) {
      let labels: Record<string, string> = {};
      try {
        labels = JSON.parse(row.labelsJson || "{}") as Record<string, string>;
      } catch {
        labels = {};
      }
      if (labels["zakura.adapter"] !== adapterId) continue;
      await this.db.delete(managedContainers).where(eq(managedContainers.id, row.id));
    }
    return n;
  }

  /**
   * Open an interactive PTY *inside the adapter container* so a human can
   * complete a CLI login (`codex login`, `pi auth`, …).
   *
   * This must never fall back to the agent workspace: credentials are written
   * to the adapter's HOME, which lives on the per-(agent × adapter) cred
   * volume mounted only into this container. A shell opened anywhere else
   * would write the tokens somewhere the adapter can never read, and the user
   * would appear to log in successfully yet stay unauthenticated forever.
   *
   * Unlike `attachStdioInAcpAdapter` this is a `docker exec`, not an attach —
   * PID 1 is the adapter's JSON-RPC stream and must not be disturbed.
   */
  async startAcpAdapterLoginShell(
    agent: Agent,
    adapterId: string,
    sessionKey: string | undefined,
    opts?: {
      command?: string[];
      cols?: number;
      rows?: number;
      onOutput?: (snap: ShellJobSnapshot) => void;
    },
  ): Promise<ShellJobSnapshot> {
    // Deliberately NOT a login shell. `/etc/profile` in the adapter images
    // hard-assigns PATH="/usr/local/sbin:...:/bin", which drops
    // `/opt/zakura/acp/bin` — exactly where the adapter CLI lives. A `-l`
    // shell therefore lands the user in a prompt where `codex`/`opencode`/etc.
    // are "command not found". `-i` keeps the interactive niceties (prompt,
    // history, aliases) without sourcing the PATH-clobbering profile.
    const command = opts?.command?.length
      ? opts.command
      : ["/bin/sh", "-c", "exec /bin/bash -i || exec /bin/sh -i"];

    const { client } = await this.requireRunnerClient(agent);
    return client.startAcpAdapterLoginShell(agent.id, adapterId, {
      sessionKey,
      command,
      cols: opts?.cols,
      rows: opts?.rows,
    });
  }

  /**
   * Remove every managed adapter container for this tenant.
   *
   * Adapter containers are session-scoped and normally removed by `teardown`.
   * That never runs if the server is killed, so a crash leaves one orphan per
   * live session behind — they hold a stdin-open PID 1 forever and nothing
   * else will ever reclaim them (the in-memory `byChat` map that knew about
   * them died with the process). Sweeping at boot is the only reliable
   * reclamation point. Cred volumes are keyed by (agent × adapter) and are
   * deliberately left intact so the next session skips re-authentication.
   */
  async sweepOrphanedAcpAdapterContainers(_tenantId: string): Promise<number> {
    // 容器生命周期在各节点的 Go 代理上，控制面不再扫本机 Docker。
    return 0;
  }
}
