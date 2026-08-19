/**
 * Background image-update checker: periodically polls all online remote
 * runners to detect whether their local images (runner + workspace) have
 * newer versions available on the registry. Results are cached in-memory
 * and exposed via the API for the UI to show update banners.
 */
import { log } from "@zakura/core";
import { eq } from "drizzle-orm";
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
  error: string | null;
};

export type NodeImageUpdateStatus = {
  nodeId: string;
  checkedAt: number;
  entries: ImageUpdateEntry[];
  hasUpdates: boolean;
  error: string | null;
};

export class ImageUpdateChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cache = new Map<string, NodeImageUpdateStatus>();

  constructor(
    private readonly db: Db,
    private readonly nodes: RuntimeNodeService,
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
      const onlineRunners = await this.db.query.runtimeNodes.findMany({
        where: eq(runtimeNodes.kind, "runner"),
      });
      for (const node of onlineRunners) {
        if (node.status !== "online") continue;
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

  private async probeNode(nodeId: string): Promise<NodeImageUpdateStatus> {
    try {
      const { client } = await this.nodes.requireRunnerClient(
        // tenantId is not known here; use the node's tenantId from DB
        // (requireRunnerClient accepts tenantId for access control)
        await this.getNodeTenantId(nodeId),
        nodeId,
        { allowOffline: true, skipHeartbeatRefresh: true },
      );

      // Collect images to probe
      const imageSet = new Set<string>();
      imageSet.add(DEFAULT_RUNNER_IMAGE);
      imageSet.add(WORKSPACE_IMAGE_LOCAL || DEFAULT_WORKSPACE_IMAGE);

      // Add workspace images from agents bound to this node
      const bound = await this.db
        .select({ workspaceImage: agents.workspaceImage })
        .from(agents)
        .where(eq(agents.runtimeNodeId, nodeId));
      for (const row of bound) {
        const img = row.workspaceImage?.trim();
        if (img) imageSet.add(img);
      }

      const result = await client.checkImageUpdates({ images: [...imageSet] });
      const entries = result.images ?? [];
      const hasUpdates = entries.some((e) => e.updateAvailable);
      return {
        nodeId,
        checkedAt: Date.now(),
        entries,
        hasUpdates,
        error: null,
      };
    } catch (err) {
      return {
        nodeId,
        checkedAt: Date.now(),
        entries: [],
        hasUpdates: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async getNodeTenantId(nodeId: string): Promise<string> {
    const node = await this.db.query.runtimeNodes.findFirst({
      where: eq(runtimeNodes.id, nodeId),
    });
    if (!node) throw new Error(`runtime node ${nodeId} not found`);
    return node.tenantId;
  }
}
