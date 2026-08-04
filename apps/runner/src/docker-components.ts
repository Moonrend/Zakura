/**
 * Local Docker ops for MCP/component containers on the Runner host.
 */
import Docker from "dockerode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  exportWorkspace,
  importWorkspace,
  resolveDockerContextSocketPath,
  toDockerHostPath,
  type ExportResult,
  type ImportResult,
} from "@zakura/core";

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

export type ComponentStartOpts = {
  instanceId: string;
  tenantId: string;
  name: string;
  image: string;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  ports?: Array<{
    containerPort: number;
    hostPort?: number;
    hostIp?: string;
    protocol?: "tcp" | "udp";
  }>;
  volumes?: Array<{
    hostPath?: string;
    volumeName?: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
  labels?: Record<string, string>;
  network?: string;
  workingDir?: string;
};

export type ComponentInfo = {
  dockerId: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  dataHostPath: string;
};

export class RunnerDockerComponents {
  private readonly docker: Docker;

  constructor(
    private readonly storageRoot: string,
    /** Reserved for future public endpoint URLs (parity with RunnerDockerWorkspace). */
    private readonly publicHost: string,
    dockerOpts?: Docker.DockerOptions,
  ) {
    void this.publicHost;
    const socketPath = dockerOpts ? undefined : resolveDockerContextSocketPath();
    this.docker = new Docker(socketPath ? { socketPath } : dockerOpts);
  }

  dataRoot(instanceId: string): string {
    return join(this.storageRoot, "instances", instanceId, "data");
  }

  private async ensureNetwork(name: string): Promise<void> {
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

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(dockerErr(err));
          this.docker.modem.followProgress(stream, (e: Error | null) =>
            e ? reject(dockerErr(e)) : resolve(),
          );
        });
      });
    }
  }

  async get(instanceId: string): Promise<ComponentInfo | null> {
    const list = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`zakura.instance_id=${instanceId}`, "zakura.purpose=component"],
      },
    });
    if (!list.length) return null;
    const info = await this.docker.getContainer(list[0]!.Id).inspect();
    return this.toInfo(instanceId, info);
  }

  private toInfo(instanceId: string, info: Docker.ContainerInspectInfo): ComponentInfo {
    const ports: ComponentInfo["ports"] = [];
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
      dockerId: info.Id,
      name: info.Name?.replace(/^\//, "") ?? info.Id.slice(0, 12),
      image: info.Config?.Image ?? "",
      status: info.State?.Status ?? "unknown",
      ports,
      dataHostPath: this.dataRoot(instanceId),
    };
  }

  async start(opts: ComponentStartOpts): Promise<ComponentInfo> {
    const dataHostPath = this.dataRoot(opts.instanceId);
    mkdirSync(dataHostPath, { recursive: true });

    const existing = await this.get(opts.instanceId);
    if (existing) {
      try {
        await this.docker.getContainer(existing.dockerId).stop({ t: 5 }).catch(() => undefined);
        await this.docker.getContainer(existing.dockerId).remove({ force: true });
      } catch {
        /* ignore */
      }
    }

    try {
      await this.docker.getContainer(opts.name).remove({ force: true });
    } catch {
      /* ignore */
    }

    await this.ensureImage(opts.image);

    const labels: Record<string, string> = {
      "zakura.managed": "true",
      "zakura.purpose": "component",
      "zakura.instance_id": opts.instanceId,
      "zakura.tenant_id": opts.tenantId,
      ...(opts.labels ?? {}),
    };

    const exposed: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string; HostIp?: string }>> = {};
    for (const p of opts.ports ?? []) {
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

    const volumes = opts.volumes ?? [];
    const binds =
      volumes.length > 0
        ? volumes.map((v) => {
            const src = v.hostPath ?? v.volumeName;
            if (!src) throw new Error(`Volume missing hostPath/volumeName for ${v.containerPath}`);
            const host = v.hostPath ? toDockerHostPath(v.hostPath) : src;
            return `${host}:${v.containerPath}${v.readOnly ? ":ro" : ""}`;
          })
        : [`${toDockerHostPath(dataHostPath)}:/data`];

    const cmd =
      opts.command?.length || opts.args?.length
        ? [...(opts.command ?? []), ...(opts.args ?? [])]
        : undefined;

    const createOpts: Docker.ContainerCreateOptions = {
      name: opts.name,
      Image: opts.image,
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      ...(cmd ? { Cmd: cmd } : {}),
      ...(opts.workingDir ? { WorkingDir: opts.workingDir } : {}),
      ExposedPorts: Object.keys(exposed).length ? exposed : undefined,
      HostConfig: {
        Binds: binds,
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        RestartPolicy: { Name: "unless-stopped" },
      },
    };

    if (opts.network) {
      await this.ensureNetwork(opts.network);
      createOpts.NetworkingConfig = {
        EndpointsConfig: { [opts.network]: {} },
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
    return this.toInfo(opts.instanceId, info);
  }

  async stop(instanceId: string, remove = true): Promise<{ ok: true }> {
    const existing = await this.get(instanceId);
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

  async exportData(
    instanceId: string,
    opts?: {
      sourceNodeId?: string;
      excludePatterns?: string[];
      includePatterns?: string[];
    },
  ): Promise<ExportResult> {
    const root = this.dataRoot(instanceId);
    mkdirSync(root, { recursive: true });
    return exportWorkspace({
      agentId: instanceId,
      sourceNodeId: opts?.sourceNodeId ?? "unknown",
      workspaceRoot: root,
      excludePatterns: opts?.excludePatterns,
      includePatterns: opts?.includePatterns,
    });
  }

  async importData(
    instanceId: string,
    archive: Buffer,
    opts?: { expectedSha256?: string; atomic?: boolean },
  ): Promise<ImportResult> {
    return importWorkspace({
      archive,
      targetWorkspaceRoot: this.dataRoot(instanceId),
      atomic: opts?.atomic,
      expectedSha256: opts?.expectedSha256,
    });
  }
}
