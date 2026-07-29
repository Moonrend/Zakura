/**
 * Local Docker ops for agent workspace containers on the Runner host.
 */
import Docker from "dockerode";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { resolveDockerContextSocketPath, toDockerHostPath } from "@zakura/core";
import {
  AGENT_PORT_CDP,
  AGENT_PORT_NOVNC,
  AGENT_WORKSPACE_ROOT,
  AGENT_DESKTOP_WIDTH,
  AGENT_DESKTOP_HEIGHT,
} from "@zakura/shared";

function dockerErr(err: unknown): Error {
  if (!err || typeof err !== "object") return new Error(String(err));
  const e = err as { message?: string; json?: { message?: string } };
  return new Error(e.json?.message || e.message || String(err));
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function demux(buffer: Buffer): { stdout: string; stderr: string } {
  if (buffer.length >= 8 && buffer[0]! <= 2 && buffer[1] === 0) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const streamType = buffer[offset]!;
      const size = buffer.readUInt32BE(offset + 4);
      offset += 8;
      if (size < 0 || offset + size > buffer.length) break;
      const chunk = buffer.subarray(offset, offset + size);
      offset += size;
      if (streamType === 1) stdout.push(chunk);
      else if (streamType === 2) stderr.push(chunk);
    }
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }
  return { stdout: buffer.toString("utf8"), stderr: "" };
}

export type WorkspaceStartSpec = {
  agentId: string;
  agentSlug: string;
  tenantSlug?: string;
  image: string;
  network?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
};

export type WorkspaceInfo = {
  agentId: string;
  dockerId: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  labels: Record<string, string>;
  workspaceHostPath: string;
  endpoints: {
    novncPort: number | null;
    cdpPort: number | null;
    novncUrl: string | null;
    cdpUrl: string | null;
  };
};

export class RunnerDockerWorkspace {
  private readonly docker: Docker;

  constructor(
    private readonly storageRoot: string,
    private readonly publicHost: string,
    dockerOpts?: Docker.DockerOptions,
  ) {
    const socketPath = dockerOpts ? undefined : resolveDockerContextSocketPath();
    this.docker = new Docker(socketPath ? { socketPath } : dockerOpts);
  }

  workspacePath(agentId: string): string {
    return join(this.storageRoot, "agents", agentId, "workspace");
  }

  private containerName(tenantSlug: string | undefined, agentSlug: string): string {
    const t = (tenantSlug || "default").toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const a = agentSlug.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    return `zakura-ws-${t}-${a}`.slice(0, 63);
  }

  async ping(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      const info = await this.docker.version();
      return { ok: true, version: info.Version ?? "unknown" };
    } catch (err) {
      return { ok: false, error: dockerErr(err).message };
    }
  }

  /** 指定 bridge 网络不存在时自动创建（与 Server DockerRuntime 对齐） */
  async ensureNetwork(name: string): Promise<void> {
    const network = name.trim();
    if (!network) return;
    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [network] },
      });
      if (networks.some((n) => n.Name === network)) return;
      await this.docker.createNetwork({
        Name: network,
        CheckDuplicate: true,
        Driver: "bridge",
        Labels: { "zakura.managed": "true" },
      });
    } catch (err) {
      const msg = dockerErr(err).message;
      if (/already exists/i.test(msg)) return;
      throw dockerErr(err);
    }
  }

  async findByAgent(agentId: string): Promise<WorkspaceInfo | null> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`zakura.agent=${agentId}`, "zakura.purpose=workspace"] },
    });
    if (!list.length) return null;
    const info = await this.docker.getContainer(list[0]!.Id).inspect();
    return this.toInfo(agentId, info);
  }

  private toInfo(agentId: string, info: Docker.ContainerInspectInfo): WorkspaceInfo {
    const ports: WorkspaceInfo["ports"] = [];
    const bindings = info.NetworkSettings?.Ports ?? {};
    for (const [key, hosts] of Object.entries(bindings)) {
      const [portStr, protocol] = key.split("/");
      const containerPort = Number(portStr);
      if (hosts && hosts.length > 0) {
        for (const h of hosts) {
          ports.push({
            containerPort,
            hostPort: h.HostPort ? Number(h.HostPort) : undefined,
            protocol,
          });
        }
      } else {
        ports.push({ containerPort, protocol });
      }
    }
    const find = (p: number) => ports.find((x) => x.containerPort === p)?.hostPort ?? null;
    const novncPort = find(AGENT_PORT_NOVNC);
    const cdpPort = find(AGENT_PORT_CDP);
    const host = this.publicHost || "127.0.0.1";
    return {
      agentId,
      dockerId: info.Id,
      name: info.Name?.replace(/^\//, "") ?? info.Id.slice(0, 12),
      image: info.Config?.Image ?? "",
      status: info.State?.Status ?? "unknown",
      ports,
      labels: info.Config?.Labels ?? {},
      workspaceHostPath: this.workspacePath(agentId),
      endpoints: {
        novncPort,
        cdpPort,
        novncUrl: novncPort
          ? `http://${host}:${novncPort}/vnc.html?autoconnect=true&resize=scale&password=`
          : null,
        cdpUrl: cdpPort ? `http://${host}:${cdpPort}` : null,
      },
    };
  }

  async start(spec: WorkspaceStartSpec): Promise<WorkspaceInfo> {
    const root = this.workspacePath(spec.agentId);
    mkdirSync(root, { recursive: true });

    // Remove old containers for this agent
    const existing = await this.findByAgent(spec.agentId);
    if (existing) {
      try {
        await this.docker.getContainer(existing.dockerId).stop({ t: 5 }).catch(() => undefined);
        await this.docker.getContainer(existing.dockerId).remove({ force: true });
      } catch {
        /* ignore */
      }
    }

    const name = this.containerName(spec.tenantSlug, spec.agentSlug);
    // Best-effort remove by name
    try {
      const byName = this.docker.getContainer(name);
      await byName.remove({ force: true });
    } catch {
      /* ignore */
    }

    // Ensure image exists (pull if missing)
    try {
      await this.docker.getImage(spec.image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(spec.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(dockerErr(err));
          this.docker.modem.followProgress(stream, (e: Error | null) =>
            e ? reject(dockerErr(e)) : resolve(),
          );
        });
      });
    }

    const novncHost = await findFreePort();
    const cdpHost = await findFreePort();

    const labels: Record<string, string> = {
      "zakura.managed": "true",
      "zakura.purpose": "workspace",
      "zakura.agent": spec.agentId,
      "zakura.agent_slug": spec.agentSlug,
      "zakura.stack": "display",
      "zakura.feat.computer": "true",
      ...(spec.labels ?? {}),
    };

    const env = {
      ZAKURA_AGENT_ID: spec.agentId,
      ZAKURA_AGENT_SLUG: spec.agentSlug,
      ZAKURA_ENABLE_BROWSER: "1",
      ZAKURA_ENABLE_COMPUTER: "1",
      ZAKURA_DESKTOP_WIDTH: String(AGENT_DESKTOP_WIDTH),
      ZAKURA_DESKTOP_HEIGHT: String(AGENT_DESKTOP_HEIGHT),
      HOME: AGENT_WORKSPACE_ROOT,
      DISPLAY: ":99",
      ...(spec.env ?? {}),
    };

    const hostPath = toDockerHostPath(root);
    const createOpts: Docker.ContainerCreateOptions = {
      name,
      Image: spec.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      WorkingDir: AGENT_WORKSPACE_ROOT,
      ExposedPorts: {
        [`${AGENT_PORT_NOVNC}/tcp`]: {},
        [`${AGENT_PORT_CDP}/tcp`]: {},
      },
      HostConfig: {
        Binds: [`${hostPath}:${AGENT_WORKSPACE_ROOT}`],
        PortBindings: {
          [`${AGENT_PORT_NOVNC}/tcp`]: [{ HostPort: String(novncHost) }],
          [`${AGENT_PORT_CDP}/tcp`]: [{ HostPort: String(cdpHost) }],
        },
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 2 * 1024 * 1024 * 1024,
      },
    };

    if (spec.network) {
      await this.ensureNetwork(spec.network);
      createOpts.NetworkingConfig = {
        EndpointsConfig: { [spec.network]: {} },
      };
    }

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(createOpts);
    } catch (err) {
      throw dockerErr(err);
    }
    try {
      await container.start();
    } catch (err) {
      try {
        await container.remove({ force: true });
      } catch {
        /* ignore */
      }
      throw dockerErr(err);
    }

    const info = await container.inspect();
    return this.toInfo(spec.agentId, info);
  }

  async stop(agentId: string, remove = true): Promise<{ ok: true }> {
    const existing = await this.findByAgent(agentId);
    if (!existing) return { ok: true };
    try {
      await this.docker.getContainer(existing.dockerId).stop({ t: 10 }).catch(() => undefined);
      if (remove) {
        await this.docker.getContainer(existing.dockerId).remove({ force: true });
      }
    } catch (err) {
      const msg = dockerErr(err).message;
      if (!/No such container/i.test(msg)) throw dockerErr(err);
    }
    return { ok: true };
  }

  /** Probe that /workspace is a readable bind mount (host dir not deleted). */
  async probeWorkspaceMount(dockerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await this.execRaw(dockerId, ["test", "-d", AGENT_WORKSPACE_ROOT], {
        workingDir: "/",
      });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: `工作区挂载已失效（无法访问 ${AGENT_WORKSPACE_ROOT}）。主机目录可能被删除，请重启电脑环境。`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async execRaw(
    dockerId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(dockerId);
    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts?.workingDir,
      Env: opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    const demuxed = demux(Buffer.concat(chunks));
    const inspect = await exec.inspect();
    return {
      exitCode: inspect.ExitCode ?? 0,
      stdout: demuxed.stdout,
      stderr: demuxed.stderr,
    };
  }

  async exec(
    agentId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const existing = await this.findByAgent(agentId);
    if (!existing || existing.status !== "running") {
      throw new Error("Workspace container not running on this runner");
    }
    // Host dir must exist; recreating after delete without container restart leaves a broken mount
    const root = this.workspacePath(agentId);
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
      throw new Error(
        `工作区主机目录丢失并已重建为空目录：${root}。请重启电脑环境以重新挂载 /workspace。`,
      );
    }
    const probe = await this.probeWorkspaceMount(existing.dockerId);
    if (!probe.ok) throw new Error(probe.error);
    return this.execRaw(existing.dockerId, command, opts);
  }

  /**
   * Proxy a container localhost TCP port to the host via docker exec + socat/nc.
   * Used by Cloudflare Quick Tunnel (cloudflared binds to host loopback).
   */
  async openTcpTunnel(
    agentId: string,
    containerPort: number,
  ): Promise<{ host: string; port: number; url: string; close: () => void }> {
    const existing = await this.findByAgent(agentId);
    if (!existing || existing.status !== "running") {
      throw new Error("Workspace container not running on this runner");
    }
    const container = this.docker.getContainer(existing.dockerId);
    const server = createServer((socket: Socket) => {
      void (async () => {
        let stream: (NodeJS.ReadableStream & NodeJS.WritableStream & { destroy?: () => void }) | null =
          null;
        const cleanup = () => {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          try {
            stream?.destroy?.();
          } catch {
            /* ignore */
          }
        };
        try {
          const exec = await container.exec({
            Cmd: [
              "bash",
              "-lc",
              `if command -v socat >/dev/null 2>&1; then exec socat STDIO TCP:127.0.0.1:${containerPort},forever; elif command -v nc >/dev/null 2>&1; then exec nc 127.0.0.1 ${containerPort}; else echo 'socat/nc missing' >&2; exit 127; fi`,
            ],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
          });
          stream = (await exec.start({
            hijack: true,
            stdin: true,
          })) as NodeJS.ReadableStream & NodeJS.WritableStream & { destroy?: () => void };

          socket.pipe(stream);
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          this.docker.modem.demuxStream(stream, stdout, stderr);
          stdout.pipe(socket);
          stderr.resume();

          socket.on("close", cleanup);
          socket.on("error", cleanup);
          stream.on("end", cleanup);
          stream.on("error", cleanup);
          stdout.on("error", cleanup);
        } catch {
          cleanup();
        }
      })();
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo | null;
        if (!addr) {
          reject(new Error("failed to bind TCP tunnel"));
          return;
        }
        resolve(addr.port);
      });
    });

    return {
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      close: () => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      },
    };
  }
}
