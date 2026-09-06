import type { ContainerSpec } from "@zakura/shared";
import type { StdioExec } from "./stdio-exec.js";

export interface RunningContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  labels: Record<string, string>;
  mounts?: Array<{ source: string; target: string; mode?: string; type?: string }>;
}

export interface CreateContainerOptions {
  tenantId: string;
  instanceId?: string;
  purpose: string;
  allocatedTo?: string;
  spec: ContainerSpec;
}

/**
 * Runtime adapter — Local Docker；远程 Runner 走独立节点 API。
 * Keep orchestration behind this interface for extensibility.
 */
export interface ContainerRuntime {
  readonly kind: string;

  ping(): Promise<{ ok: true; version: string } | { ok: false; error: string }>;

  ensureNetwork(name: string): Promise<void>;

  ensureImage(image: string): Promise<void>;

  createAndStart(opts: CreateContainerOptions): Promise<RunningContainer>;

  stop(containerId: string): Promise<void>;

  remove(containerId: string, force?: boolean): Promise<void>;

  inspect(containerId: string): Promise<RunningContainer | null>;

  list(filters?: { tenantId?: string; instanceId?: string; purpose?: string }): Promise<RunningContainer[]>;

  exec(
    containerId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  /**
   * 非 TTY 双向 stdio（ACP JSON-RPC over stdin/stdout）。
   * Caller 负责进程生命周期（kill / 等待退出）。
   * Runtime 不支持时可省略；调用方需按 optional 处理。
   */
  execStdio?(
    containerId: string,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string> },
  ): Promise<StdioExec>;

  /**
   * Attach 到容器主进程（CMD）的 stdin/stdout/stderr。
   * 用于 adapter 即容器 CMD 的场景（ACP JSON-RPC over stdio）。
   * 与 execStdio 不同，这里不新起进程，而是接管已运行的 PID 1。
   * Runtime 不支持时可省略；调用方需按 optional 处理。
   */
  attachStdio?(containerId: string): Promise<StdioExec>;

  logs(containerId: string, tail?: number): Promise<string>;

  buildSpecName(tenantSlug: string, instanceSlug: string, containerName: string): string;
}
