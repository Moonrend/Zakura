export type RunnerUpdatePhase =
  | "queued" | "downloading" | "verifying" | "installing" | "restarting"
  | "completed" | "failed";

export type RunnerUpdateProgress = {
  phase: RunnerUpdatePhase;
  downloadedBytes: number;
  /** Zero when the download server does not report a content length. */
  totalBytes: number;
};

export type RunnerUpdateStatus = RunnerUpdateProgress & {
  id: string;
  nodeId: string;
  version: string;
  sha256: string;
  startedAt: number;
  updatedAt: number;
  error: string | null;
  note?: string;
};

export function isRunnerUpdateActive(status: RunnerUpdateProgress): boolean {
  return status.phase !== "completed" && status.phase !== "failed";
}
