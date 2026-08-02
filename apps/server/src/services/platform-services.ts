import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "@zakura/core";
import type { PlatformServiceKey, PlatformServiceMode } from "@zakura/shared";
import { PLATFORM_SERVICE_KEYS, PLATFORM_SERVICE_MODES } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { newId, platformServices, type PlatformService } from "../db/schema.js";
import type { DockerRuntime } from "../runtime/docker.js";
import {
  PLATFORM_SERVICE_CATALOG,
  buildManagedSpecs,
  containerNameFor,
  defaultServiceConfig,
  isPlatformServiceKey,
  listPlatformServiceMeta,
  managedEndpointUrl,
  type PlatformServiceConfig,
} from "../platform-services/catalog.js";
import {
  deriveLifecycle,
  type LifecycleView,
} from "../platform-services/lifecycle.js";
import {
  appendPlatformServiceLog,
  beginPlatformServiceProgress,
  finishPlatformServiceProgress,
  getPlatformServiceProgress,
  setPlatformServicePhase,
  type PlatformServiceProgressSnapshot,
} from "./platform-service-progress.js";

export type PlatformContainerRef = {
  name: string;
  dockerId: string | null;
  role: string;
};

export type PlatformServicePublic = {
  key: PlatformServiceKey;
  name: string;
  description: string;
  mapsTo: (typeof PLATFORM_SERVICE_CATALOG)[PlatformServiceKey]["mapsTo"];
  mode: PlatformServiceMode;
  desiredState: "running" | "stopped";
  status: string;
  healthStatus: string;
  endpointUrl: string | null;
  lastError: string | null;
  containers: PlatformContainerRef[];
  config: {
    image?: string;
    hostPort?: number;
    externalUrl?: string;
    hasApiKey: boolean;
    envKeys: string[];
  };
  catalogDefaultImage?: string;
  catalogDefaultHostPort?: number;
  /** Primary UI state — use this instead of raw mode/status/health badges */
  lifecycle: LifecycleView;
  /** Live deploy progress (in-memory; empty when idle) */
  progress: PlatformServiceProgressSnapshot;
};

function parseMode(v: string): PlatformServiceMode {
  if ((PLATFORM_SERVICE_MODES as readonly string[]).includes(v)) {
    return v as PlatformServiceMode;
  }
  return "disabled";
}

function parseContainers(json: string): PlatformContainerRef[] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((c) => {
        if (!c || typeof c !== "object") return null;
        const o = c as Record<string, unknown>;
        return {
          name: String(o.name ?? ""),
          dockerId: typeof o.dockerId === "string" ? o.dockerId : null,
          role: String(o.role ?? "main"),
        } satisfies PlatformContainerRef;
      })
      .filter((c): c is PlatformContainerRef => Boolean(c?.name));
  } catch {
    return [];
  }
}

const PLATFORM_TENANT_LABEL = "platform";

export class PlatformServiceManager {
  /** In-flight deploy/stop jobs (async, non-blocking API) */
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly runtime: DockerRuntime,
    private readonly config: AppConfig,
  ) {}

  async ensureRows(): Promise<void> {
    for (const key of PLATFORM_SERVICE_KEYS) {
      const existing = await this.db.query.platformServices.findFirst({
        where: eq(platformServices.serviceKey, key),
      });
      if (existing) continue;
      const now = new Date();
      await this.db.insert(platformServices).values({
        id: newId(),
        serviceKey: key,
        mode: "disabled",
        desiredState: "stopped",
        status: "stopped",
        healthStatus: "unknown",
        configEnc: encryptJson(this.config.secret, defaultServiceConfig()),
        containersJson: "[]",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private readConfig(row: PlatformService): PlatformServiceConfig {
    try {
      return decryptJson<PlatformServiceConfig>(this.config.secret, row.configEnc);
    } catch {
      return defaultServiceConfig();
    }
  }

  private toPublic(row: PlatformService): PlatformServicePublic {
    const def = PLATFORM_SERVICE_CATALOG[row.serviceKey as PlatformServiceKey];
    const cfg = this.readConfig(row);
    const primary = def?.containers.find((c) => c.primary);
    const progress = getPlatformServiceProgress(row.serviceKey);
    const mode = parseMode(row.mode);
    const base = {
      key: row.serviceKey as PlatformServiceKey,
      name: def?.name ?? row.serviceKey,
      description: def?.description ?? "",
      mapsTo: def?.mapsTo ?? ({ kind: "search-engine", id: "searxng" } as const),
      mode,
      desiredState: (row.desiredState === "running" ? "running" : "stopped") as
        | "running"
        | "stopped",
      status: row.status,
      healthStatus: row.healthStatus,
      endpointUrl: row.endpointUrl,
      lastError: row.lastError,
      containers: parseContainers(row.containersJson),
      config: {
        image: cfg.image,
        hostPort: cfg.hostPort,
        externalUrl: cfg.externalUrl,
        hasApiKey: Boolean(cfg.apiKey?.trim()),
        envKeys: Object.keys(cfg.env ?? {}),
      },
      catalogDefaultImage: primary?.defaultImage,
      catalogDefaultHostPort: primary?.defaultHostPort,
      progress,
    };
    const lifecycle = deriveLifecycle({
      mode,
      status: row.status,
      healthStatus: row.healthStatus,
      desiredState: row.desiredState,
      lastError: row.lastError,
      endpointUrl: row.endpointUrl,
      progressRunning: progress.running,
      progressPhase: progress.phase,
      progressMessage: progress.message,
    });
    return { ...base, lifecycle };
  }

  private emptyPublic(key: PlatformServiceKey): PlatformServicePublic {
    const progress = getPlatformServiceProgress(key);
    const lifecycle = deriveLifecycle({
      mode: "disabled",
      status: "stopped",
      healthStatus: "unknown",
      desiredState: "stopped",
      lastError: null,
      endpointUrl: null,
      progressRunning: progress.running,
      progressPhase: progress.phase,
      progressMessage: progress.message,
    });
    return {
      key,
      name: PLATFORM_SERVICE_CATALOG[key].name,
      description: PLATFORM_SERVICE_CATALOG[key].description,
      mapsTo: PLATFORM_SERVICE_CATALOG[key].mapsTo,
      mode: "disabled",
      desiredState: "stopped",
      status: "stopped",
      healthStatus: "unknown",
      endpointUrl: null,
      lastError: null,
      containers: [],
      config: { hasApiKey: false, envKeys: [] },
      catalogDefaultImage: PLATFORM_SERVICE_CATALOG[key].containers.find((c) => c.primary)
        ?.defaultImage,
      catalogDefaultHostPort: PLATFORM_SERVICE_CATALOG[key].containers.find((c) => c.primary)
        ?.defaultHostPort,
      lifecycle,
      progress,
    };
  }

  async list(): Promise<PlatformServicePublic[]> {
    await this.ensureRows();
    const rows = await this.db.query.platformServices.findMany();
    const byKey = new Map(rows.map((r) => [r.serviceKey, r]));
    return PLATFORM_SERVICE_KEYS.map((key) => {
      const row = byKey.get(key);
      return row ? this.toPublic(row) : this.emptyPublic(key);
    });
  }

  async get(key: PlatformServiceKey): Promise<PlatformServicePublic | null> {
    await this.ensureRows();
    const row = await this.db.query.platformServices.findFirst({
      where: eq(platformServices.serviceKey, key),
    });
    return row ? this.toPublic(row) : null;
  }

  getProgress(key: string): PlatformServiceProgressSnapshot {
    return getPlatformServiceProgress(key);
  }

  private async requireRow(key: PlatformServiceKey): Promise<PlatformService> {
    await this.ensureRows();
    const row = await this.db.query.platformServices.findFirst({
      where: eq(platformServices.serviceKey, key),
    });
    if (!row) throw new Error(`Unknown platform service: ${key}`);
    return row;
  }

  /**
   * Save config / mode only — never starts containers.
   * Use deploy/start/connect for lifecycle actions.
   */
  async patch(
    key: PlatformServiceKey,
    patch: {
      mode?: PlatformServiceMode;
      config?: Partial<PlatformServiceConfig> & { clearApiKey?: boolean };
    },
  ): Promise<PlatformServicePublic> {
    const row = await this.requireRow(key);
    const cfg = this.readConfig(row);
    if (patch.config) {
      if (typeof patch.config.image === "string") cfg.image = patch.config.image || undefined;
      if (typeof patch.config.hostPort === "number") cfg.hostPort = patch.config.hostPort;
      if (typeof patch.config.externalUrl === "string") {
        cfg.externalUrl = patch.config.externalUrl.trim() || undefined;
      }
      if (patch.config.clearApiKey) delete cfg.apiKey;
      else if (typeof patch.config.apiKey === "string" && patch.config.apiKey.trim()) {
        cfg.apiKey = patch.config.apiKey.trim();
      }
      if (patch.config.env && typeof patch.config.env === "object") {
        cfg.env = { ...cfg.env, ...patch.config.env };
      }
      if (patch.config.images && typeof patch.config.images === "object") {
        cfg.images = { ...cfg.images, ...patch.config.images };
      }
    }
    const mode = patch.mode ?? parseMode(row.mode);

    await this.db
      .update(platformServices)
      .set({
        mode,
        configEnc: encryptJson(this.config.secret, cfg),
        updatedAt: new Date(),
      })
      .where(eq(platformServices.id, row.id));

    // Switching to disabled stops containers; other mode changes are config-only
    if (mode === "disabled" && parseMode(row.mode) !== "disabled") {
      await this.queueStop(key);
      return (await this.get(key))!;
    }

    if (mode === "external" && cfg.externalUrl) {
      await this.db
        .update(platformServices)
        .set({
          endpointUrl: cfg.externalUrl.replace(/\/$/, ""),
          updatedAt: new Date(),
        })
        .where(eq(platformServices.serviceKey, key));
    }

    return (await this.get(key))!;
  }

  /** Enable managed mode + start deploy (async). */
  async deploy(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    await this.db
      .update(platformServices)
      .set({
        mode: "managed",
        desiredState: "running",
        updatedAt: new Date(),
      })
      .where(eq(platformServices.serviceKey, key));
    return this.startAsync(key);
  }

  /** Connect external URL (async health probe). */
  async connectExternal(
    key: PlatformServiceKey,
    externalUrl?: string,
  ): Promise<PlatformServicePublic> {
    const row = await this.requireRow(key);
    const cfg = this.readConfig(row);
    if (externalUrl?.trim()) cfg.externalUrl = externalUrl.trim();
    if (!cfg.externalUrl?.trim()) {
      throw new Error("请填写外接服务 URL");
    }
    await this.db
      .update(platformServices)
      .set({
        mode: "external",
        desiredState: "running",
        configEnc: encryptJson(this.config.secret, cfg),
        endpointUrl: cfg.externalUrl.replace(/\/$/, ""),
        status: "starting",
        healthStatus: "unknown",
        lastError: null,
        containersJson: "[]",
        updatedAt: new Date(),
      })
      .where(eq(platformServices.id, row.id));

    this.queueJob(key, async () => {
      beginPlatformServiceProgress(key, "health", "");
      const url = cfg.externalUrl!.replace(/\/$/, "");
      const def = PLATFORM_SERVICE_CATALOG[key];
      appendPlatformServiceLog(key, `GET ${url}${def.healthPath}`, {
        step: "health",
        phase: "health",
        percent: 40,
      });
      try {
        await this.refreshHealth(key);
        const after = await this.get(key);
        if (after?.healthStatus === "healthy") {
          appendPlatformServiceLog(key, `HTTP ok ${url}`, {
            step: "health",
            level: "ok",
          });
          finishPlatformServiceProgress(key, { message: `healthy ${url}` });
        } else {
          const errMsg = after?.lastError || "health check failed";
          appendPlatformServiceLog(key, errMsg, { step: "health", level: "error" });
          finishPlatformServiceProgress(key, { error: errMsg });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendPlatformServiceLog(key, msg, { step: "health", level: "error" });
        finishPlatformServiceProgress(key, { error: msg });
        throw err;
      }
    });

    return (await this.get(key))!;
  }

  /**
   * Start managed service. Returns immediately; deploy continues in background.
   * Subscribe to platform_service_progress SSE for steps.
   */
  async startAsync(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    const row = await this.requireRow(key);
    const mode = parseMode(row.mode);
    if (mode === "external") {
      return this.connectExternal(key);
    }

    await this.db
      .update(platformServices)
      .set({
        status: "starting",
        desiredState: "running",
        mode: "managed",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(platformServices.serviceKey, key));

    this.queueJob(key, async () => {
      await this.startManaged(key);
    });

    return (await this.get(key))!;
  }

  /** @deprecated prefer startAsync — kept for sync callers */
  async start(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    return this.startAsync(key);
  }

  async stop(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    await this.db
      .update(platformServices)
      .set({ desiredState: "stopped", updatedAt: new Date() })
      .where(eq(platformServices.serviceKey, key));
    await this.queueStop(key);
    return (await this.get(key))!;
  }

  async restart(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    await this.queueStop(key);
    // wait stop job if any
    const stopJob = this.jobs.get(key);
    if (stopJob) await stopJob.catch(() => undefined);
    return this.startAsync(key);
  }

  async disable(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    await this.db
      .update(platformServices)
      .set({
        mode: "disabled",
        desiredState: "stopped",
        updatedAt: new Date(),
      })
      .where(eq(platformServices.serviceKey, key));
    await this.queueStop(key);
    return (await this.get(key))!;
  }

  async refreshHealth(key: PlatformServiceKey): Promise<PlatformServicePublic> {
    const row = await this.requireRow(key);
    const mode = parseMode(row.mode);
    const def = PLATFORM_SERVICE_CATALOG[key];
    const cfg = this.readConfig(row);

    let endpoint: string | null = null;
    if (mode === "external") {
      endpoint = cfg.externalUrl?.replace(/\/$/, "") ?? null;
    } else if (mode === "managed") {
      endpoint = row.endpointUrl;
    } else {
      await this.db
        .update(platformServices)
        .set({ healthStatus: "unknown", updatedAt: new Date() })
        .where(eq(platformServices.id, row.id));
      return this.toPublic({ ...row, healthStatus: "unknown" });
    }

    if (!endpoint) {
      await this.db
        .update(platformServices)
        .set({
          healthStatus: "unhealthy",
          lastError: "无 endpoint",
          updatedAt: new Date(),
        })
        .where(eq(platformServices.id, row.id));
      return (await this.get(key))!;
    }

    try {
      const path = def.healthPath.startsWith("/") ? def.healthPath : `/${def.healthPath}`;
      const url = `${endpoint.replace(/\/$/, "")}${path}`;
      const res = await fetch(url, {
        method: def.healthMethod ?? "GET",
        signal: AbortSignal.timeout(8000),
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
      });
      const ok = res.status < 500;
      await this.db
        .update(platformServices)
        .set({
          healthStatus: ok ? "healthy" : "unhealthy",
          lastError: ok ? null : `HTTP ${res.status}`,
          endpointUrl: endpoint,
          status: mode === "external" || row.status === "running" || ok ? "running" : row.status,
          updatedAt: new Date(),
        })
        .where(eq(platformServices.id, row.id));
    } catch (err) {
      await this.db
        .update(platformServices)
        .set({
          healthStatus: "unhealthy",
          lastError: err instanceof Error ? err.message : String(err),
          updatedAt: new Date(),
        })
        .where(eq(platformServices.id, row.id));
    }
    return (await this.get(key))!;
  }

  async resolveManaged(key: PlatformServiceKey): Promise<{
    endpointUrl: string;
    apiKey?: string;
  } | null> {
    const row = await this.db.query.platformServices.findFirst({
      where: eq(platformServices.serviceKey, key),
    });
    if (!row) return null;
    const mode = parseMode(row.mode);
    if (mode === "disabled") return null;
    const cfg = this.readConfig(row);
    let endpoint: string | null = null;
    if (mode === "external") {
      endpoint = cfg.externalUrl?.replace(/\/$/, "") || null;
    } else {
      endpoint = row.endpointUrl?.replace(/\/$/, "") || null;
      if (row.status !== "running" && row.healthStatus !== "healthy") {
        if (!endpoint || row.healthStatus === "unhealthy") return null;
      }
    }
    if (!endpoint) return null;
    if (mode === "managed" && row.status === "error") return null;
    return {
      endpointUrl: endpoint,
      apiKey: cfg.apiKey?.trim() || undefined,
    };
  }

  async ensureDesired(): Promise<{ started: number; failed: number }> {
    await this.ensureRows();
    let started = 0;
    let failed = 0;
    const rows = await this.db.query.platformServices.findMany();
    for (const row of rows) {
      const mode = parseMode(row.mode);
      if (mode === "external" && row.desiredState === "running") {
        try {
          await this.refreshHealth(row.serviceKey as PlatformServiceKey);
          started += 1;
        } catch {
          failed += 1;
        }
        continue;
      }
      if (mode === "managed" && row.desiredState === "running") {
        try {
          await this.startAsync(row.serviceKey as PlatformServiceKey);
          started += 1;
        } catch (err) {
          failed += 1;
          console.warn(
            `[platform-services] ensure ${row.serviceKey}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return { started, failed };
  }

  catalogMeta() {
    return listPlatformServiceMeta();
  }

  private queueJob(key: string, fn: () => Promise<void>): void {
    const prev = this.jobs.get(key);
    let job!: Promise<void>;
    job = (async () => {
      if (prev) await prev.catch(() => undefined);
      try {
        await fn();
      } catch (err) {
        console.warn(
          `[platform-services] job ${key}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
      }
    })();
    this.jobs.set(key, job);
  }

  private async queueStop(key: PlatformServiceKey): Promise<void> {
    this.queueJob(key, async () => {
      beginPlatformServiceProgress(key, "stopping", "");
      setPlatformServicePhase(key, "stopping", 30);
      try {
        const row = await this.requireRow(key);
        for (const ref of parseContainers(row.containersJson)) {
          appendPlatformServiceLog(
            key,
            ref.dockerId
              ? `docker stop/rm ${ref.name} (${ref.dockerId.slice(0, 12)})`
              : `remove ${ref.name}`,
            { step: "stop", phase: "stopping" },
          );
        }
        await this.stopInternal(key);
        finishPlatformServiceProgress(key, { message: "stopped" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendPlatformServiceLog(key, msg, { step: "stop", level: "error" });
        finishPlatformServiceProgress(key, { error: msg });
        throw err;
      }
    });
  }

  /** Live container logs for the service (real docker logs, not status copy). */
  async getContainerLogs(key: PlatformServiceKey, tail = 200): Promise<string> {
    const row = await this.requireRow(key);
    const refs = parseContainers(row.containersJson);
    const chunks: string[] = [];
    for (const ref of refs) {
      if (!ref.dockerId) continue;
      try {
        const body = await this.runtime.logs(ref.dockerId, tail);
        if (body.trim()) {
          chunks.push(`--- ${ref.name} ---\n${body.trimEnd()}`);
        }
      } catch (err) {
        chunks.push(
          `--- ${ref.name} ---\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return chunks.join("\n\n");
  }

  private async startManaged(key: PlatformServiceKey): Promise<void> {
    const row = await this.requireRow(key);
    const def = PLATFORM_SERVICE_CATALOG[key];
    let cfg = this.readConfig(row);

    beginPlatformServiceProgress(key, "checking", "");
    setPlatformServicePhase(key, "checking", 5);

    try {
      // Crawl4AI refuses 0.0.0.0 bind without a token — generate one once and persist.
      if (key === "crawl4ai" && !cfg.apiKey?.trim()) {
        const { randomBytes } = await import("node:crypto");
        cfg = { ...cfg, apiKey: `zkc4a_${randomBytes(18).toString("base64url")}` };
        await this.db
          .update(platformServices)
          .set({
            configEnc: encryptJson(this.config.secret, cfg),
            updatedAt: new Date(),
          })
          .where(eq(platformServices.id, row.id));
        appendPlatformServiceLog(
          key,
          "generated CRAWL4AI_API_TOKEN (required for Docker bind + auth)",
          { step: "config", phase: "checking", percent: 6 },
        );
      }

      const ping = await this.runtime.ping();
      if (!ping.ok) throw new Error(ping.error || "Docker ping failed");
      appendPlatformServiceLog(key, `Docker ${ping.version}`, {
        step: "docker",
        phase: "checking",
        percent: 8,
      });
      await this.runtime.ensureNetwork(this.config.dockerNetwork);
      appendPlatformServiceLog(key, `network: ${this.config.dockerNetwork}`, {
        step: "docker",
        phase: "checking",
        percent: 12,
      });

      await this.removeServiceContainers(key);

      const specs = buildManagedSpecs(def, cfg, this.config.dockerNetwork);
      const refs: PlatformContainerRef[] = [];
      let endpointUrl: string | null = null;
      const total = specs.length;

      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i]!;
        const role = spec.labels?.["zakura.service_role"] ?? "main";
        const basePct = 15 + Math.floor((i / Math.max(total, 1)) * 65);
        setPlatformServicePhase(key, "pulling", basePct + 5);

        let pullLines = 0;
        await this.runtime.ensureImage(spec.image, (line) => {
          pullLines += 1;
          // Throttle very chatty layer ticks; keep every line that is status-like
          if (
            pullLines <= 3 ||
            pullLines % 4 === 0 ||
            /complete|digest|already|error|downloading|extracting|pulling from|status/i.test(
              line,
            )
          ) {
            appendPlatformServiceLog(key, line, {
              step: "pull",
              phase: "pulling",
              percent: Math.min(basePct + 20, 80),
            });
          }
        });

        try {
          const existing = await this.runtime.list({ purpose: "platform-service" });
          for (const ex of existing) {
            if (ex.name === spec.name) await this.runtime.remove(ex.id, true);
          }
        } catch (err) {
          appendPlatformServiceLog(
            key,
            err instanceof Error ? err.message : String(err),
            { step: "docker", level: "warn" },
          );
        }

        setPlatformServicePhase(key, "creating", basePct + 25);
        appendPlatformServiceLog(
          key,
          `docker create --name ${spec.name} ${spec.image}`,
          { step: "create", phase: "creating", percent: basePct + 25 },
        );
        const running = await this.runtime.createAndStart({
          tenantId: PLATFORM_TENANT_LABEL,
          purpose: "platform-service",
          spec,
        });
        appendPlatformServiceLog(
          key,
          `started ${running.name} id=${running.id.slice(0, 12)} status=${running.status}`,
          { step: "create", phase: "creating", percent: basePct + 35, level: "ok" },
        );
        refs.push({ name: running.name, dockerId: running.id, role });

        // Real container stdout/stderr right after start
        try {
          await new Promise((r) => setTimeout(r, 800));
          const cLog = await this.runtime.logs(running.id, 100);
          if (cLog.trim()) {
            appendPlatformServiceLog(key, cLog, {
              step: running.name,
              phase: "creating",
              percent: basePct + 40,
            });
          }
        } catch (err) {
          appendPlatformServiceLog(
            key,
            err instanceof Error ? err.message : String(err),
            { step: "logs", level: "warn" },
          );
        }

        // Give dependent services (postgres/rabbitmq) time to accept connections
        const roleDef = def.containers.find((c) => c.role === role);
        const waitMs = roleDef?.readyWaitMs ?? 0;
        if (waitMs > 0) {
          appendPlatformServiceLog(
            key,
            `wait ${waitMs}ms for ${role} readiness`,
            { step: "ready", phase: "creating", percent: basePct + 42 },
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }

        const isPrimary = def.containers.some((c) => c.role === role && c.primary);
        if (isPrimary) {
          const published = running.ports.find((p) => p.hostPort);
          const roleDef = def.containers.find((c) => c.role === role);
          const endpoint = managedEndpointUrl(
            this.config.platformServiceEndpointMode,
            running.name,
            roleDef?.containerPort ?? published?.containerPort ?? 0,
            published?.hostPort,
          );
          if (endpoint) {
            endpointUrl = endpoint;
            appendPlatformServiceLog(
              key,
              this.config.platformServiceEndpointMode === "network"
                ? `network ${endpoint}`
                : `publish ${endpoint} -> ${published?.containerPort ?? "unknown"}`,
              { step: "docker", phase: "creating" },
            );
          }
        }
      }

      await this.db
        .update(platformServices)
        .set({
          status: "running",
          endpointUrl,
          containersJson: JSON.stringify(refs),
          healthStatus: "unknown",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(platformServices.serviceKey, key));

      setPlatformServicePhase(key, "health", 90);
      if (endpointUrl) {
        appendPlatformServiceLog(key, `GET ${endpointUrl}${def.healthPath}`, {
          step: "health",
          phase: "health",
          percent: 90,
        });
      }
      await this.refreshHealth(key);
      const after = await this.get(key);

      // Tail logs again after health
      for (const ref of refs) {
        if (!ref.dockerId) continue;
        try {
          const cLog = await this.runtime.logs(ref.dockerId, 40);
          if (cLog.trim()) {
            appendPlatformServiceLog(key, cLog, { step: ref.name, phase: "health" });
          }
        } catch {
          /* ignore */
        }
      }

      if (after?.healthStatus === "healthy") {
        finishPlatformServiceProgress(key, {
          message: endpointUrl ? `healthy ${endpointUrl}` : "healthy",
        });
      } else if (after?.status === "running") {
        finishPlatformServiceProgress(key, {
          message: after.lastError || `running health=${after.healthStatus}`,
        });
      } else {
        finishPlatformServiceProgress(key, {
          error: after?.lastError || "health check failed",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendPlatformServiceLog(key, message, { step: "error", level: "error" });
      await this.db
        .update(platformServices)
        .set({
          status: "error",
          lastError: message,
          healthStatus: "unhealthy",
          updatedAt: new Date(),
        })
        .where(eq(platformServices.serviceKey, key));
      finishPlatformServiceProgress(key, { error: message });
      throw err;
    }
  }

  private async stopInternal(key: PlatformServiceKey): Promise<void> {
    const row = await this.requireRow(key);
    await this.db
      .update(platformServices)
      .set({ status: "stopping", updatedAt: new Date() })
      .where(eq(platformServices.id, row.id));

    await this.removeServiceContainers(key);

    await this.db
      .update(platformServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        endpointUrl: parseMode(row.mode) === "external" ? row.endpointUrl : null,
        containersJson: "[]",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(platformServices.id, row.id));
  }

  private async removeServiceContainers(key: PlatformServiceKey): Promise<void> {
    const row = await this.requireRow(key);
    const refs = parseContainers(row.containersJson);
    for (const ref of refs) {
      if (!ref.dockerId) continue;
      try {
        await this.runtime.stop(ref.dockerId);
        await this.runtime.remove(ref.dockerId, true);
      } catch (err) {
        console.warn(`[platform-services] remove ${ref.name}:`, err);
      }
    }
    try {
      const listed = await this.runtime.list({ purpose: "platform-service" });
      for (const c of listed) {
        if (c.labels?.["zakura.service"] === key) {
          await this.runtime.remove(c.id, true);
        }
      }
    } catch {
      /* ignore */
    }
    const def = PLATFORM_SERVICE_CATALOG[key];
    for (const role of def.containers) {
      const name = containerNameFor(key, role.role);
      try {
        const listed = await this.runtime.list({ purpose: "platform-service" });
        for (const c of listed) {
          if (c.name === name) await this.runtime.remove(c.id, true);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export { isPlatformServiceKey, listPlatformServiceMeta };
