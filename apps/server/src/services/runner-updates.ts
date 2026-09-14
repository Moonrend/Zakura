import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RunnerClient } from "@zakura/core";
import { isRunnerUpdateActive, type RunnerUpdateProgress, type RunnerUpdateStatus } from "@zakura/shared";
import type { AgentUpdateTarget } from "./agent-binaries.js";

type UpdateClient = Pick<RunnerClient, "updateRunner" | "systemVersion">;

export class RunnerUpdateConflictError extends Error {}

/** One bounded, observable update per node. HTTP requests never wait for the download. */
export class RunnerUpdates {
  private readonly jobs = new Map<string, RunnerUpdateStatus>();

  constructor(
    private readonly clientFor: (tenantId: string, nodeId: string) => Promise<UpdateClient>,
    private readonly options: { reconnectTimeoutMs?: number; pollIntervalMs?: number } = {},
  ) {}

  get(nodeId: string, id?: string): RunnerUpdateStatus | null {
    const job = this.jobs.get(nodeId);
    return job && (!id || job.id === id) ? { ...job } : null;
  }

  start(tenantId: string, nodeId: string, target: AgentUpdateTarget): RunnerUpdateStatus {
    const current = this.jobs.get(nodeId);
    if (current && isRunnerUpdateActive(current)) {
      if (current.sha256.toLowerCase() !== target.sha256.toLowerCase()) {
        throw new RunnerUpdateConflictError("该节点已有更新正在进行，请等待完成");
      }
      return { ...current };
    }
    const now = Date.now();
    const job: RunnerUpdateStatus = {
      id: randomUUID(), nodeId, version: target.version, sha256: target.sha256,
      phase: "queued", downloadedBytes: 0, totalBytes: 0,
      startedAt: now, updatedAt: now, error: null,
    };
    this.jobs.set(nodeId, job);
    void this.run(tenantId, job, target).catch((error: unknown) => {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
    }).finally(() => {
      const expiry = setTimeout(() => {
        if (this.jobs.get(nodeId) === job) this.jobs.delete(nodeId);
      }, 60 * 60_000);
      expiry.unref();
    });
    return { ...job };
  }

  private async run(tenantId: string, job: RunnerUpdateStatus, target: AgentUpdateTarget): Promise<void> {
    const updateProgress = (progress: RunnerUpdateProgress) => {
      job.phase = progress.phase;
      job.downloadedBytes = Math.max(job.downloadedBytes, progress.downloadedBytes);
      job.totalBytes = Math.max(job.totalBytes, progress.totalBytes);
      job.updatedAt = Date.now();
    };
    const client = await this.clientFor(tenantId, job.nodeId);
    updateProgress({ phase: "downloading", downloadedBytes: 0, totalBytes: 0 });
    let connectionError: unknown;
    try {
      const result = await client.updateRunner({ ...target, image: target.url }, updateProgress);
      job.note = result.note;
    } catch (error) {
      // The process may have restarted before its acknowledgement reached us.
      // A reconnect with the requested digest is the only proof of success.
      if (!/连接|replaced|超时|connection|socket|timed?\s*out|timeout|ECONN/i.test(String(error))) throw error;
      connectionError = error;
    }
    updateProgress({ phase: "restarting", downloadedBytes: job.downloadedBytes, totalBytes: job.totalBytes });
    // Windows may need 30s to stop, retry a locked file and complete a fresh handshake.
    const deadline = Date.now() + (this.options.reconnectTimeoutMs ?? 90_000);
    do {
      let info: Awaited<ReturnType<UpdateClient["systemVersion"]>> | undefined;
      try {
        const live = await this.clientFor(tenantId, job.nodeId);
        info = await live.systemVersion();
      } catch { /* The old session closes before the replacement is ready. */ }
      if (info?.updateError) throw new Error(info.updateError);
      if (info?.sha256?.toLowerCase() === target.sha256.toLowerCase()) {
        job.phase = "completed";
        job.version = info.version;
        job.updatedAt = Date.now();
        return;
      }
      await delay(this.options.pollIntervalMs ?? 1000);
    } while (Date.now() < deadline);
    throw new Error(`更新后未确认目标代理重新上线，请检查设备上的 zakura-agent 日志${connectionError ? `（${String(connectionError)}）` : ""}`);
  }
}
