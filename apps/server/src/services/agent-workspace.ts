import { and, eq } from "drizzle-orm";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  RunnerClient,
  ShellJobRegistry,
  ensureWorkspaceDir,
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
  LOCAL_RUNTIME_NODE_ID,
  WORKSPACE_IMAGE_LOCAL,
  acpDurableDir,
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
import type { DockerRuntime, TcpTunnel } from "../runtime/docker.js";
import {
  beginAgentProgress,
  finishAgentProgress,
  logAgentProgress,
} from "./agent-progress.js";
import { type RuntimeNodeService } from "./runtime-nodes.js";

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

function workspaceContainerName(tenantSlug: string, agentSlug: string): string {
  return `zakura-ws-${tenantSlug}-${agentSlug}`
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 63);
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

function resolveWorkspaceDockerContext(): string | null {
  const fromEnv = process.env.ZAKURA_WORKSPACE_DOCKER_DIR?.trim();
  if (fromEnv && existsSync(join(fromEnv, "Dockerfile"))) return fromEnv;
  const candidates = [
    join(process.cwd(), "docker", "workspace"),
    join(process.cwd(), "..", "docker", "workspace"),
    join(process.cwd(), "..", "..", "docker", "workspace"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "Dockerfile"))) return c;
  }
  return null;
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
  private readonly mountValid = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly runtime: DockerRuntime,
    private readonly config: AppConfig,
    private readonly nodes?: RuntimeNodeService,
  ) {}

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
    return this.withStartLock(agent.id, async () => {
      if (await this.isWorkspaceRunning(agent)) return agent;
      return this.startUnlocked(agent, { require });
    });
  }

  hostRoot(agent: Agent): string {
    return agentWorkspaceHostPath(this.config, agent.id);
  }

  ensureLocal(agent: Agent): string {
    const root = this.hostRoot(agent);
    ensureWorkspaceDir(root);
    return root;
  }

  /** True when agent is bound to a remote runner (not local/null). */
  isRemoteAgent(agent: Agent): boolean {
    const id = agent.runtimeNodeId;
    return Boolean(id && id !== LOCAL_RUNTIME_NODE_ID);
  }

  private async requireRunnerClient(
    agent: Agent,
  ): Promise<{ client: RunnerClient; node: RuntimeNode }> {
    if (!this.isRemoteAgent(agent)) {
      throw new Error("当前电脑未绑定远程运行节点");
    }
    if (!this.nodes) {
      throw new Error("运行节点服务不可用，请稍后重试");
    }
    return this.nodes.requireRunnerClient(agent.tenantId, agent.runtimeNodeId!);
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

  private async ensureTunnel(agentId: string, dockerId: string, containerPort: number): Promise<TcpTunnel> {
    const key = `${agentId}:${containerPort}`;
    const existing = this.tunnels.get(key);
    if (existing) {
      if (containerPort === AGENT_PORT_CDP) {
        if (await this.probeHttp(`${existing.url}/json/version`, 1200)) return existing;
        existing.close();
        this.tunnels.delete(key);
      } else {
        return existing;
      }
    }
    const tunnel = await this.runtime.openTcpTunnel(dockerId, containerPort);
    this.tunnels.set(key, tunnel);
    return tunnel;
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
    const row = await this.getWorkspaceContainer(agentId);
    // Remote runner: only use Runner endpoints — never local docker sock
    {
      const agentRow = await this.db.query.agents.findFirst({
        where: eq(agents.id, agentId),
      });
      if (agentRow && this.isRemoteAgent(agentRow)) {
        try {
          const { client, node } = await this.requireRunnerClient(agentRow);
          const ws = await client.getWorkspace(agentId).catch(() => null);
          const advertise = advertiseHostFromNode(node);
          const cdp = rewriteLoopbackUrl(ws?.endpoints?.cdpUrl ?? null, advertise);
          if (cdp && (await this.probeHttp(`${cdp}/json/version`))) {
            return {
              url: cdp,
              reason: "ok",
              containerStatus: ws?.status ?? row?.status ?? null,
              chromeInside: true,
            };
          }
          return {
            url: cdp,
            reason: cdp
              ? "远程 CDP 已发布但探测失败，请检查 Runner 的 ZAKURA_RUNNER_PUBLIC_HOST"
              : "远程工作区未提供 CDP 端口",
            containerStatus: ws?.status ?? row?.status ?? null,
            chromeInside: Boolean(cdp),
          };
        } catch (err) {
          return {
            url: null,
            reason: err instanceof Error ? err.message : "远程运行节点不可用",
            containerStatus: row?.status ?? "offline",
            chromeInside: false,
          };
        }
      }
    }

    if (!row?.dockerId) {
      return {
        url: null,
        reason: "工作区容器未启动。请先在控制台「工作区」页启动环境，并确认已开启浏览器能力。",
        containerStatus: null,
        chromeInside: false,
      };
    }

    const live = await this.runtime.inspect(row.dockerId).catch(() => null);
    if (!live || live.status !== "running") {
      return {
        url: null,
        reason: "工作区容器未在运行。请重新启动 Agent 工作区。",
        containerStatus: live?.status ?? row.status,
        chromeInside: false,
      };
    }

    let portsJson = JSON.stringify(live.ports);
    try {
      if (JSON.stringify(live.ports) !== row.portsJson) {
        await this.db
          .update(managedContainers)
          .set({ portsJson, status: live.status, updatedAt: new Date() })
          .where(eq(managedContainers.id, row.id));
      }
    } catch {
      /* ignore */
    }

    const published = this.getDesktopEndpoints(portsJson).cdpUrl;
    if (published && (await this.probeHttp(`${published}/json/version`))) {
      return {
        url: published,
        reason: "ok",
        containerStatus: live.status,
        chromeInside: true,
      };
    }

    let chromeInside = await this.probeChromeInside(row.dockerId);
    if (!chromeInside) {
      await this.tryStartChromeInside(row.dockerId);
      chromeInside = await this.probeChromeInside(row.dockerId);
    }

    if (!chromeInside) {
      const logTail = await this.runtime
        .exec(row.dockerId, [
          "bash",
          "-lc",
          "tail -n 40 /var/log/zakura/chrome.log 2>/dev/null || echo '(no chrome.log)'",
        ])
        .catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
      const hint = (logTail.stdout || "").trim().slice(0, 600);
      return {
        url: null,
        reason: `容器内 Chrome/CDP 未就绪。可查看工作区日志后重试启动。${hint ? ` 日志片段: ${hint}` : ""}`,
        containerStatus: live.status,
        chromeInside: false,
      };
    }

    try {
      const tunnel = await this.ensureTunnel(agentId, row.dockerId, AGENT_PORT_CDP);
      if (await this.probeHttp(`${tunnel.url}/json/version`, 2500)) {
        return {
          url: tunnel.url,
          reason: "ok",
          containerStatus: live.status,
          chromeInside: true,
        };
      }
      return {
        url: null,
        reason: `已检测到容器内 CDP，但主机隧道探测失败（${tunnel.url}）。请确认容器内已安装 socat。`,
        containerStatus: live.status,
        chromeInside: true,
      };
    } catch (err) {
      recordPlatformFault("agent_ws.cdp_tunnel", err, { subsystem: "agent_ws" });
      return {
        url: null,
        reason: `CDP 隧道建立失败: ${err instanceof Error ? err.message : String(err)}`,
        containerStatus: live.status,
        chromeInside: true,
      };
    }
  }

  private async probeChromeInside(dockerId: string): Promise<boolean> {
    const inside = await this.runtime.exec(dockerId, [
      "bash",
      "-lc",
      "curl -sf -m 2 http://127.0.0.1:9222/json/version >/dev/null && echo ok",
    ]);
    return inside.stdout.includes("ok");
  }

  /** Best-effort: wait briefly for entrypoint chrome; do not apt-install. */
  private async tryStartChromeInside(dockerId: string): Promise<void> {
    const script = [
      "export DISPLAY=:99",
      "for i in $(seq 1 8); do",
      "  curl -sf -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && exit 0",
      "  sleep 1",
      "done",
      "exit 1",
    ].join("\n");

    await this.runtime
      .exec(dockerId, ["bash", "-lc", script], { workingDir: "/" })
      .catch((err) => {
        recordPlatformFault("agent_ws.chrome_start", err, { subsystem: "agent_ws" });
      });
  }

  /**
   * 轻量桌面信息：仅同步端口映射与已有隧道，不做 CDP/Chrome 恢复。
   * 详情页与轮询会频繁调用；恢复逻辑留在 resolveCdp（工具实际使用时）。
   * 远程 Runner：从 Runner endpoints API 读取 noVNC/CDP。
   */
  async getDesktopInfo(agent: Agent) {
    const computerOn = Boolean(agent.enableComputer);
    const row = await this.getWorkspaceContainer(agent.id);

    if (this.isRemoteAgent(agent)) {
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
            enabled: computerOn,
            computer: computerOn,
            browser: computerOn,
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
          enabled: computerOn,
          computer: computerOn,
          browser: computerOn,
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
      } catch {
        return {
          enabled: computerOn,
          computer: computerOn,
          browser: computerOn,
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

    let portsJson = row?.portsJson ?? null;
    let containerStatus = row?.status ?? null;

    if (row?.dockerId) {
      try {
        const live = await this.runtime.inspect(row.dockerId);
        if (live) {
          portsJson = JSON.stringify(live.ports);
          containerStatus = live.status;
          if (JSON.stringify(live.ports) !== row.portsJson || live.status !== row.status) {
            await this.db
              .update(managedContainers)
              .set({
                portsJson,
                status: live.status,
                updatedAt: new Date(),
              })
              .where(eq(managedContainers.id, row.id));
          }
        } else {
          containerStatus = "exited";
        }
      } catch {
        /* Docker 不可用时仍返回 DB 中的端口信息 */
      }
    }

    const endpoints = this.getDesktopEndpoints(portsJson);
    let { novncUrl, novncPort, cdpUrl, cdpPort } = endpoints;

    // 仅复用已建立的隧道，避免在详情接口里 openTcpTunnel / 等 Chrome
    const novncTunnel = this.tunnels.get(`${agent.id}:${AGENT_PORT_NOVNC}`);
    if (novncTunnel && !novncUrl) {
      novncPort = novncTunnel.port;
      novncUrl = `${novncTunnel.url}/vnc.html?autoconnect=true&resize=scale&password=`;
    }
    const cdpTunnel = this.tunnels.get(`${agent.id}:${AGENT_PORT_CDP}`);
    if (cdpTunnel && !cdpUrl) {
      cdpUrl = cdpTunnel.url;
      cdpPort = cdpTunnel.port;
    }

    return {
      enabled: computerOn,
      computer: computerOn,
      browser: computerOn,
      containerStatus,
      dockerId: row?.dockerId ?? null,
      ...endpoints,
      novncUrl,
      novncPort,
      cdpUrl,
      cdpPort,
      width: endpoints.width,
      height: endpoints.height,
    };
  }

  async start(agent: Agent): Promise<Agent> {
    return this.withStartLock(agent.id, () => this.startUnlocked(agent, { require: "display" }));
  }

  private async startUnlocked(
    agent: Agent,
    opts: { require: "shell" | "display" } = { require: "display" },
  ): Promise<Agent> {
    const require = opts.require;
    const mode = resolveStackMode(agent);
    const log = (step: string, message: string, percent?: number, phase?: string) =>
      logAgentProgress(agent.id, step, message, { percent, phase });

    this.closeTunnelsForAgent(agent.id);
    beginAgentProgress(agent.id, "starting", agent.tenantId);
    log("init", "准备工作区环境", 2, "init");

    if (mode === "none") {
      // Local-only fs without computer stack
      if (!this.isRemoteAgent(agent)) this.ensureLocal(agent);
      log("fs", "无需容器（仅本地文件系统或未启用 Shell/浏览器/桌面）", 100, "ready");
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

    if (this.isRemoteAgent(agent)) {
      log("runner", "正在连接远程运行节点…", 6, "docker");
      const { client: remoteClient } = await this.requireRunnerClient(agent);
      return this.startOnRunner(agent, remoteClient, log);
    }

    const root = this.ensureLocal(agent);

    try {
      log("docker", "检查 Docker…", 8, "docker");
      const ping = await this.runtime.ping();
      if (!ping.ok) {
        throw new Error(`Docker 不可用: ${ping.error}`);
      }
      log("docker", `Docker ${ping.version}`, 12);

      const tenant = await this.db.query.tenants.findFirst({
        where: eq(tenants.id, agent.tenantId),
      });
      if (!tenant) throw new Error("Tenant not found");

      log("network", "确保网络…", 18, "network");
      await this.runtime.ensureNetwork(this.config.dockerNetwork);

      let image = resolveImageForMode(mode, agent.workspaceImage);
      const name = workspaceContainerName(tenant.slug, agent.slug);

      if (agent.workspaceImage !== image) {
        await this.db
          .update(agents)
          .set({ workspaceImage: image, updatedAt: new Date() })
          .where(eq(agents.id, agent.id));
        log("image", `使用镜像 ${image}`, 20);
      } else {
        log("image", `使用镜像 ${image}`, 20);
      }

      log("cleanup", "清理旧容器…", 22, "cleanup");
      const existing = await this.getWorkspaceContainer(agent.id);
      if (existing?.dockerId) {
        this.mountValid.delete(existing.dockerId);
        try {
          await this.runtime.stop(existing.dockerId);
          await this.runtime.remove(existing.dockerId, true);
        } catch {
          /* ignore */
        }
        await this.db
          .update(managedContainers)
          .set({ status: "removed", dockerId: null, updatedAt: new Date() })
          .where(eq(managedContainers.id, existing.id));
      }

      const listed = await this.runtime.list({
        tenantId: agent.tenantId,
        purpose: "workspace",
      });
      for (const c of listed) {
        if (c.name === name || c.labels["zakura.agent"] === agent.id) {
          await this.runtime.remove(c.id, true);
        }
      }

      mkdirSync(root, { recursive: true });
      log("image", `确保工作区镜像 ${image}…`, 30, "image");
      image = await this.ensurePrebakedWorkspaceImage(image, (msg) =>
        log("image", msg, 35, "image"),
      );
      log("image", "镜像就绪", 45);

      const ports =
        mode === "display"
          ? [
              { containerPort: AGENT_PORT_NOVNC, protocol: "tcp" as const },
              {
                containerPort: AGENT_PORT_CDP,
                protocol: "tcp" as const,
                hostIp: "127.0.0.1",
              },
            ]
          : [];

      log("container", mode === "display"
        ? "启动电脑环境（文件 + Shell + 浏览器 + 桌面）…"
        : "启动精简工作区（文件 + Shell）…", 55, "container");

      const isDisplay = mode === "display";
      const containerEnv: Record<string, string> = {
        ZAKURA_AGENT_ID: agent.id,
        ZAKURA_AGENT_SLUG: agent.slug,
        HOME: AGENT_WORKSPACE_ROOT,
        PATH: WORKSPACE_EXEC_PATH,
      };
      if (isDisplay) {
        containerEnv.ZAKURA_ENABLE_BROWSER = "1";
        containerEnv.ZAKURA_ENABLE_COMPUTER = "1";
        containerEnv.ZAKURA_DESKTOP_WIDTH = String(AGENT_DESKTOP_WIDTH);
        containerEnv.ZAKURA_DESKTOP_HEIGHT = String(AGENT_DESKTOP_HEIGHT);
        containerEnv.DISPLAY = ":99";
      }

      const running = await this.runtime.createAndStart({
        tenantId: agent.tenantId,
        purpose: "workspace",
        allocatedTo: agent.id,
        spec: {
          name,
          image,
          purpose: "workspace",
          workingDir: AGENT_WORKSPACE_ROOT,
          network: this.config.dockerNetwork,
          restartPolicy: "unless-stopped",
          ports,
          volumes: [
            {
              hostPath: agentWorkspaceBindSource(this.config, agent.id),
              containerPath: AGENT_WORKSPACE_ROOT,
            },
          ],
          env: containerEnv,
          labels: {
            "zakura.agent": agent.id,
            "zakura.agent_slug": agent.slug,
            "zakura.stack": mode,
            ...(isDisplay ? { "zakura.feat.computer": "true" } : {}),
          },
        },
      });

      const now = new Date();
      await this.db.insert(managedContainers).values({
        id: newId(),
        tenantId: agent.tenantId,
        agentId: agent.id,
        dockerId: running.id,
        name: running.name,
        image: running.image,
        purpose: "workspace",
        status: running.status,
        labelsJson: JSON.stringify(running.labels),
        portsJson: JSON.stringify(running.ports),
        allocatedTo: agent.id,
        runtimeNodeId: agent.runtimeNodeId,
        createdAt: now,
        updatedAt: now,
      });
      log("container", `工作区容器已启动 ${running.name.slice(0, 24)}…`, 65);

      // Split readiness: every stack signals .shell-ready once /workspace is
      // mounted and the toolchain is usable. Only callers that actually
      // consume the desktop (computer-use, noVNC proxy) block on display-ready.
      // ACP coding agents (claude-code, codex, opencode, …) go through stdio
      // and pass require:"shell" so they start as soon as the toolchain is
      // up; Chrome keeps booting in the background.
      log("packages", "等待工作区就绪…", 70, "packages");
      await this.waitWorkspaceReady(running.id, 30_000, "shell-ready", (p, msg) =>
        log("packages", msg, p),
      );
      if (mode === "display" && require === "display") {
        log("packages", "等待显示/浏览器就绪…", 75, "packages");
        await this.waitDesktopReady(running.id, agent, 90_000, (p, msg) =>
          log("packages", msg, p),
        );
      }

      const [updated] = await this.db
        .update(agents)
        .set({
          lastError: null,
          updatedAt: new Date(),
        })
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

  private async ensurePrebakedWorkspaceImage(
    image: string,
    onLog?: (msg: string) => void,
  ): Promise<string> {
    if (await this.runtime.hasImage(image)) {
      onLog?.("本地镜像已存在");
      return image;
    }

    try {
      onLog?.(`尝试拉取 ${image}…`);
      await this.runtime.ensureImage(image);
      return image;
    } catch (err) {
      onLog?.(
        `拉取失败（${err instanceof Error ? err.message : String(err)}）`,
      );
    }

    // If this is a lite or sidecar image that doesn't exist yet, fall back to
    // the full workspace image which is always available (it's a superset).
    const isLiteOrSidecar =
      /workspace-lite|acp-sidecar/i.test(image);
    if (isLiteOrSidecar) {
      const fallback = resolveWorkspaceImage(null);
      onLog?.(`${image} 不可用，回退到 ${fallback}`);
      return this.ensurePrebakedWorkspaceImage(fallback, onLog);
    }

    const contextDir = resolveWorkspaceDockerContext();
    if (!contextDir) {
      throw new Error(
        `未找到 docker/workspace/Dockerfile。请先运行: docker build -t ${image} docker/workspace\n` +
          `或设置 ZAKURA_WORKSPACE_DOCKER_DIR 指向该目录。`,
      );
    }

    onLog?.(`本地构建 ${image}（首次约数分钟）…`);
    const mirror = (this.config.aptMirror || "https://mirrors.aliyun.com").replace(/\/$/, "");
    await this.runtime.buildImage({
      tag: image,
      contextDir,
      buildArgs: { APT_MIRROR: mirror },
      onProgress: (line) => {
        if (/^(Step |#\d+|Using apt|Fetched |Setting up chromium)/i.test(line)) {
          onLog?.(line.slice(0, 120));
        }
      },
    });
    if (!(await this.runtime.hasImage(image))) {
      throw new Error(`本地构建完成但未找到镜像 ${image}`);
    }
    onLog?.("本地构建完成");
    return image;
  }

  private async waitWorkspaceReady(
    dockerId: string,
    timeoutMs: number,
    marker: "shell-ready" | "display-ready",
    onTick?: (percent: number, message: string) => void,
  ) {
    const start = Date.now();
    let ticks = 0;
    // Prefer the readiness marker touched by entrypoint.sh (fast, one exec per
    // poll). Fall back to /workspace existence so older images without the
    // marker still resolve instead of timing out.
    const file = marker === "display-ready" ? ".display-ready" : ".shell-ready";
    while (Date.now() - start < timeoutMs) {
      ticks += 1;
      const pct = Math.min(95, 40 + Math.floor(((Date.now() - start) / timeoutMs) * 55));
      try {
        const check = await this.runtime.exec(dockerId, [
          "bash",
          "-lc",
          `[ -e /var/lib/zakura-features/${file} ] && echo ready || { [ -d ${AGENT_WORKSPACE_ROOT} ] && echo legacy; }`,
        ]);
        if (check.stdout.includes("ready")) {
          onTick?.(98, marker === "display-ready" ? "桌面就绪" : "工作区就绪");
          return;
        }
        if (ticks % 3 === 0) onTick?.(pct, "等待工作区就绪…");
      } catch {
        if (ticks % 3 === 0) onTick?.(pct, "探测中…");
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Timeout is non-fatal: the container keeps running and may still become
    // ready in the background. Bail out so callers proceed rather than hang.
    onTick?.(96, "工作区就绪探测超时，容器可能仍在后台继续");
  }

  private async waitDesktopReady(
    dockerId: string,
    _agent: Agent,
    timeoutMs: number,
    onTick?: (percent: number, message: string) => void,
  ) {
    const start = Date.now();
    let ticks = 0;
    while (Date.now() - start < timeoutMs) {
      ticks += 1;
      const elapsed = Date.now() - start;
      const pct = Math.min(95, 75 + Math.floor((elapsed / timeoutMs) * 20));
      try {
        // Prefer the entrypoint's .display-ready marker (touched right after
        // the Chrome CDP loop). Fall back to a direct CDP probe so images
        // built before the marker still resolve.
        const check = await this.runtime.exec(dockerId, [
          "bash",
          "-lc",
          `[ -e /var/lib/zakura-features/.display-ready ] && echo ready || { curl -sf -m 2 http://127.0.0.1:9222/json/version >/dev/null && echo ok; }`,
        ]);
        if (check.stdout.includes("ready") || check.stdout.includes("ok")) {
          onTick?.(98, "浏览器 CDP 就绪");
          return;
        }
        if (ticks % 3 === 0) onTick?.(pct, "等待 Chrome / 桌面就绪…");
      } catch {
        if (ticks % 3 === 0) onTick?.(pct, "探测中…");
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    onTick?.(96, "依赖安装超时，容器可能仍在后台继续");
    recordPlatformFault("agent_ws.feature_ready_timeout", undefined, {
      subsystem: "agent_ws",
    });
  }

  /** Start workspace container on a remote Runner Agent. */
  private async startOnRunner(
    agent: Agent,
    client: RunnerClient,
    log: (step: string, message: string, percent?: number, phase?: string) => void,
  ): Promise<Agent> {
    try {
      log("runner", "连接远程 Runner…", 10, "docker");
      const ping = await client.ping();
      if (!ping.ok) throw new Error("远程 Runner 不可达");
      if (ping.docker && ping.docker.ok === false) {
        throw new Error(`远程 Docker 不可用: ${ping.docker.error || "unknown"}`);
      }
      log("runner", `Runner 在线${ping.docker?.version ? ` · Docker ${ping.docker.version}` : ""}`, 20);

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
      log("container", `在远程 Runner 启动${mode === "display" ? "电脑环境" : "精简工作区"}（${image}）…`, 40, "container");

      const ws = await client.startWorkspace({
        agentId: agent.id,
        agentSlug: agent.slug,
        tenantSlug: tenant.slug,
        image,
        network: this.config.dockerNetwork,
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

      log("container", `远程工作区已启动 ${ws.name.slice(0, 24)}…`, 70);
      if (ws.endpoints?.novncUrl) {
        log("desktop", `noVNC: ${ws.endpoints.novncUrl}`, 90);
      }

      // Soft wait: poll remote for running status
      for (let i = 0; i < 15; i++) {
        const cur = await client.getWorkspace(agent.id);
        if (cur?.status === "running") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      log("ready", "远程电脑环境就绪", 100, "ready");

      const [updated] = await this.db
        .update(agents)
        .set({ lastError: null, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning();
      finishAgentProgress(agent.id, { ok: true, message: "远程工作区运行中" });
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

    if (this.isRemoteAgent(agent)) {
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
      const row = await this.getWorkspaceContainer(agent.id);
      if (row?.dockerId) {
        this.mountValid.delete(row.dockerId);
        try {
          await this.runtime.stop(row.dockerId);
          if (opts?.removeContainer !== false) {
            await this.runtime.remove(row.dockerId, true);
            await this.db
              .update(managedContainers)
              .set({ status: "removed", dockerId: null, updatedAt: new Date() })
              .where(eq(managedContainers.id, row.id));
          } else {
            await this.db
              .update(managedContainers)
              .set({ status: "exited", updatedAt: new Date() })
              .where(eq(managedContainers.id, row.id));
          }
        } catch (err) {
          recordPlatformFault("agent_ws.stop", err, { subsystem: "agent_ws" });
        }
      }
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
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      const ws = await client.getWorkspace(agent.id);
      if (!ws || ws.status !== "running") {
        throw new Error("Remote workspace container is not running");
      }
      return row.dockerId;
    }
    const live = await this.runtime.inspect(row.dockerId);
    if (!live || live.status !== "running") {
      throw new Error("Workspace container is not running");
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

    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      return client.execWorkspace(agent.id, command, { workingDir, env, timeoutMs: opts?.timeoutMs });
    }

    const dockerId = await this.resolveDockerId(agent);
    const root = this.hostRoot(agent);
    if (!existsSync(root)) {
      this.ensureLocal(agent);
      throw new Error(
        `工作区主机目录丢失并已重建为空目录。请重启电脑环境以重新挂载 ${AGENT_WORKSPACE_ROOT}。`,
      );
    }
    // Skip the per-call mount probe when we already validated this container:
    // the bind mount cannot vanish while the same container keeps running.
    // This removes one docker exec round trip from every execInWorkspace call.
    if (!this.mountValid.has(dockerId)) {
      const probe = await this.runtime.exec(dockerId, ["test", "-d", AGENT_WORKSPACE_ROOT], {
        workingDir: "/",
      });
      if (probe.exitCode !== 0) {
        throw new Error(
          `工作区挂载已失效（无法访问 ${AGENT_WORKSPACE_ROOT}）。主机目录可能被删除，请在控制台重启电脑环境。`,
        );
      }
      this.mountValid.add(dockerId);
    }
    return this.runtime.exec(dockerId, command, {
      workingDir,
      env,
      timeoutMs: opts?.timeoutMs,
    });
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

    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      const snap = await client.startExecJob(agent.id, command, {
        workingDir,
        env,
        timeoutMs,
        stdin: opts?.stdin,
      });
      return snap;
    }

    const dockerId = await this.resolveDockerId(agent);
    const job = await this.runtime.execJob(dockerId, command, {
      agentId: agent.id,
      workingDir,
      env,
      stdin: opts?.stdin,
    });
    this.shellJobs.add(job);
    job.setOnOutput((snap) => {
      opts?.onOutput?.(snap);
      if (!snap.running) {
        setTimeout(() => this.shellJobs.remove(job.id), 10 * 60 * 1000);
      }
    });
    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => {
        if (job.snapshot().running) void job.kill();
      }, timeoutMs);
    }
    return job.snapshot();
  }

  async waitShellJob(
    agent: Agent,
    jobId: string,
    waitMs: number,
    opts?: { stdin?: string; onOutput?: (snap: ShellJobSnapshot) => void },
  ): Promise<ShellJobSnapshot> {
    if (this.isRemoteAgent(agent)) {
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
    const job = this.shellJobs.getForAgent(agent.id, jobId);
    if (!job) throw new Error("Shell job not found");
    if (opts?.onOutput) {
      opts.onOutput(job.snapshot());
      job.setOnOutput((snap) => {
        opts.onOutput?.(snap);
        if (!snap.running) {
          setTimeout(() => this.shellJobs.remove(job.id), 10 * 60 * 1000);
        }
      });
    }
    if (opts?.stdin) job.write(opts.stdin);
    return job.wait(waitMs);
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
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      return client.startStdio(agent.id, command, { workingDir, env });
    }
    const dockerId = await this.resolveDockerId(agent);
    const job = await this.runtime.execStdio(dockerId, command, { workingDir, env });
    const streams = job.toWebStreams();
    return {
      ...streams,
      kill: () => job.kill(),
      onStderr: (fn) => job.onStderr(fn),
    };
  }

  async getShellJob(agent: Agent, jobId: string): Promise<ShellJobSnapshot> {
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      return client.getExecJob(agent.id, jobId);
    }
    const job = this.shellJobs.getForAgent(agent.id, jobId);
    if (!job) throw new Error("Shell job not found");
    return job.snapshot();
  }

  async killShellJob(agent: Agent, jobId: string): Promise<ShellJobSnapshot> {
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      return client.killExecJob(agent.id, jobId);
    }
    const job = this.shellJobs.getForAgent(agent.id, jobId);
    if (!job) throw new Error("Shell job not found");
    await job.kill();
    return job.snapshot();
  }

  async resizeShellJob(agent: Agent, jobId: string, cols: number, rows: number): Promise<void> {
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      await client.resizeExecJob(agent.id, jobId, cols, rows);
      return;
    }
    const job = this.shellJobs.getForAgent(agent.id, jobId);
    if (!job) throw new Error("Shell job not found");
    await job.resize(cols, rows);
  }

  // ── ACP Sidecar ────────────────────────────────────────────────────────────

  private acpSidecarName(agentId: string): string {
    return `zakura-acp-${agentId}`.slice(0, 63);
  }

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
    const name = this.acpSidecarName(agent.id);

    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      const image = this.resolveAcpSidecarImage();
      const result = await client.ensureAcpSidecar({
        agentId: agent.id,
        image,
        network: this.config.dockerNetwork,
      });
      return { dockerId: result.dockerId, image };
    }

    // Check if sidecar is already running
    const existing = await this.runtime.list({
      tenantId: agent.tenantId,
      purpose: "acp-sidecar",
    });
    const running = existing.find(
      (c) => c.labels["zakura.agent"] === agent.id && c.status === "running",
    );
    if (running) return { dockerId: running.id, image: running.image };

    // Clean up any stopped sidecars
    for (const c of existing) {
      if (c.labels["zakura.agent"] === agent.id) {
        await this.runtime.remove(c.id, true).catch(() => undefined);
      }
    }

    const requestedImage = this.resolveAcpSidecarImage();
    const image = await this.ensurePrebakedWorkspaceImage(requestedImage, () => {});

    const result = await this.runtime.createAndStart({
      tenantId: agent.tenantId,
      purpose: "acp-sidecar",
      allocatedTo: agent.id,
      spec: {
        name,
        image,
        purpose: "acp-sidecar",
        workingDir: AGENT_WORKSPACE_ROOT,
        network: this.config.dockerNetwork,
        restartPolicy: "unless-stopped",
        ports: [],
        volumes: [
          {
            hostPath: agentWorkspaceBindSource(this.config, agent.id),
            containerPath: AGENT_WORKSPACE_ROOT,
          },
        ],
        env: {
          ZAKURA_AGENT_ID: agent.id,
          HOME: AGENT_WORKSPACE_ROOT,
          PATH: WORKSPACE_EXEC_PATH,
        },
        labels: {
          "zakura.agent": agent.id,
          "zakura.purpose": "acp-sidecar",
          "zakura.managed": "true",
        },
      },
    });

    return { dockerId: result.id, image: result.image };
  }

  /** Execute a command inside the ACP sidecar container. */
  async execInSidecar(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ) {
    const { dockerId } = await this.ensureAcpSidecar(agent);
    const workingDir = this.shellCwd(opts?.workingDir);
    const env = this.shellEnv(opts?.env);
    return this.runtime.exec(dockerId, command, {
      workingDir,
      env,
      timeoutMs: opts?.timeoutMs,
    });
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
    const { dockerId } = await this.ensureAcpSidecar(agent);
    const workingDir = this.shellCwd(opts?.workingDir);
    const env = this.shellEnv(opts?.env);
    const job = await this.runtime.execStdio(dockerId, command, { workingDir, env });
    const streams = job.toWebStreams();
    return {
      ...streams,
      kill: () => job.kill(),
      onStderr: (fn) => job.onStderr(fn),
    };
  }

  /** Tear down the ACP sidecar for an agent. */
  async stopAcpSidecar(agent: Agent): Promise<void> {
    if (this.isRemoteAgent(agent)) return;
    const existing = await this.runtime.list({
      tenantId: agent.tenantId,
      purpose: "acp-sidecar",
    });
    for (const c of existing) {
      if (c.labels["zakura.agent"] === agent.id) {
        await this.runtime.stop(c.id).catch(() => undefined);
        await this.runtime.remove(c.id, true).catch(() => undefined);
      }
    }
  }

  // ── ACP adapter containers (one per agent × adapter) ──────────────────────

  private acpAdapterContainerName(
    agentId: string,
    adapterId: string,
    sessionKey: string,
  ): string {
    // NOTE: the container is scoped per *chat session*, not per agent × adapter.
    //
    // The adapter is PID 1 and we talk to it over `docker attach`. Docker
    // broadcasts PID 1's stdout to every attached client and merges all
    // attached stdins into one pipe — verified empirically: two attaches to the
    // same container both received the *same* JSON-RPC reply, and interleaved
    // writes produced a `Parse error`. So one container can serve exactly one
    // JSON-RPC peer until the adapter itself multiplexes by `sessionId`
    // (Phase 3, one-process-multi-session).
    //
    // Credentials are still shared per agent × adapter via `acpAdapterCredVolume`,
    // so this only costs process isolation, not re-authentication.
    const short = sessionKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    return `zakura-acpa-${adapterId}-${agentId}-${short}`
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 63);
  }

  /**
   * Ensure the dedicated adapter container for (agent × adapter × chat session)
   * is running.
   *
   * Unlike the sidecar, the adapter binary is the container CMD (PID 1): we
   * never `docker exec` into it. Credentials live on a per-adapter volume
   * mounted at HOME, so one adapter's login cannot read another's.
   *
   * `sessionKey` scopes the *process*, not the credentials — see
   * `acpAdapterContainerName` for why sharing one PID 1 across chat sessions
   * corrupts the JSON-RPC stream.
   */
  async ensureAcpAdapterContainer(
    agent: Agent,
    adapterId: string,
    image: string,
    sessionKey: string,
    opts?: { env?: Record<string, string> },
  ): Promise<{ dockerId: string; image: string }> {
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      const result = await client.ensureAcpAdapterContainer(agent.id, adapterId, {
        image,
        network: this.config.dockerNetwork,
        env: opts?.env,
        sessionKey,
      });
      return { dockerId: result.dockerId, image: result.image };
    }

    const existing = await this.runtime.list({
      tenantId: agent.tenantId,
      purpose: "acp-adapter",
    });
    const mine = existing.filter(
      (c) =>
        c.labels["zakura.agent"] === agent.id &&
        c.labels["zakura.acp_adapter"] === adapterId &&
        c.labels["zakura.acp_session"] === sessionKey,
    );
    const running = mine.find((c) => c.status === "running" && c.image === image);
    if (running) return { dockerId: running.id, image: running.image };

    // Stale (stopped, or built from a superseded image) → replace.
    for (const c of mine) {
      await this.runtime.remove(c.id, true).catch(() => undefined);
    }

    const credHome = ACP_ADAPTER_HOME;
    const result = await this.runtime.createAndStart({
      tenantId: agent.tenantId,
      purpose: "acp-adapter",
      allocatedTo: agent.id,
      spec: {
        name: this.acpAdapterContainerName(agent.id, adapterId, sessionKey),
        image,
        purpose: "acp-adapter",
        workingDir: AGENT_WORKSPACE_ROOT,
        network: this.config.dockerNetwork,
        // The container's lifetime is the chat session's; a restart would give
        // us a fresh PID 1 with no attached peer and no way to replay state.
        restartPolicy: "no",
        ports: [],
        stdinOpen: true,
        volumes: [
          {
            hostPath: agentWorkspaceBindSource(this.config, agent.id),
            containerPath: AGENT_WORKSPACE_ROOT,
          },
          {
            volumeName: acpAdapterCredVolume(agent.id, adapterId),
            containerPath: credHome,
          },
        ],
        env: {
          ZAKURA_AGENT_ID: agent.id,
          HOME: credHome,
          PATH: WORKSPACE_EXEC_PATH,
          // Pre-container logins live under the workspace bind mount; the
          // entrypoint copies them into the cred volume once, before exec'ing
          // the adapter, so upgrading users are not silently logged out.
          ACP_LEGACY_HOME: acpDurableDir(adapterId),
          ...(opts?.env ?? {}),
        },
        labels: {
          "zakura.agent": agent.id,
          "zakura.purpose": "acp-adapter",
          "zakura.acp_adapter": adapterId,
          "zakura.acp_session": sessionKey,
          "zakura.managed": "true",
        },
      },
    });

    return { dockerId: result.id, image: result.image };
  }

  /** Attach to the adapter container's PID 1 stdio (adapter is the CMD). */
  async attachStdioInAcpAdapter(
    agent: Agent,
    adapterId: string,
    image: string,
    sessionKey: string,
    opts?: { env?: Record<string, string> },
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
    if (!this.runtime.attachStdio) {
      throw new Error("container runtime does not support stdio attach");
    }
    const job = await this.runtime.attachStdio(dockerId);
    const streams = job.toWebStreams();
    return {
      ...streams,
      kill: () => job.kill(),
      onStderr: (fn) => job.onStderr(fn),
    };
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
    if (this.isRemoteAgent(agent)) {
      const { client } = await this.requireRunnerClient(agent);
      await client
        .removeAcpAdapterContainer(agent.id, adapterId, sessionKey)
        .catch(() => undefined);
      return;
    }
    const existing = await this.runtime.list({
      tenantId: agent.tenantId,
      purpose: "acp-adapter",
    });
    for (const c of existing) {
      if (
        c.labels["zakura.agent"] === agent.id &&
        c.labels["zakura.acp_adapter"] === adapterId &&
        c.labels["zakura.acp_session"] === sessionKey
      ) {
        await this.runtime.remove(c.id, true).catch(() => undefined);
      }
    }
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
  async sweepOrphanedAcpAdapterContainers(tenantId: string): Promise<number> {
    const existing = await this.runtime
      .list({ tenantId, purpose: "acp-adapter" })
      .catch(() => []);
    let removed = 0;
    for (const c of existing) {
      if (c.labels["zakura.managed"] !== "true") continue;
      await this.runtime.remove(c.id, true).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }
}
