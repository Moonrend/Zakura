import { and, eq } from "drizzle-orm";
import {
  decryptJson,
  DecryptError,
  encryptJson,
  globalRegistry,
  type InstanceHandle,
  type ProviderContext,
} from "@zakura/core";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  componentInstances,
  managedContainers,
  newId,
  tenants,
  type ComponentInstance,
} from "../db/schema.js";
import type { DockerRuntime } from "../runtime/docker.js";

export class InstanceNotFoundError extends Error {
  constructor(instanceId: string) {
    super(`Instance not found: ${instanceId}`);
    this.name = "InstanceNotFoundError";
  }
}

/**
 * Prepare a bind-mount host path.
 * - Existing file/dir: leave as-is (never mkdir over a file).
 * - Docker engine paths (socket): skip — resolved inside Docker Desktop / Linux VM.
 * - Missing path that looks like a file (or read-only mount): ensure parent dir, require file to exist.
 * - Otherwise create a directory (workspace data mounts).
 */
function ensureVolumeHostPath(hostPath: string, readOnly?: boolean): void {
  const normalized = hostPath.replace(/\\/g, "/");
  // Docker socket / engine paths are not necessarily present on the Node host FS
  // (e.g. Docker Desktop on Windows uses the Linux VM path).
  if (
    normalized === "/var/run/docker.sock" ||
    normalized.endsWith("/docker.sock") ||
    normalized.startsWith("//./pipe/") ||
    /^\/(var\/)?run\//.test(normalized)
  ) {
    return;
  }
  if (existsSync(hostPath)) {
    return;
  }
  const base = normalized.split("/").pop() ?? "";
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(base);
  if (looksLikeFile || readOnly) {
    mkdirSync(dirname(hostPath), { recursive: true });
    if (!existsSync(hostPath)) {
      throw new Error(`Required volume host file missing: ${hostPath}`);
    }
    return;
  }
  mkdirSync(hostPath, { recursive: true });
}

export class Orchestrator {
  constructor(
    private readonly db: Db,
    private readonly runtime: DockerRuntime,
    private readonly config: AppConfig,
  ) {}

  private ctx(tenantId: string, instanceId: string): ProviderContext {
    return {
      tenantId,
      instanceId,
      dataDir: this.config.dataDir,
      db: this.db,
      resolveEndpoint: (hostPort, path = "") =>
        `http://127.0.0.1:${hostPort}${path.startsWith("/") || !path ? path : `/${path}`}`,
      logger: {
        info: (msg, meta) => console.log(`[orch] ${msg}`, meta ?? ""),
        warn: (msg, meta) => console.warn(`[orch] ${msg}`, meta ?? ""),
        error: (msg, meta) => console.error(`[orch] ${msg}`, meta ?? ""),
      },
    };
  }

  /** Load instance scoped to tenant — never cross-tenant by id alone. */
  private async requireInstance(
    tenantId: string,
    instanceId: string,
  ): Promise<ComponentInstance> {
    const instance = await this.db.query.componentInstances.findFirst({
      where: and(
        eq(componentInstances.id, instanceId),
        eq(componentInstances.tenantId, tenantId),
      ),
    });
    if (!instance) throw new InstanceNotFoundError(instanceId);
    return instance;
  }

  async toHandle(tenantId: string, instanceId: string): Promise<InstanceHandle> {
    const instance = await this.requireInstance(tenantId, instanceId);

    const containersRows = await this.db.query.managedContainers.findMany({
      where: and(
        eq(managedContainers.instanceId, instanceId),
        eq(managedContainers.tenantId, tenantId),
      ),
    });

    const config = (() => {
      try {
        return decryptJson<Record<string, unknown>>(this.config.secret, instance.configEnc);
      } catch (err) {
        if (err instanceof DecryptError) {
          throw new DecryptError(
            `实例「${instance.name}」(${instance.slug}) 配置无法解密：当前密钥与写入时不一致。请恢复原来的 ZAKURA_SECRET / data/secret.key，或删除后重新导入该实例。`,
            err,
          );
        }
        throw err;
      }
    })();
    const containers: Record<string, string> = {};
    for (const c of containersRows) {
      if (c.dockerId) {
        const parts = c.name.split("-");
        const key = parts.at(-1) ?? c.name;
        containers[key] = c.dockerId;
      }
    }
    return {
      id: instance.id,
      tenantId: instance.tenantId,
      providerId: instance.providerId,
      name: instance.name,
      slug: instance.slug,
      config,
      endpointUrl: instance.endpointUrl,
      containers,
    };
  }

  async createInstance(input: {
    tenantId: string;
    providerId: string;
    name: string;
    slug: string;
    config: Record<string, unknown>;
  }) {
    const plugin = globalRegistry.get(input.providerId);
    const normalized = plugin.validateConfig?.(input.config) ?? input.config;
    const configEnc = encryptJson(this.config.secret, normalized);
    const now = new Date();

    const [row] = await this.db
      .insert(componentInstances)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        providerId: input.providerId,
        name: input.name,
        slug: input.slug,
        configEnc,
        status: "stopped",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  }

  async startInstance(tenantId: string, instanceId: string): Promise<InstanceHandle> {
    const instance = await this.requireInstance(tenantId, instanceId);

    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, instance.tenantId),
    });
    if (!tenant) throw new Error(`Tenant not found: ${instance.tenantId}`);

    await this.db
      .update(componentInstances)
      .set({ status: "starting", lastError: null, updatedAt: new Date() })
      .where(
        and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
      );

    try {
      const plugin = globalRegistry.get(instance.providerId);
      const config = decryptJson<Record<string, unknown>>(this.config.secret, instance.configEnc);
      const ctx = this.ctx(instance.tenantId, instance.id);
      const spec = await plugin.createRuntimeSpec(config, ctx);

      await this.db
        .update(componentInstances)
        .set({
          configEnc: encryptJson(this.config.secret, config),
          updatedAt: new Date(),
        })
        .where(
          and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
        );

      // Builtin / no-container providers
      if (!spec.containers.length) {
        const endpointUrl = spec.endpointTemplate ?? "builtin://local";
        await this.db
          .update(componentInstances)
          .set({
            status: "running",
            endpointUrl,
            healthStatus: "healthy",
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
          );
        const handle = await this.toHandle(tenantId, instanceId);
        await plugin.afterStart?.(handle, ctx);
        return handle;
      }

      const ping = await this.runtime.ping();
      if (!ping.ok) {
        throw new Error(`Docker 不可用: ${ping.error}`);
      }

      await this.runtime.ensureNetwork(this.config.dockerNetwork);

      let endpointUrl = instance.endpointUrl ?? spec.endpointTemplate ?? null;

      for (const containerSpec of spec.containers) {
        const dataSubdir = join(this.config.dataDir, instance.providerId, instance.id);
        mkdirSync(dataSubdir, { recursive: true });

        const volumes = (containerSpec.volumes ?? []).map((v) => {
          if (v.hostPath) {
            ensureVolumeHostPath(v.hostPath, v.readOnly);
          }
          return v;
        });

        const name = this.runtime.buildSpecName(tenant.slug, instance.slug, containerSpec.name);

        const existing = await this.runtime.list({
          tenantId: instance.tenantId,
          instanceId: instance.id,
        });
        for (const ex of existing) {
          if (ex.name === name) {
            await this.runtime.remove(ex.id, true);
            await this.db
              .delete(managedContainers)
              .where(eq(managedContainers.dockerId, ex.id));
          }
        }

        await this.runtime.ensureImage(containerSpec.image);

        const running = await this.runtime.createAndStart({
          tenantId: instance.tenantId,
          instanceId: instance.id,
          purpose: containerSpec.purpose ?? "component",
          spec: {
            ...containerSpec,
            name,
            volumes,
            network: containerSpec.network ?? this.config.dockerNetwork,
          },
        });

        const now = new Date();
        await this.db.insert(managedContainers).values({
          id: newId(),
          tenantId: instance.tenantId,
          instanceId: instance.id,
          dockerId: running.id,
          name: running.name,
          image: running.image,
          purpose: containerSpec.purpose ?? "component",
          status: running.status,
          labelsJson: JSON.stringify(running.labels),
          portsJson: JSON.stringify(running.ports),
          envEnc: containerSpec.env
            ? encryptJson(this.config.secret, containerSpec.env)
            : null,
          createdAt: now,
          updatedAt: now,
        });

        if (containerSpec.name === spec.primaryContainer || spec.containers.length === 1) {
          const published = running.ports.find((p) => p.hostPort);
          if (published?.hostPort) {
            endpointUrl = ctx.resolveEndpoint(published.hostPort);
          }
        }
      }

      await this.db
        .update(componentInstances)
        .set({
          status: "running",
          endpointUrl,
          healthStatus: "unknown",
          updatedAt: new Date(),
        })
        .where(
          and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
        );

      const handle = await this.toHandle(tenantId, instanceId);
      await plugin.afterStart?.(handle, ctx);
      return handle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(componentInstances)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(
          and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
        );
      throw err;
    }
  }

  async stopInstance(tenantId: string, instanceId: string): Promise<void> {
    await this.requireInstance(tenantId, instanceId);
    const containers = await this.db.query.managedContainers.findMany({
      where: and(
        eq(managedContainers.instanceId, instanceId),
        eq(managedContainers.tenantId, tenantId),
      ),
    });
    await this.db
      .update(componentInstances)
      .set({ status: "stopping", updatedAt: new Date() })
      .where(
        and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
      );

    for (const c of containers) {
      if (!c.dockerId) continue;
      try {
        await this.runtime.stop(c.dockerId);
        await this.runtime.remove(c.dockerId, true);
      } catch (err) {
        console.warn(`[orch] stop/remove ${c.name}:`, err);
      }
      await this.db
        .update(managedContainers)
        .set({ status: "removed", dockerId: null, updatedAt: new Date() })
        .where(and(eq(managedContainers.id, c.id), eq(managedContainers.tenantId, tenantId)));
    }

    await this.db
      .update(componentInstances)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(
        and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
      );
  }

  async refreshHealth(tenantId: string, instanceId: string) {
    const handle = await this.toHandle(tenantId, instanceId);
    const plugin = globalRegistry.get(handle.providerId);
    const result = await plugin.healthCheck(handle);
    await this.db
      .update(componentInstances)
      .set({
        healthStatus: result.status,
        lastError: result.status === "unhealthy" ? result.message ?? null : null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
      );
    return result;
  }

  /** Merge/replace encrypted config for an existing instance */
  async updateInstanceConfig(
    tenantId: string,
    instanceId: string,
    patch: Record<string, unknown>,
    opts?: { replace?: boolean },
  ) {
    const instance = await this.requireInstance(tenantId, instanceId);
    const plugin = globalRegistry.get(instance.providerId);
    const current = decryptJson<Record<string, unknown>>(this.config.secret, instance.configEnc);
    const merged = opts?.replace ? { ...patch } : { ...current, ...patch };
    const normalized = plugin.validateConfig?.(merged) ?? merged;
    await this.db
      .update(componentInstances)
      .set({
        configEnc: encryptJson(this.config.secret, normalized),
        updatedAt: new Date(),
      })
      .where(
        and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)),
      );
    return this.toHandle(tenantId, instanceId);
  }

  async allocateContainer(input: {
    tenantId: string;
    image: string;
    name?: string;
    purpose?: "workspace" | "ephemeral";
    allocatedTo?: string;
    env?: Record<string, string>;
    command?: string[];
    ports?: Array<{ containerPort: number; hostPort?: number }>;
    runtimeNodeId?: string | null;
  }) {
    const ping = await this.runtime.ping();
    if (!ping.ok) {
      throw new Error(`Docker 不可用: ${ping.error}`);
    }
    await this.runtime.ensureNetwork(this.config.dockerNetwork);
    const name =
      input.name ??
      `zakura-alloc-${input.tenantId.slice(0, 6)}-${Date.now().toString(36)}`.slice(0, 63);

    await this.runtime.ensureImage(input.image);

    const running = await this.runtime.createAndStart({
      tenantId: input.tenantId,
      purpose: input.purpose ?? "ephemeral",
      allocatedTo: input.allocatedTo,
      spec: {
        name,
        image: input.image,
        purpose: input.purpose ?? "ephemeral",
        // Keep allocated containers alive unless caller provides a command
        command: input.command?.length ? input.command : ["sleep", "infinity"],
        env: input.env,
        ports: input.ports,
        network: this.config.dockerNetwork,
        restartPolicy: "no",
      },
    });

    const now = new Date();
    const [row] = await this.db
      .insert(managedContainers)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        dockerId: running.id,
        name: running.name,
        image: running.image,
        purpose: input.purpose ?? "ephemeral",
        status: running.status,
        labelsJson: JSON.stringify(running.labels),
        portsJson: JSON.stringify(running.ports),
        allocatedTo: input.allocatedTo,
        envEnc: input.env ? encryptJson(this.config.secret, input.env) : null,
        runtimeNodeId: input.runtimeNodeId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  }
}
