import type { ContainerSpec } from "@zakura/shared";

export interface RunningContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: Array<{ containerPort: number; hostPort?: number; protocol?: string }>;
  labels: Record<string, string>;
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

  logs(containerId: string, tail?: number): Promise<string>;

  buildSpecName(tenantSlug: string, instanceSlug: string, containerName: string): string;
}
