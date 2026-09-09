import type { DockerPullEvent } from "../../runtime/docker.js";

export type AcpAdapterInstallState = "queued" | "pulling" | "completed" | "failed";

export interface AcpAdapterInstallProgress {
  profileId: string;
  registryId?: string;
  image?: string;
  state: AcpAdapterInstallState;
  /** Download progress. Null means Docker has not announced layer sizes yet. */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
}

interface LayerProgress {
  current: number;
  total: number;
  complete: boolean;
}

/** Convert Dockerode layer events into a stable aggregate download percentage. */
export class AcpImagePullProgressTracker {
  private readonly layers = new Map<string, LayerProgress>();
  private maximumPercent = 0;

  update(
    line: string,
    event?: DockerPullEvent,
  ): Pick<
    AcpAdapterInstallProgress,
    "state" | "percent" | "downloadedBytes" | "totalBytes" | "message"
  > {
    const phase = event?.zakura?.phase;
    const status = event?.status?.trim() || line.trim() || "正在拉取镜像";
    if (phase === "queued") {
      return this.snapshot("queued", status);
    }
    if (phase === "present") {
      return this.snapshot("pulling", status);
    }

    const id = event?.id?.trim();
    if (id) {
      const previous = this.layers.get(id) ?? { current: 0, total: 0, complete: false };
      const current = event?.progressDetail?.current;
      const total = event?.progressDetail?.total;
      // Extraction reports expanded-byte counts. Only aggregate the compressed
      // download phase, otherwise a layer is counted twice and progress jumps.
      if (/pulling fs layer|waiting/i.test(status)) {
        this.layers.set(id, previous);
      } else if (/already exists/i.test(status)) {
        previous.complete = true;
        this.layers.set(id, previous);
      } else if (/download/i.test(status)) {
        if (typeof total === "number" && Number.isFinite(total) && total > 0) {
          previous.total = Math.max(previous.total, total);
        }
        if (typeof current === "number" && Number.isFinite(current) && current >= 0) {
          previous.current = Math.max(previous.current, current);
        }
        if (/download complete/i.test(status)) {
          previous.complete = true;
          if (previous.total > 0) previous.current = previous.total;
        }
        this.layers.set(id, previous);
      } else if (/pull complete/i.test(status)) {
        previous.complete = true;
        if (previous.total > 0) previous.current = previous.total;
        this.layers.set(id, previous);
      }
    }

    return this.snapshot("pulling", status);
  }

  complete(message = "镜像拉取完成"): Pick<
    AcpAdapterInstallProgress,
    "state" | "percent" | "downloadedBytes" | "totalBytes" | "message"
  > {
    const snapshot = this.snapshot("completed", message);
    return { ...snapshot, percent: 100 };
  }

  private snapshot(
    state: AcpAdapterInstallState,
    message: string,
  ): Pick<
    AcpAdapterInstallProgress,
    "state" | "percent" | "downloadedBytes" | "totalBytes" | "message"
  > {
    let downloadedBytes = 0;
    let totalBytes = 0;
    let hasUnknownLayer = false;
    for (const layer of this.layers.values()) {
      if (layer.total <= 0) {
        if (!layer.complete) hasUnknownLayer = true;
        continue;
      }
      totalBytes += layer.total;
      downloadedBytes += Math.min(layer.current, layer.total);
    }

    let percent: number | null = null;
    if (totalBytes > 0 && !hasUnknownLayer) {
      // Docker discovers layers incrementally. Keep the UI monotonic and reserve
      // 100% for followProgress completion.
      const measured = Math.min(99.9, (downloadedBytes / totalBytes) * 100);
      this.maximumPercent = Math.max(this.maximumPercent, measured);
      percent = Math.round(this.maximumPercent * 10) / 10;
    }
    return { state, percent, downloadedBytes, totalBytes, message };
  }
}
