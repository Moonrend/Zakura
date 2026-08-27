/**
 * Background image-update checker: periodically polls every online node (remote
 * Runners over their API, local Docker in-process) to detect whether the images
 * they run have newer versions on the registry. Results are cached in memory and
 * served to the UI.
 *
 * The sweep is deliberately read-only — it never pulls. See
 * `packages/core/src/image-update-check.ts` for why a pulling "check" is a trap.
 */
import { log } from "@zakura/core";
import { eq, inArray } from "drizzle-orm";
import {
  DEFAULT_RUNNER_IMAGE,
  DEFAULT_WORKSPACE_IMAGE,
  type ImageUpdateEntry,
  type ImageUpdateKind,
  type NodeImageUpdateStatus,
} from "@zakura/shared";
import type { DockerRuntime } from "../runtime/docker.js";
import type { RuntimeNodeService } from "./runtime-nodes.js";
import type { Db } from "../db/client.js";
import { runtimeNodes, agents } from "../db/schema.js";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
/** Cap one node's probe so a blackholed registry cannot stall the whole sweep. */
const NODE_PROBE_TIMEOUT_MS = 60_000;

export type { ImageUpdateEntry, NodeImageUpdateStatus };

/** A node's runner image, honoring a per-node override. */
export function runnerImageForNode(node: { runnerImage?: string | null }): string {
  return node.runnerImage?.trim() || DEFAULT_RUNNER_IMAGE;
}

/**
 * Images worth probing for a node: its runner image (remote nodes only — a local
 * node has no runner container) plus the workspace default and any per-agent
 * override, tagged with what each one *is* so clients don't have to guess.
 *
 * Shared with `GET /api/runtime-nodes/:id/image-updates`, which used to carry its
 * own near-copy that disagreed about the runner-image override — so the banner and
 * the node detail page could legitimately disagree about the same node.
 */
export async function collectNodeImages(
  db: Db,
  nodeId: string,
  opts: { isLocal: boolean; runnerImage?: string | null },
): Promise<Array<{ image: string; kind: ImageUpdateKind }>> {
  const out = new Map<string, ImageUpdateKind>();
  if (!opts.isLocal) out.set(runnerImageForNode(opts), "runner");
  out.set(DEFAULT_WORKSPACE_IMAGE, "workspace");

  const bound = await db
    .select({ workspaceImage: agents.workspaceImage })
    .from(agents)
    .where(eq(agents.runtimeNodeId, nodeId));
  for (const row of bound) {
    const img = row.workspaceImage?.trim();
    // Never let an agent override downgrade the runner entry's kind.
    if (img && !out.has(img)) out.set(img, "workspace");
  }
  return [...out].map(([image, kind]) => ({ image, kind }));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class ImageUpdateChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-entrancy guard: a slow sweep must not overlap the next interval. */
  private ticking = false;
  private readonly cache = new Map<string, NodeImageUpdateStatus>();

  constructor(
    private readonly db: Db,
    private readonly nodes: RuntimeNodeService,
    private readonly docker?: DockerRuntime,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    // Delay the first sweep so Runners have time to register.
    this.bootstrapTimer = setTimeout(() => void this.tick(), 30_000);
    this.bootstrapTimer.unref?.();
    log.info("image_update_checker.started", { interval_ms: CHECK_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Previously leaked: stopping within 30s of boot still fired one sweep.
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
  }

  /** Cached status across all nodes, for the global indicator. */
  getAllStatuses(): NodeImageUpdateStatus[] {
    const now = Date.now();
    return [...this.cache.values()].filter((e) => now - e.checkedAt <= STALE_AFTER_MS);
  }

  /**
   * Force a refresh for one node (user clicked "check"). This is the only path
   * allowed to fall back to `docker pull` for a digest, and only when asked.
   */
  async checkNode(nodeId: string, opts?: { allowPullFallback?: boolean }): Promise<NodeImageUpdateStatus> {
    const status = await this.probeNode(nodeId, opts);
    this.cache.set(nodeId, status);
    return status;
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      log.debug("image_update_checker.tick_skipped_overlap");
      return;
    }
    this.ticking = true;
    try {
      const nodes = await this.db.query.runtimeNodes.findMany({
        where: inArray(runtimeNodes.kind, ["runner", "local"]),
      });
      for (const node of nodes) {
        if (node.status !== "online") continue;
        // A local probe needs a DockerRuntime adapter; skip when absent (tests).
        if (node.kind === "local" && !this.docker) continue;
        try {
          const status = await withTimeout(
            this.probeNode(node.id),
            NODE_PROBE_TIMEOUT_MS,
            `节点 ${node.slug ?? node.id} 镜像探测`,
          );
          this.cache.set(node.id, status);
        } catch (err) {
          // warn, not debug: a silently failing probe is indistinguishable from
          // "no updates" in the UI, which is exactly how this stayed unnoticed.
          log.warn("image_update_checker.node_failed", {
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn("image_update_checker.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.ticking = false;
    }
  }

  private async probeNode(
    nodeId: string,
    opts?: { allowPullFallback?: boolean },
  ): Promise<NodeImageUpdateStatus> {
    try {
      const node = await this.db.query.runtimeNodes.findFirst({
        where: eq(runtimeNodes.id, nodeId),
      });
      if (!node) throw new Error(`runtime node ${nodeId} not found`);

      const isLocal = node.kind === "local";
      const wanted = await collectNodeImages(this.db, nodeId, {
        isLocal,
        runnerImage: (node as { runnerImage?: string | null }).runnerImage ?? null,
      });
      const kindByImage = new Map(wanted.map((w) => [w.image, w.kind]));
      const images = wanted.map((w) => w.image);
      let entries: ImageUpdateEntry[];

      if (isLocal) {
        if (!this.docker) throw new Error("local image probe requires a Docker runtime");
        entries = await this.docker.checkImageUpdates(images, {
          allowPullFallback: opts?.allowPullFallback === true,
        });
      } else {
        const { client } = await this.nodes.requireRunnerClient(node.tenantId, nodeId, {
          allowOffline: true,
          skipHeartbeatRefresh: true,
        });
        const result = await client.checkImageUpdates({
          images,
          allowPullFallback: opts?.allowPullFallback === true,
        });
        entries = result.images ?? [];
      }

      const decorated = entries.map((e) => ({
        ...e,
        kind: kindByImage.get(e.image) ?? ("workspace" as ImageUpdateKind),
      }));

      return {
        nodeId,
        checkedAt: Date.now(),
        entries: decorated,
        hasUpdates: decorated.some((e) => e.updateAvailable),
        hasRunningStale: decorated.some((e) => e.runningStale),
        error: null,
      };
    } catch (err) {
      return {
        nodeId,
        checkedAt: Date.now(),
        entries: [],
        hasUpdates: false,
        hasRunningStale: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
