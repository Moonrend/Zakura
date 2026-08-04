import Docker from "dockerode";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import {
  resolveDockerContextSocketPath,
  toDockerHostPath,
  type ContainerRuntime,
  type CreateContainerOptions,
  type RunningContainer,
} from "@zakura/core";
import type { ContainerSpec } from "@zakura/shared";

export { toDockerHostPath };

function dockerErr(err: unknown): Error {
  if (!err || typeof err !== "object") return new Error(String(err));
  const e = err as { message?: string; json?: { message?: string }; statusCode?: number };
  const msg = e.json?.message || e.message || String(err);
  return new Error(msg);
}

/** Docker multiplexes stdout/stderr with 8-byte headers when TTY is off. */
export function demuxDockerExecOutput(buffer: Buffer): { stdout: string; stderr: string } {
  if (buffer.length >= 8 && buffer[0] <= 2 && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0) {
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

export interface TcpTunnel {
  host: string;
  port: number;
  url: string;
  close: () => void;
}

function toRunning(info: Docker.ContainerInspectInfo): RunningContainer {
  const ports: RunningContainer["ports"] = [];
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

  return {
    id: info.Id,
    name: info.Name?.replace(/^\//, "") ?? info.Id.slice(0, 12),
    image: info.Config?.Image ?? "",
    status: info.State?.Status ?? "unknown",
    ports,
    labels: info.Config?.Labels ?? {},
    mounts: (info.Mounts ?? []).map((mount) => ({
      source: mount.Source,
      target: mount.Destination,
      mode: mount.Mode,
      type: mount.Type,
    })),
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
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

export class DockerRuntime implements ContainerRuntime {
  readonly kind = "docker";
  private readonly docker: Docker;

  constructor(options?: Docker.DockerOptions) {
    const socketPath = options ? undefined : resolveDockerContextSocketPath();
    this.docker = new Docker(socketPath ? { socketPath } : options);
  }

  async ping(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      const info = await this.docker.version();
      return { ok: true, version: info.Version ?? "unknown" };
    } catch (err) {
      return { ok: false, error: dockerErr(err).message };
    }
  }

  async ensureNetwork(name: string): Promise<void> {
    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [name] },
      });
      if (networks.some((n) => n.Name === name)) return;
      await this.docker.createNetwork({
        Name: name,
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

  async createAndStart(opts: CreateContainerOptions): Promise<RunningContainer> {
    const { spec, tenantId, instanceId, purpose, allocatedTo } = opts;
    const network = spec.network;

    const labels: Record<string, string> = {
      "zakura.managed": "true",
      "zakura.tenant": tenantId,
      "zakura.purpose": purpose,
      ...(instanceId ? { "zakura.instance": instanceId } : {}),
      ...(allocatedTo ? { "zakura.allocated_to": allocatedTo } : {}),
      ...(spec.labels ?? {}),
    };

    const exposed: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string; HostIp?: string }>> = {};
    for (const p of spec.ports ?? []) {
      const key = `${p.containerPort}/${p.protocol ?? "tcp"}`;
      exposed[key] = {};
      const hostPort = p.hostPort && p.hostPort > 0 ? p.hostPort : await findFreePort();
      portBindings[key] = [
        {
          HostPort: String(hostPort),
          ...(p.hostIp ? { HostIp: p.hostIp } : {}),
        },
      ];
    }

    const binds = (spec.volumes ?? []).map((v) => {
      const src = v.hostPath ?? v.volumeName;
      if (!src) throw new Error(`Volume missing hostPath/volumeName for ${v.containerPath}`);
      const host = v.hostPath ? toDockerHostPath(v.hostPath) : src;
      return `${host}:${v.containerPath}${v.readOnly ? ":ro" : ""}`;
    });

    const env = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);

    // Prefer NetworkingConfig over NetworkMode so PortBindings stay reliable
    const createOpts: Docker.ContainerCreateOptions = {
      name: spec.name,
      Image: spec.image,
      Env: env,
      Labels: labels,
      ...(spec.command && spec.command.length > 0 ? { Cmd: spec.command } : {}),
      ...(spec.workingDir ? { WorkingDir: spec.workingDir } : {}),
      ExposedPorts: Object.keys(exposed).length ? exposed : undefined,
      HostConfig: {
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        Binds: binds.length ? binds : undefined,
        RestartPolicy: spec.restartPolicy
          ? { Name: spec.restartPolicy, MaximumRetryCount: 0 }
          : { Name: "unless-stopped" },
        ...(typeof spec.shmSize === "number" && spec.shmSize > 0
          ? { ShmSize: spec.shmSize }
          : {}),
      },
      Healthcheck: spec.healthcheck
        ? {
            Test: spec.healthcheck.test,
            Interval: (spec.healthcheck.intervalMs ?? 10000) * 1_000_000,
            Timeout: (spec.healthcheck.timeoutMs ?? 5000) * 1_000_000,
            Retries: spec.healthcheck.retries ?? 3,
          }
        : undefined,
      ...(network
        ? {
            NetworkingConfig: {
              EndpointsConfig: { [network]: {} },
            },
          }
        : {}),
    };

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

    // Ensure attached to managed network (idempotent)
    if (network) {
      try {
        await this.docker.getNetwork(network).connect({ Container: container.id });
      } catch (err) {
        const msg = dockerErr(err).message;
        if (!/already (connected|exists)|endpoint with name/i.test(msg)) {
          console.warn(`[docker] network connect: ${msg}`);
        }
      }
    }

    const info = await container.inspect();
    return toRunning(info);
  }

  async stop(containerId: string): Promise<void> {
    const c = this.docker.getContainer(containerId);
    try {
      await c.stop({ t: 10 });
    } catch (err) {
      const msg = dockerErr(err).message;
      if (!/is not running|already stopped|No such container/i.test(msg)) throw dockerErr(err);
    }
  }

  async remove(containerId: string, force = true): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force });
    } catch (err) {
      const msg = dockerErr(err).message;
      if (!/No such container/i.test(msg)) throw dockerErr(err);
    }
  }

  async inspect(containerId: string): Promise<RunningContainer | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return toRunning(info);
    } catch {
      return null;
    }
  }

  async list(filters?: {
    tenantId?: string;
    instanceId?: string;
    purpose?: string;
  }): Promise<RunningContainer[]> {
    const labelFilters: string[] = ["zakura.managed=true"];
    if (filters?.tenantId) labelFilters.push(`zakura.tenant=${filters.tenantId}`);
    if (filters?.instanceId) labelFilters.push(`zakura.instance=${filters.instanceId}`);
    if (filters?.purpose) labelFilters.push(`zakura.purpose=${filters.purpose}`);

    const list = await this.docker.listContainers({
      all: true,
      filters: { label: labelFilters },
    });

    const result: RunningContainer[] = [];
    for (const item of list) {
      try {
        const info = await this.docker.getContainer(item.Id).inspect();
        result.push(toRunning(info));
      } catch {
        /* skip vanished */
      }
    }
    return result;
  }

  async exec(
    containerId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.docker.getContainer(containerId);
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
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            stream.destroy(new Error(`容器命令执行超时（${opts.timeoutMs}ms）`));
            reject(new Error(`容器命令执行超时（${opts.timeoutMs}ms）`));
          }, opts.timeoutMs)
        : null;
      const finish = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        fn();
      };
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => finish(resolve));
      stream.on("error", (err) => finish(() => reject(err)));
    });

    const inspect = await exec.inspect();
    const demuxed = demuxDockerExecOutput(Buffer.concat(chunks));
    return {
      exitCode: inspect.ExitCode ?? 0,
      stdout: demuxed.stdout,
      stderr: demuxed.stderr,
    };
  }

  /**
   * Proxy a container localhost TCP port to the host via `docker exec` + socat.
   * Needed when Docker Desktop port publishing is broken, or when the process
   * only binds 127.0.0.1 inside the container (modern Chrome CDP).
   */
  async openTcpTunnel(containerId: string, containerPort: number): Promise<TcpTunnel> {
    const container = this.docker.getContainer(containerId);
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
          // Prefer socat; fall back to busybox/netcat-style if needed
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

          // Host → container stdin (raw)
          socket.pipe(stream);

          // Container stdout → host (demux Docker multiplex headers; drop stderr)
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

  async logs(containerId: string, tail = 200): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const buf = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    // Docker multiplexes stdout/stderr when TTY is off
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as unknown as string);
    const demuxed = demuxDockerExecOutput(raw);
    const text = [demuxed.stdout, demuxed.stderr].filter(Boolean).join("");
    return text || raw.toString("utf8");
  }

  async hasImage(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pull image if missing. onProgress receives raw dockerode status lines
   * (e.g. "abc123 Pulling fs layer", "Downloading [====>] 12MB/40MB").
   */
  async ensureImage(
    image: string,
    onProgress?: (line: string) => void,
  ): Promise<void> {
    if (await this.hasImage(image)) {
      onProgress?.(`Image already present: ${image}`);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(dockerErr(err));
        this.docker.modem.followProgress(
          stream,
          (e: Error | null) => (e ? reject(dockerErr(e)) : resolve()),
          (event: {
            status?: string;
            progress?: string;
            id?: string;
            error?: string;
          }) => {
            if (!onProgress) return;
            if (event.error) {
              onProgress(event.error);
              return;
            }
            const parts = [event.id, event.status, event.progress]
              .map((p) => (typeof p === "string" ? p.trim() : ""))
              .filter(Boolean);
            if (parts.length) onProgress(parts.join(" "));
          },
        );
      });
    });
  }

  /** Build a local image from a Dockerfile context directory. */
  async buildImage(opts: {
    tag: string;
    contextDir: string;
    dockerfile?: string;
    buildArgs?: Record<string, string>;
    onProgress?: (line: string) => void;
  }): Promise<void> {
    const { tag, contextDir, dockerfile = "Dockerfile", buildArgs, onProgress } = opts;
    await new Promise<void>((resolve, reject) => {
      this.docker.buildImage(
        { context: contextDir, src: [dockerfile, "entrypoint.sh", "capabilities.txt"] },
        {
          t: tag,
          dockerfile,
          buildargs: buildArgs,
        },
        (err, stream) => {
          if (err || !stream) return reject(dockerErr(err ?? new Error("docker build returned no stream")));
          this.docker.modem.followProgress(
            stream,
            (e: Error | null) => (e ? reject(dockerErr(e)) : resolve()),
            (event: { stream?: string; status?: string; error?: string }) => {
              const line = (event.stream || event.status || event.error || "").trim();
              if (line) onProgress?.(line);
            },
          );
        },
      );
    });
  }

  buildSpecName(tenantSlug: string, instanceSlug: string, containerName: string): string {
    return `zakura-${tenantSlug}-${instanceSlug}-${containerName}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .slice(0, 63);
  }

  withNetwork(spec: ContainerSpec, network: string): ContainerSpec {
    return { ...spec, network };
  }

  async allocateHostPort(): Promise<number> {
    return findFreePort();
  }
}
