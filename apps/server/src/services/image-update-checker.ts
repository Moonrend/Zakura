/**
 * Background image-update checker: periodically polls all online nodes
 * (remote runners AND local Docker) to detect whether their local images
 * (runner + workspace) have newer versions available on the registry.
 * Remote runners are probed over their API; local Docker is probed in-process
 * via the DockerRuntime adapter. Results are cached in-memory and exposed via
 * the API for the UI to show update banners.
 */
import { log } from "@zakura/core";
import { eq, inArray } from "drizzle-orm";
import type { DockerRuntime } from "../runtime/docker.js";
import type { RuntimeNodeService } from "./runtime-nodes.js";
import type { Db } from "../db/client.js";
import { runtimeNodes, agents } from "../db/schema.js";
import { DEFAULT_RUNNER_IMAGE, DEFAULT_WORKSPACE_IMAGE, WORKSPACE_IMAGE_LOCAL } from "@zakura/shared";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_AFTER_MS = 15 * 60 * 1000; // discard cached results older than 15 min

export type ImageUpdateEntry = {
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  updateAvailable: boolean;
  /** True when a running workspace container is on an older image than the current tag. */
  runningStale: boolean;
  error: string | null;
};

export type NodeImageUpdateStatus = {
  nodeId: string;
  checkedAt: number;
  entries: ImageUpdateEntry[];
  hasUpdates: boolean;
  /** True when at least one running workspace container lags its current tag image. */
  hasRunningStale: boolean;
  error: string | null;
};

export class ImageUpdateChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cache = new Map<string, NodeImageUpdateStatus>();

  constructor(
    private readonly db: Db,
    private readonly nodes: RuntimeNodeService,
    private readonly docker?: DockerRuntime,
  ) {}

  start(): void {
    if (this.timer) return;
    // Delay first check 30s after boot so runners have time to register
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 30_000).unref?.();
    log.info("image_update_checker.started", { interval_ms: CHECK_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get cached status for a node (or null if not checked yet). */
  getStatus(nodeId: string): NodeImageUpdateStatus | null {
    const entry = this.cache.get(nodeId);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > STALE_AFTER_MS) return null;
    return entry;
  }

  /** Get aggregated status across all nodes for the global banner. */
  getAllStatuses(): NodeImageUpdateStatus[] {
    const now = Date.now();
    const out: NodeImageUpdateStatus[] = [];
    for (const [, entry] of this.cache) {
      if (now - entry.checkedAt > STALE_AFTER_MS) continue;
      out.push(entry);
    }
    return out;
  }

  /** Force a refresh for a single node (called when user clicks "check"). */
  async checkNode(nodeId: string): Promise<NodeImageUpdateStatus> {
    const status = await this.probeNode(nodeId);
    this.cache.set(nodeId, status);
    return status;
  }

  private async tick(): Promise<void> {
    try {
      // Poll every online node — remote runners via their API, local Docker
      // in-process (when a DockerRuntime adapter is wired up).
      const nodes = await this.db.query.runtimeNodes.findMany({
        where: inArray(runtimeNodes.kind, ["runner", "local"]),
      });
      for (const node of nodes) {
        if (node.status !== "online") continue;
        // Local probe needs a DockerRuntime adapter; skip when absent (e.g. tests).
        if (node.kind === "local" && !this.docker) continue;
        try {
          const status = await this.probeNode(node.id);
          this.cache.set(node.id, status);
        } catch (err) {
          log.debug("image_update_checker.node_failed", {
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn("image_update_checker.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Collect the image refs to probe for a node: runner + workspace defaults + bound agent images.
   *  Local nodes have no runner container, so the runner image is skipped. */
  private async collectNodeImages(nodeId: string, isLocal: boolean): Promise<string[]> {
    const imageSet = new Set<string>();
    if (!isLocal) imageSet.add(DEFAULT_RUNNER_IMAGE);
    imageSet.add(WORKSPACE_IMAGE_LOCAL || DEFAULT_WORKSPACE_IMAGE);
    const bound = await this.db
      .select({ workspaceImage: agents.workspaceImage })
      .from(agents)
      .where(eq(agents.runtimeNodeId, nodeId));
    for (const row of bound) {
      const img = row.workspaceImage?.trim();
      if (img) imageSet.add(img);
    }
    return [...imageSet];
  }

  private async probeNode(nodeId: string): Promise<NodeImageUpdateStatus> {
    try {
      const node = await this.db.query.runtimeNodes.findFirst({
        where: eq(runtimeNodes.id, nodeId),
      });
      if (!node) throw new Error(`runtime node ${nodeId} not found`);

      const isLocal = node.kind === "local";
      const images = await this.collectNodeImages(nodeId, isLocal);
      let entries: ImageUpdateEntry[];

      if (isLocal) {
        // Local Docker: probe in-process via the adapter (no HTTP hop).
        if (!this.docker) throw new Error("local image probe requires a Docker runtime");
        entries = await this.docker.checkImageUpdates(images);
      } else {
        const { client } = await this.nodes.requireRunnerClient(
          node.tenantId,
          nodeId,
          { allowOffline: true, skipHeartbeatRefresh: true },
        );
        const result = await client.checkImageUpdates({ images });
        entries = result.images ?? [];
      }

      const hasUpdates = entries.some((e) => e.updateAvailable);
      const hasRunningStale = entries.some((e) => e.runningStale);
      return {
        nodeId,
        checkedAt: Date.now(),
        entries,
        hasUpdates,
        hasRunningStale,
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
