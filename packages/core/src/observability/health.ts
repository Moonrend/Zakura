export type DependencyStatus = "up" | "down" | "degraded" | "disabled";

export type HealthCheckResult = {
  status: DependencyStatus;
  latencyMs?: number;
  message?: string;
};

export type HealthCheck = () => Promise<HealthCheckResult> | HealthCheckResult;

export type LiveStatus = {
  status: "ok";
  service: string;
  version: string;
  uptimeSec: number;
};

export type ReadyStatus = {
  status: "ready" | "not_ready";
  service: string;
  version: string;
  checks: Record<string, HealthCheckResult>;
};

type RegisteredCheck = {
  name: string;
  check: HealthCheck;
  /** When true, a down result fails readiness. */
  critical: boolean;
  timeoutMs: number;
};

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health check timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HealthRegistry {
  private readonly checks: RegisteredCheck[] = [];
  private booted = false;

  constructor(
    readonly service: string,
    readonly version: string,
    private readonly startedAt = Date.now(),
  ) {}

  register(
    name: string,
    check: HealthCheck,
    opts?: { critical?: boolean; timeoutMs?: number },
  ): void {
    this.checks.push({
      name,
      check,
      critical: opts?.critical ?? true,
      timeoutMs: opts?.timeoutMs ?? 2000,
    });
  }

  /** Process finished bootstrapping and may accept traffic. */
  setReady(ready: boolean): void {
    this.booted = ready;
  }

  isBooted(): boolean {
    return this.booted;
  }

  live(): LiveStatus {
    return {
      status: "ok",
      service: this.service,
      version: this.version,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async ready(): Promise<ReadyStatus> {
    const checks: Record<string, HealthCheckResult> = {};
    let failed = !this.booted;
    if (!this.booted) {
      checks.boot = { status: "down", message: "starting" };
    }

    await Promise.all(
      this.checks.map(async (entry) => {
        const t0 = performance.now();
        try {
          const result = await withTimeout(Promise.resolve(entry.check()), entry.timeoutMs);
          const latencyMs = Math.round(performance.now() - t0);
          checks[entry.name] = { ...result, latencyMs: result.latencyMs ?? latencyMs };
          if (entry.critical && result.status === "down") failed = true;
        } catch (err) {
          checks[entry.name] = {
            status: "down",
            latencyMs: Math.round(performance.now() - t0),
            message: err instanceof Error ? err.message : "check failed",
          };
          if (entry.critical) failed = true;
        }
      }),
    );

    return {
      status: failed ? "not_ready" : "ready",
      service: this.service,
      version: this.version,
      checks,
    };
  }
}
