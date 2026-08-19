import { Hono } from "hono";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  LocalWorkspaceFs,
  PathJailError,
  exportWorkspace,
  getTelemetry,
  importWorkspace,
  log,
} from "@zakura/core";
import type { RunnerAuthConfig } from "./auth.js";
import { requireRunnerAuth, tokenMatches, extractBearer } from "./auth.js";
import { collectHostInfo, resolveEndpointPublicHost } from "./host-info.js";
import { RunnerDockerWorkspace } from "./docker-workspace.js";
import { RunnerDockerComponents } from "./docker-components.js";
import { TunnelManager } from "./tunnel/manager.js";
import { updateRunnerSelf } from "./system-update.js";
import { checkImageUpdates } from "./image-update-check.js";

export type RunnerConfig = {
  storageRoot: string;
  token: string;
  auth: RunnerAuthConfig;
  version: string;
  publicUrl?: string;
  serverUrl?: string;
  /** Prefer ZAKURA_RUNNER_PUBLIC_HOST for CDP/noVNC URLs */
  publicHost?: string;
};

function agentWorkspaceRoot(storageRoot: string, agentId: string): string {
  return join(storageRoot, "agents", agentId, "workspace");
}

function fsError(err: unknown): { status: 400 | 403 | 404 | 409 | 500; body: { error: string } } {
  if (err instanceof PathJailError) {
    return { status: 403, body: { error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    const status = (err as { status: number }).status;
    if (status === 409) return { status: 409, body: { error: message } };
  }
  if (code === "ENOENT" || message.includes("ENOENT") || message.includes("no such file")) {
    return { status: 404, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

function getFs(storageRoot: string, agentId: string): LocalWorkspaceFs {
  const root = agentWorkspaceRoot(storageRoot, agentId);
  mkdirSync(root, { recursive: true });
  return new LocalWorkspaceFs(root);
}

export function createRunnerApp(cfg: RunnerConfig): Hono {
  const app = new Hono();
  const hostInfo = collectHostInfo(cfg.storageRoot, cfg.publicUrl);
  // noVNC/CDP must advertise a host reachable from Server/browser — not loopback
  const publicHost = resolveEndpointPublicHost(hostInfo, {
    publicHost: cfg.publicHost,
    publicUrl: cfg.publicUrl,
  });
  if (publicHost === "127.0.0.1") {
    log.warn("runner.loopback_desktop");
  }
  const dockerWs = new RunnerDockerWorkspace(cfg.storageRoot, publicHost);
  const dockerComponents = new RunnerDockerComponents(cfg.storageRoot, publicHost);
  const tunnels = new TunnelManager();

  app.get("/health", (c) => c.json(getTelemetry().health.live()));
  app.get("/livez", (c) => c.json(getTelemetry().health.live()));
  app.get("/readyz", async (c) => {
    const docker = await dockerWs.ping();
    const body = {
      status: docker.ok ? ("ready" as const) : ("not_ready" as const),
      service: "zakura-runner",
      version: cfg.version,
      checks: {
        docker: docker.ok
          ? { status: "up" as const }
          : { status: "down" as const, message: docker.error },
      },
    };
    return c.json(body, docker.ok ? 200 : 503);
  });
  app.get("/metrics", (c) =>
    c.text(getTelemetry().metrics.renderPrometheus(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    }),
  );

  app.get("/v1/ping", async (c) => {
    const hostInfo = collectHostInfo(cfg.storageRoot, cfg.publicUrl);
    const docker = await dockerWs.ping();
    return c.json({
      ok: true,
      version: cfg.version,
      storageRoot: cfg.storageRoot,
      hostInfo: {
        ...hostInfo,
        dockerVersion: docker.ok ? docker.version : hostInfo.dockerVersion,
      },
      docker,
    });
  });

  // All other /v1/* require auth
  app.use("/v1/*", requireRunnerAuth(cfg.auth));

  // --- System: version / self-update / image refresh ---
  app.get("/v1/system/version", (c) => {
    const img = process.env.ZAKURA_RUNNER_IMAGE?.trim() || "";
    return c.json({
      version: cfg.version,
      image: img,
      containerId: process.env.HOSTNAME?.trim() || null,
    });
  });

  app.post("/v1/system/update", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      image?: string;
      recreateDelayMs?: number;
    };
    const image = body.image?.trim();
    if (!image) return c.json({ error: "image is required" }, 400);
    try {
      const result = await updateRunnerSelf(dockerWs.client, image, {
        recreateDelayMs: body.recreateDelayMs,
      });
      return c.json(result);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 500);
    }
  });

  app.post("/v1/system/workspace-image/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      image?: string;
      recreateRunning?: boolean;
    };
    const image = body.image?.trim();
    if (!image) return c.json({ error: "image is required" }, 400);
    try {
      await dockerWs.pullImage(image);
      let recreated: Array<{ agentId: string; dockerId: string; name: string }> = [];
      if (body.recreateRunning !== false) {
        recreated = await dockerWs.recreateWorkspaces(image);
      }
      return c.json({ image, status: "updated", recreated });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 500);
    }
  });

  app.post("/v1/system/image-updates", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      images?: string[];
    };
    const images = (body.images ?? []).map((s) => s.trim()).filter(Boolean);
    if (!images.length) return c.json({ error: "images is required" }, 400);
    try {
      const results = await checkImageUpdates(dockerWs.client, images);
      const payload = results.map((r) => ({
        image: r.image,
        localDigest: r.localDigest,
        remoteDigest: r.remoteDigest,
        updateAvailable: r.updateAvailable,
        error: r.error,
      })) as Array<{
        image: string;
        localDigest: string | null;
        remoteDigest: string | null;
        updateAvailable: boolean;
        error: string | null;
      }>;
      return c.json({ images: payload });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // --- Workspace lifecycle ---
  app.post("/v1/workspaces", async (c) => {
    type Body = {
      agentId?: string;
      agentSlug?: string;
      tenantSlug?: string;
      image?: string;
      network?: string;
      env?: Record<string, string>;
      labels?: Record<string, string>;
    };
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (!body.agentId?.trim() || !body.agentSlug?.trim()) {
      return c.json({ error: "agentId and agentSlug are required" }, 400);
    }
    try {
      const info = await dockerWs.start({
        agentId: body.agentId,
        agentSlug: body.agentSlug,
        tenantSlug: body.tenantSlug,
        image: body.image || "sunwuyuan/zakura-workspace-dev:debian",
        network: body.network,
        env: body.env,
        labels: body.labels,
      });
      return c.json({ workspace: info }, 201);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 403 ? 403 : 500);
    }
  });

  app.get("/v1/workspaces/:agentId", async (c) => {
    try {
      const info = await dockerWs.findByAgent(c.req.param("agentId"));
      if (!info) return c.json({ workspace: null });
      return c.json({ workspace: info });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.post("/v1/workspaces/:agentId/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { remove?: boolean };
    try {
      await dockerWs.stop(c.req.param("agentId"), body.remove !== false);
      return c.json({ ok: true });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.delete("/v1/workspaces/:agentId", async (c) => {
    try {
      await dockerWs.stop(c.req.param("agentId"), true);
      return c.json({ ok: true });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.post("/v1/workspaces/:agentId/exec", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      command?: string[];
      workingDir?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    };
    if (!body.command?.length) return c.json({ error: "command is required" }, 400);
    try {
      const result = await dockerWs.exec(c.req.param("agentId"), body.command, {
        workingDir: body.workingDir,
        env: body.env,
        timeoutMs: body.timeoutMs,
      });
      return c.json(result);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 400);
    }
  });

  app.post("/v1/workspaces/:agentId/exec/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      command?: string[];
      workingDir?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      stdin?: string;
    };
    if (!body.command?.length) return c.json({ error: "command is required" }, 400);
    try {
      const snap = await dockerWs.startJob(c.req.param("agentId"), body.command, {
        workingDir: body.workingDir,
        env: body.env,
        timeoutMs: body.timeoutMs,
        stdin: body.stdin,
      });
      return c.json(snap);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 400);
    }
  });

  app.get("/v1/workspaces/:agentId/exec/jobs/:jobId", async (c) => {
    const job = dockerWs.getJob(c.req.param("agentId"), c.req.param("jobId"));
    if (!job) return c.json({ error: "Shell job not found" }, 404);
    return c.json(job.snapshot());
  });

  app.post("/v1/workspaces/:agentId/exec/jobs/:jobId/wait", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      waitMs?: number;
      stdin?: string;
    };
    try {
      const snap = await dockerWs.waitJob(
        c.req.param("agentId"),
        c.req.param("jobId"),
        typeof body.waitMs === "number" ? body.waitMs : 20_000,
        typeof body.stdin === "string" ? body.stdin : undefined,
      );
      return c.json(snap);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 400);
    }
  });

  app.post("/v1/workspaces/:agentId/exec/jobs/:jobId/kill", async (c) => {
    try {
      const snap = await dockerWs.killJob(c.req.param("agentId"), c.req.param("jobId"));
      return c.json(snap);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 400);
    }
  });

  app.post("/v1/workspaces/:agentId/exec/jobs/:jobId/resize", async (c) => {
    const job = dockerWs.getJob(c.req.param("agentId"), c.req.param("jobId"));
    if (!job) {
      return c.json({ error: "shell job not found" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { cols?: number; rows?: number };
    if (!Number.isFinite(body.cols) || !Number.isFinite(body.rows)) {
      return c.json({ error: "cols and rows are required" }, 400);
    }
    await job.resize(body.cols!, body.rows!);
    return c.json({ ok: true });
  });

  app.post("/v1/workspaces/:agentId/exec/stdio", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      command?: string[];
      workingDir?: string;
      env?: Record<string, string>;
    };
    if (!body.command?.length) return c.json({ error: "command is required" }, 400);
    try {
      const job = await dockerWs.startStdio(c.req.param("agentId"), body.command, {
        workingDir: body.workingDir,
        env: body.env,
      });
      return c.json({ id: job.id });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 404 ? 404 : 400);
    }
  });

  app.get("/v1/workspaces/:agentId/exec/stdio/:stdioId", async (c) => {
    const job = dockerWs.getStdio(c.req.param("stdioId"));
    if (!job) return c.json({ error: "stdio session not found" }, 404);
    return new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (obj: unknown) => {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };
          const off = job.onStderr((d) => send({ t: "err", d }));
          const { readable } = job.toWebStreams();
          const reader = readable.getReader();
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) send({ t: "out", d: Buffer.from(value).toString("base64") });
              }
            } finally {
              off();
              const code = await job.wait();
              send({ t: "exit", code });
              controller.close();
            }
          })();
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      },
    );
  });

  app.post("/v1/workspaces/:agentId/exec/stdio/:stdioId/stdin", async (c) => {
    const job = dockerWs.getStdio(c.req.param("stdioId"));
    if (!job) return c.json({ error: "stdio session not found" }, 404);
    const buf = Buffer.from(await c.req.arrayBuffer());
    job.write(buf);
    return c.json({ ok: true });
  });

  app.post("/v1/workspaces/:agentId/exec/stdio/:stdioId/kill", async (c) => {
    const job = dockerWs.getStdio(c.req.param("stdioId"));
    if (!job) return c.json({ error: "stdio session not found" }, 404);
    await job.kill();
    return c.json({ ok: true });
  });

  app.get("/v1/workspaces/:agentId/endpoints", async (c) => {
    try {
      const info = await dockerWs.findByAgent(c.req.param("agentId"));
      if (!info) return c.json({ error: "Not found" }, 404);
      return c.json({ endpoints: info.endpoints, status: info.status });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  // --- Component / MCP instance lifecycle ---
  app.post("/v1/instances/:instanceId/start", async (c) => {
    const instanceId = c.req.param("instanceId");
    type Body = {
      tenantId?: string;
      name?: string;
      image?: string;
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
    const body = (await c.req.json().catch(() => ({}))) as Body;
    if (!body.tenantId?.trim() || !body.name?.trim() || !body.image?.trim()) {
      return c.json({ error: "tenantId, name, and image are required" }, 400);
    }
    try {
      const info = await dockerComponents.start({
        instanceId,
        tenantId: body.tenantId,
        name: body.name,
        image: body.image,
        env: body.env,
        command: body.command,
        args: body.args,
        ports: body.ports,
        volumes: body.volumes,
        labels: body.labels,
        network: body.network,
        workingDir: body.workingDir,
      });
      return c.json({ instance: info }, 201);
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status === 403 ? 403 : 500);
    }
  });

  app.post("/v1/instances/:instanceId/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { remove?: boolean };
    try {
      await dockerComponents.stop(c.req.param("instanceId"), body.remove !== false);
      return c.json({ ok: true });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.get("/v1/instances/:instanceId", async (c) => {
    try {
      const info = await dockerComponents.get(c.req.param("instanceId"));
      if (!info) return c.json({ instance: null });
      return c.json({ instance: info });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, 500);
    }
  });

  app.post("/v1/instances/:instanceId/migration/export", async (c) => {
    const instanceId = c.req.param("instanceId");
    const body = await c.req
      .json<{
        sourceNodeId?: string;
        excludePatterns?: string[];
        includePatterns?: string[];
      }>()
      .catch(
        () =>
          ({} as {
            sourceNodeId?: string;
            excludePatterns?: string[];
            includePatterns?: string[];
          }),
      );
    try {
      const result = await dockerComponents.exportData(instanceId, body);
      const manifestB64 = Buffer.from(JSON.stringify(result.manifest), "utf8").toString(
        "base64url",
      );
      return new Response(result.archive, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(result.archive.length),
          "X-Archive-Sha256": result.archiveSha256,
          "X-Migration-Manifest": manifestB64,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/instances/:instanceId/migration/import", async (c) => {
    const instanceId = c.req.param("instanceId");
    const expectedSha = c.req.header("x-archive-sha256") ?? undefined;
    const atomic = c.req.header("x-atomic") !== "0";
    try {
      const buf = Buffer.from(await c.req.arrayBuffer());
      const result = await dockerComponents.importData(instanceId, buf, {
        expectedSha256: expectedSha,
        atomic,
      });
      return c.json({
        ok: true as const,
        fileCount: result.fileCount,
        workspaceRoot: result.workspaceRoot,
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  // --- FS ---
  app.get("/v1/agents/:agentId/fs", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path") || "/";
    try {
      return c.json(await fs.statDetailed(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/fs/list", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path") || "/";
    try {
      return c.json(await fs.listDetailed(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/fs/read", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path");
    if (!path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.readText(path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/write", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    type WriteBody = { path?: string; content?: string; expectedRevision?: string | null };
    const body = (await c.req.json().catch(() => ({}))) as WriteBody;
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    try {
      return c.json(await fs.writeText(body.path, body.content, body.expectedRevision));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/mkdir", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req.json<{ path?: string }>().catch(() => ({} as { path?: string }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.mkdirApi(body.path));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/delete", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req
      .json<{ path?: string; recursive?: boolean }>()
      .catch(() => ({} as { path?: string; recursive?: boolean }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.deleteApi(body.path, body.recursive));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/edit", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req
      .json<{ path?: string; oldText?: string; newText?: string }>()
      .catch(() => ({} as { path?: string; oldText?: string; newText?: string }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.edit(body.path, body.oldText ?? "", body.newText ?? ""));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/fs/download", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const path = c.req.query("path");
    if (!path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      const file = await fs.readBytes(path);
      return new Response(file.data, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
          "Content-Disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/upload", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    try {
      const form = await c.req.parseBody();
      const destPath = String(form.path ?? "").trim();
      if (!destPath) return c.json({ error: "path is required" }, 400);
      const file = form.file;
      if (!file || typeof file === "string") {
        return c.json({ error: "file is required" }, 400);
      }
      const data = Buffer.from(await file.arrayBuffer());
      return c.json(await fs.writeBytes(destPath, data));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/archive", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req.json<{ paths?: string[] }>().catch(() => ({} as { paths?: string[] }));
    const paths = body.paths ?? [];
    try {
      const { filename, buffer } = await fs.archive(paths);
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/extract", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req
      .json<{ path?: string; destination?: string }>()
      .catch(() => ({} as { path?: string; destination?: string }));
    if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
    try {
      return c.json(await fs.extract(body.path, body.destination));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/fs/rename", async (c) => {
    const fs = getFs(cfg.storageRoot, c.req.param("agentId"));
    const body = await c.req
      .json<{ oldPath?: string; newPath?: string }>()
      .catch(() => ({} as { oldPath?: string; newPath?: string }));
    if (!body.oldPath?.trim() || !body.newPath?.trim()) {
      return c.json({ error: "oldPath and newPath are required" }, 400);
    }
    try {
      return c.json(await fs.renameApi(body.oldPath, body.newPath));
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  // --- Migration ---
  app.post("/v1/agents/:agentId/migration/export", async (c) => {
    const agentId = c.req.param("agentId");
    const body = await c.req
      .json<{
        sourceNodeId?: string;
        excludePatterns?: string[];
        includePatterns?: string[];
      }>()
      .catch(
        () =>
          ({} as {
            sourceNodeId?: string;
            excludePatterns?: string[];
            includePatterns?: string[];
          }),
      );
    const root = agentWorkspaceRoot(cfg.storageRoot, agentId);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    try {
      const result = await exportWorkspace({
        agentId,
        sourceNodeId: body.sourceNodeId ?? "unknown",
        workspaceRoot: root,
        excludePatterns: body.excludePatterns,
        includePatterns: body.includePatterns,
      });
      const manifestB64 = Buffer.from(JSON.stringify(result.manifest), "utf8").toString(
        "base64url",
      );
      return new Response(result.archive, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(result.archive.length),
          "X-Archive-Sha256": result.archiveSha256,
          "X-Migration-Manifest": manifestB64,
        },
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/v1/agents/:agentId/migration/import", async (c) => {
    const agentId = c.req.param("agentId");
    const expectedSha = c.req.header("x-archive-sha256") ?? undefined;
    const atomic = c.req.header("x-atomic") !== "0";
    try {
      const buf = Buffer.from(await c.req.arrayBuffer());
      const root = agentWorkspaceRoot(cfg.storageRoot, agentId);
      const result = await importWorkspace({
        archive: buf,
        targetWorkspaceRoot: root,
        atomic,
        expectedSha256: expectedSha,
      });
      return c.json({
        ok: true as const,
        fileCount: result.fileCount,
        workspaceRoot: result.workspaceRoot,
      });
    } catch (err) {
      const e = fsError(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/v1/agents/:agentId/workspace/usage", async (c) => {
    const agentId = c.req.param("agentId");
    const root = agentWorkspaceRoot(cfg.storageRoot, agentId);
    const fs = getFs(cfg.storageRoot, agentId);
    try {
      const listed = await fs.list(".", { recursive: true, limit: 500 });
      let bytes = 0;
      let files = 0;
      for (const e of listed.entries) {
        if (e.type === "file") {
          files++;
          bytes += e.size ?? 0;
        }
      }
      return c.json({ bytesUsed: bytes, fileCount: files, path: root });
    } catch {
      return c.json({ bytesUsed: 0, fileCount: 0, path: root });
    }
  });

  /** Cloudflare Quick Tunnel（在 Runner 主机启动 cloudflared） */
  app.post("/v1/exposures", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      exposureId?: string;
      agentId?: string;
      port?: number;
      provider?: string;
      protocol?: "http" | "https" | "tcp";
      ttlMinutes?: number;
    };
    if (!body.exposureId?.trim() || !body.agentId?.trim()) {
      return c.json({ error: "exposureId and agentId required" }, 400);
    }
    if (body.port == null || !Number.isInteger(body.port)) {
      return c.json({ error: "port is required" }, 400);
    }
    try {
      const result = await tunnels.start(
        {
          exposureId: body.exposureId.trim(),
          agentId: body.agentId.trim(),
          port: body.port,
          provider: body.provider ?? "cloudflare-quick",
          protocol: body.protocol,
          ttlMinutes: body.ttlMinutes,
        },
        dockerWs,
      );
      return c.json(result, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/v1/exposures/:exposureId", async (c) => {
    try {
      await tunnels.stop(c.req.param("exposureId"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Auth probe helper used by tests
  app.get("/v1/auth-check", (c) => {
    const raw = extractBearer(c.req.header("authorization"));
    if (!tokenMatches(raw, cfg.auth)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ ok: true });
  });

  return app;
}

export { agentWorkspaceRoot };
