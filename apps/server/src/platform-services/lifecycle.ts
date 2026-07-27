/**
 * User-facing lifecycle model for platform services.
 * Separates: mode (how) × power (on/off) × health × deploy progress.
 */
import type { PlatformServiceMode } from "@zakura/shared";

export type LifecycleState =
  | "off"
  | "ready"
  | "deploying"
  | "stopping"
  | "available"
  | "degraded"
  | "failed"
  | "external_ok"
  | "external_bad";

export type LifecycleTone = "neutral" | "info" | "success" | "warn" | "danger";

export type LifecycleAction =
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "retry"
  | "connect"
  | "disable"
  | "health"
  | "configure";

export type LifecycleView = {
  state: LifecycleState;
  /** Short badge label */
  label: string;
  /** One-line explanation under the title */
  detail: string;
  tone: LifecycleTone;
  /** True while long-running op in progress */
  busy: boolean;
  actions: LifecycleAction[];
};

export type LifecycleInput = {
  mode: PlatformServiceMode;
  status: string;
  healthStatus: string;
  desiredState: string;
  lastError: string | null;
  endpointUrl: string | null;
  /** In-memory deploy progress if any */
  progressRunning?: boolean;
  progressPhase?: string;
  progressMessage?: string;
};

/**
 * Derive a single primary lifecycle for UI — never show mode/status/health as peers.
 */
export function deriveLifecycle(input: LifecycleInput): LifecycleView {
  const {
    mode,
    status,
    healthStatus,
    lastError,
    endpointUrl,
    progressRunning,
    progressPhase,
    progressMessage,
  } = input;

  if (mode === "disabled") {
    return {
      state: "off",
      label: "未启用",
      detail: "一键在本机 Docker 部署，供「网页」能力选用。",
      tone: "neutral",
      busy: false,
      // external URL is configured on the Web settings page, not here
      actions: ["deploy"],
    };
  }

  const busyStatuses = new Set(["starting", "deploying", "stopping", "pulling"]);
  const isBusy =
    progressRunning === true ||
    busyStatuses.has(status) ||
    (progressPhase != null &&
      !["idle", "done", "error"].includes(progressPhase) &&
      progressRunning !== false);

  if (mode === "external") {
    if (isBusy) {
      return {
        state: "deploying",
        label: "检查中",
        detail: progressMessage || endpointUrl || "",
        tone: "info",
        busy: true,
        actions: [],
      };
    }
    if (healthStatus === "healthy") {
      return {
        state: "external_ok",
        label: "已连接",
        detail: endpointUrl ?? "",
        tone: "success",
        busy: false,
        actions: ["health", "stop", "disable", "configure"],
      };
    }
    if (status === "error" || healthStatus === "unhealthy") {
      return {
        state: "external_bad",
        label: "不可达",
        detail: lastError || endpointUrl || "",
        tone: "danger",
        busy: false,
        actions: ["connect", "health", "disable", "configure"],
      };
    }
    return {
      state: "external_bad",
      label: "未验证",
      detail: endpointUrl || "需要 URL",
      tone: "warn",
      busy: false,
      actions: ["connect", "configure", "disable"],
    };
  }

  // mode === managed
  if (isBusy) {
    if (status === "stopping" || progressPhase === "stopping") {
      return {
        state: "stopping",
        label: "停止中",
        detail: progressMessage || "",
        tone: "info",
        busy: true,
        actions: [],
      };
    }
    const phaseLabel =
      progressPhase === "pulling"
        ? "pull"
        : progressPhase === "creating"
          ? "create"
          : progressPhase === "health"
            ? "health"
            : progressPhase === "checking"
              ? "docker"
              : "deploy";
    return {
      state: "deploying",
      label: phaseLabel,
      detail: progressMessage || "",
      tone: "info",
      busy: true,
      actions: [],
    };
  }

  if (status === "error" || (status === "stopped" && lastError)) {
    return {
      state: "failed",
      label: "失败",
      detail: lastError || "",
      tone: "danger",
      busy: false,
      actions: ["retry", "deploy", "connect", "disable", "configure"],
    };
  }

  if (status === "running") {
    if (healthStatus === "healthy") {
      return {
        state: "available",
        label: "running",
        detail: endpointUrl ?? "",
        tone: "success",
        busy: false,
        actions: ["stop", "restart", "health", "configure", "disable"],
      };
    }
    return {
      state: "degraded",
      label: "unhealthy",
      detail: lastError || endpointUrl || "",
      tone: "warn",
      busy: false,
      actions: ["health", "restart", "stop", "configure"],
    };
  }

  // stopped managed
  return {
    state: "ready",
    label: "stopped",
    detail: "",
    tone: "neutral",
    busy: false,
    actions: ["start", "deploy", "connect", "disable", "configure"],
  };
}
