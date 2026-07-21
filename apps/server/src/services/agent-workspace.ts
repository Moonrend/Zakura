import { and, eq } from "drizzle-orm";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerClient } from "@zakura/core";
import {
  AGENT_DESKTOP_HEIGHT,
  AGENT_DESKTOP_WIDTH,
  AGENT_PORT_CDP,
  AGENT_PORT_NOVNC,
  AGENT_WORKSPACE_ROOT,
  DEFAULT_WORKSPACE_IMAGE,
  LOCAL_RUNTIME_NODE_ID,
  WORKSPACE_IMAGE_LOCAL,
} from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, managedContainers, newId, tenants, type Agent } from "../db/schema.js";
import type { DockerRuntime, TcpTunnel } from "../runtime/docker.js";
import {
  beginAgentProgress,
  finishAgentProgress,
  logAgentProgress,
} from "./agent-progress.js";
import { ensureWorkspaceDir } from "./agent-fs.js";
import { type RuntimeNodeService } from "./runtime-nodes.js";

export function agentDataDir(config: AppConfig, agentId: string): string {
  return join(config.dataDir, "agents", agentId);
}

export function agentWorkspaceHostPath(config: AppConfig, agentId: string): string {
  return join(agentDataDir(config, agentId), "workspace");
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
  return "none";
}

/** Prefer the local prebaked workspace image (packages at build time). */
export function resolveWorkspaceImage(configured: string | null | undefined): string {
  const preferred = WORKSPACE_IMAGE_LOCAL || DEFAULT_WORKSPACE_IMAGE;
  const raw = (configured?.trim() || preferred).trim();
  return raw || preferred;
}

export function isPrebakedWorkspaceImage(image: string): boolean {
  return /^zakura\/workspace(?::|$)/i.test(image.trim());
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

  constructor(
    private readonly db: Db,
    private readonly runtime: DockerRuntime,
    private readonly config: AppConfig,
    private readonly nodes?: RuntimeNodeService,
  ) {}

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

  private async requireRunnerClient(agent: Agent): Promise<RunnerClient> {
    if (!this.isRemoteAgent(agent)) {
      throw new Error("当前电脑未绑定远程运行节点");
    }
    if (!this.nodes) {
      throw new Error("运行节点服务不可用，请稍后重试");
    }
    const { client } = await this.nodes.requireRunnerClient(
      agent.tenantId,
      agent.runtimeNodeId!,
    );
    return client;
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
          const client = await this.requireRunnerClient(agentRow);
          const ws = await client.getWorkspace(agentId).catch(() => null);
          const cdp = ws?.endpoints?.cdpUrl ?? null;
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
      console.warn(`[agent-ws] CDP tunnel failed for ${agentId}:`, err);
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
        console.warn("[agent-ws] tryStartChromeInside failed:", err);
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
        const client = await this.requireRunnerClient(agent);
        const ws = await client.getWorkspace(agent.id);
        if (ws?.endpoints) {
          if (row && ws.status && ws.status !== row.status) {
            await this.db
              .update(managedContainers)
              .set({ status: ws.status, updatedAt: new Date() })
              .where(eq(managedContainers.id, row.id));
          }
          return {
            enabled: computerOn,
            computer: computerOn,
            browser: computerOn,
            containerStatus: ws.status ?? row?.status ?? null,
            dockerId: row?.dockerId ?? null,
            novncUrl: ws.endpoints.novncUrl,
            novncPort: ws.endpoints.novncPort,
            cdpUrl: ws.endpoints.cdpUrl,
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
    const mode = resolveStackMode(agent);
    const log = (step: string, message: string, percent?: number, phase?: string) =>
      logAgentProgress(agent.id, step, message, { percent, phase });

    this.closeTunnelsForAgent(agent.id);
    beginAgentProgress(agent.id, "starting");
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
      const remoteClient = await this.requireRunnerClient(agent);
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

      const image = resolveWorkspaceImage(agent.workspaceImage);
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
      // Always use prebaked image for display; shell-only keeps a tiny keepalive Cmd.
      log("image", `确保工作区镜像 ${image}…`, 30, "image");
      await this.ensurePrebakedWorkspaceImage(image, (msg) =>
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

      log("container", "启动电脑环境（文件 + Shell + 浏览器 + 桌面）…", 55, "container");

      const running = await this.runtime.createAndStart({
        tenantId: agent.tenantId,
        purpose: "workspace",
        allocatedTo: agent.id,
        spec: {
          name,
          image,
          purpose: "workspace",
          // Always use image ENTRYPOINT (languages + optional display)
          workingDir: AGENT_WORKSPACE_ROOT,
          network: this.config.dockerNetwork,
          restartPolicy: "unless-stopped",
          ports,
          volumes: [
            {
              hostPath: root,
              containerPath: AGENT_WORKSPACE_ROOT,
            },
          ],
          env: {
            ZAKURA_AGENT_ID: agent.id,
            ZAKURA_AGENT_SLUG: agent.slug,
            ZAKURA_ENABLE_BROWSER: "1",
            ZAKURA_ENABLE_COMPUTER: "1",
            ZAKURA_DESKTOP_WIDTH: String(AGENT_DESKTOP_WIDTH),
            ZAKURA_DESKTOP_HEIGHT: String(AGENT_DESKTOP_HEIGHT),
            HOME: AGENT_WORKSPACE_ROOT,
            DISPLAY: ":99",
          },
          labels: {
            "zakura.agent": agent.id,
            "zakura.agent_slug": agent.slug,
            "zakura.stack": mode,
            "zakura.feat.computer": "true",
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

      if (mode === "display") {
        log("packages", "等待显示/浏览器就绪…", 70, "packages");
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
  ): Promise<void> {
    if (await this.runtime.hasImage(image)) {
      onLog?.("本地镜像已存在");
      return;
    }

    // Registry pull first (future published images), then local docker build
    try {
      onLog?.(`尝试拉取 ${image}…`);
      await this.runtime.ensureImage(image);
      return;
    } catch (err) {
      onLog?.(
        `拉取失败，改为本地构建（${err instanceof Error ? err.message : String(err)}）`,
      );
    }

    const contextDir = resolveWorkspaceDockerContext();
    if (!contextDir) {
      throw new Error(
        `未找到 docker/workspace/Dockerfile。请先运行: docker build -t ${image} docker/workspace\n` +
          `或设置 ZAKURA_WORKSPACE_DOCKER_DIR 指向该目录。`,
      );
    }

    onLog?.(`本地构建 ${image}（首次约数分钟）…`);
    const mirror = (this.config.aptMirror || "http://mirrors.aliyun.com")
      .replace(/\/$/, "")
      .replace(/^https:\/\//i, "http://");
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
  }

  private async waitDesktopReady(
    dockerId: string,
    agent: Agent,
    timeoutMs: number,
    onTick?: (percent: number, message: string) => void,
  ) {
    const start = Date.now();
    let ticks = 0;
    while (Date.now() - start < timeoutMs) {
      ticks += 1;
      const elapsed = Date.now() - start;
      const pct = Math.min(95, 70 + Math.floor((elapsed / timeoutMs) * 25));
      try {
        // 电脑环境自带浏览器：以 CDP 就绪为准
        const check = await this.runtime.exec(dockerId, [
          "bash",
          "-lc",
          "curl -sf -m 2 http://127.0.0.1:9222/json/version >/dev/null && echo ok",
        ]);
        if (check.stdout.includes("ok")) {
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
    console.warn(`[agent-ws] feature ready timeout for ${agent.slug}`);
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

      const image = resolveWorkspaceImage(agent.workspaceImage);
      log("container", `在远程 Runner 启动电脑环境（${image}）…`, 40, "container");

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
        console.warn(`[agent-ws] remote stop ${agent.slug}:`, err);
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
          console.warn(`[agent-ws] stop workspace ${agent.slug}:`, err);
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
      const client = await this.requireRunnerClient(agent);
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
    opts?: { workingDir?: string; env?: Record<string, string> },
  ) {
    let workingDir = AGENT_WORKSPACE_ROOT;
    if (opts?.workingDir) {
      const raw = opts.workingDir.replace(/\\/g, "/");
      workingDir = raw.startsWith(AGENT_WORKSPACE_ROOT)
        ? raw
        : `${AGENT_WORKSPACE_ROOT}/${raw.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
    }

    const env = {
      PATH: "/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: AGENT_WORKSPACE_ROOT,
      ...opts?.env,
    };

    if (this.isRemoteAgent(agent)) {
      const client = await this.requireRunnerClient(agent);
      return client.execWorkspace(agent.id, command, { workingDir, env });
    }

    const dockerId = await this.resolveDockerId(agent);
    return this.runtime.exec(dockerId, command, {
      workingDir,
      env,
    });
  }
}
