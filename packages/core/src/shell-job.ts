import { randomBytes } from "node:crypto";
import { PtyFolder } from "@zakura/shared";

const OUTPUT_CAP = 256_000;
const TRUNC_MARK = "\n…(truncated)\n";

export type ShellJobSnapshot = {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
  /** Append-only raw PTY stream for a real terminal emulator. */
  terminalOutput?: string;
  /** Absolute character offset of terminalOutput[0]. */
  terminalOffset?: number;
};

export function newShellJobId(): string {
  return `sh_${randomBytes(8).toString("hex")}`;
}

/** Incremental Docker multiplex parser. TTY (raw) and hijack frames both work. */
export class DockerMuxParser {
  private pending: Buffer = Buffer.alloc(0);
  private raw: boolean | null = null;

  push(chunk: Buffer): { stdout: string; stderr: string } {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.raw == null) {
      if (this.pending.length < 8) {
        if (this.pending.length > 0 && this.pending[0]! > 2) this.raw = true;
        else return { stdout: "", stderr: "" };
      } else {
        this.raw = !(
          this.pending[0]! <= 2 &&
          this.pending[1] === 0 &&
          this.pending[2] === 0 &&
          this.pending[3] === 0
        );
      }
    }
    if (this.raw) {
      const text = this.pending.toString("utf8");
      this.pending = Buffer.alloc(0);
      return { stdout: text, stderr: "" };
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= this.pending.length) {
      const streamType = this.pending[offset]!;
      const size = this.pending.readUInt32BE(offset + 4);
      if (offset + 8 + size > this.pending.length) break;
      const payload = this.pending.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size;
      if (streamType === 1) stdout.push(payload);
      else if (streamType === 2) stderr.push(payload);
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
    return {
      stdout: stdout.length ? Buffer.concat(stdout).toString("utf8") : "",
      stderr: stderr.length ? Buffer.concat(stderr).toString("utf8") : "",
    };
  }
}

export class ShellJob {
  readonly id: string;
  readonly agentId: string;
  private stdoutFold = new PtyFolder();
  private stderrFold = new PtyFolder();
  private exitCode: number | null = null;
  private running = true;
  private timedOut = false;
  private startedAt = Date.now();
  private lastOutputAt = Date.now();
  private hasOutput = false;
  private waiters = new Set<() => void>();
  private writeFn: ((data: string) => void) | null = null;
  private killFn: (() => Promise<void>) | null = null;
  private resizeFn: ((cols: number, rows: number) => Promise<void>) | null = null;
  private onOutput: ((snap: ShellJobSnapshot) => void) | null = null;
  private throttleMs = 400;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  private terminalOutput = "";
  private terminalOffset = 0;

  constructor(opts: { id?: string; agentId: string }) {
    this.id = opts.id ?? newShellJobId();
    this.agentId = opts.agentId;
  }

  snapshot(): ShellJobSnapshot {
    return {
      jobId: this.id,
      running: this.running,
      exitCode: this.exitCode,
      stdout: this.stdoutFold.text(),
      stderr: this.stderrFold.text(),
      timedOut: this.timedOut,
      elapsedMs: Date.now() - this.startedAt,
      terminalOutput: this.terminalOutput,
      terminalOffset: this.terminalOffset,
    };
  }

  append(stream: "stdout" | "stderr", text: string): void {
    if (!text || this.finished) return;
    const fold = stream === "stdout" ? this.stdoutFold : this.stderrFold;
    fold.push(text);
    fold.compact(OUTPUT_CAP, TRUNC_MARK);
    this.terminalOutput += text;
    if (this.terminalOutput.length > OUTPUT_CAP) {
      const removed = this.terminalOutput.length - OUTPUT_CAP;
      this.terminalOutput = this.terminalOutput.slice(removed);
      this.terminalOffset += removed;
    }
    this.lastOutputAt = Date.now();
    this.hasOutput = true;
    this.scheduleOutput();
  }

  finish(exitCode: number, timedOut = false): void {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this.exitCode = exitCode;
    if (timedOut) this.timedOut = true;
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.onOutput?.(this.snapshot());
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  markTimedOut(): void {
    this.timedOut = true;
  }

  setIO(io: { write: (data: string) => void; kill: () => Promise<void>; resize?: (cols: number, rows: number) => Promise<void> }): void {
    this.writeFn = io.write;
    this.killFn = io.kill;
    this.resizeFn = io.resize ?? null;
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this.running || !this.resizeFn) return;
    await this.resizeFn(Math.max(2, Math.min(500, Math.floor(cols))), Math.max(2, Math.min(300, Math.floor(rows))));
  }

  setOnOutput(cb: ((snap: ShellJobSnapshot) => void) | null, throttleMs = 400): void {
    this.onOutput = cb;
    this.throttleMs = throttleMs;
  }

  write(data: string): void {
    if (!this.running || !data) return;
    this.writeFn?.(data);
  }

  async kill(): Promise<void> {
    this.markTimedOut();
    try {
      await this.killFn?.();
    } catch {
      /* stream may already be gone */
    }
    if (this.running) this.finish(124, true);
  }

  /**
   * Wait until exit, maxMs, idle-after-output, or startup silence.
   * Idle yield lets the agent see prompts without waiting out the hard timeout.
   */
  wait(
    maxMs: number,
    opts?: { idleMs?: number; startupIdleMs?: number },
  ): Promise<ShellJobSnapshot> {
    if (!this.running || maxMs <= 0) return Promise.resolve(this.snapshot());
    const idleMs = opts?.idleMs ?? 8_000;
    const startupIdleMs = opts?.startupIdleMs ?? 20_000;
    const deadline = Date.now() + maxMs;
    const waitStartedAt = Date.now();
    return new Promise((resolve) => {
      const done = () => {
        clearInterval(tick);
        this.waiters.delete(done);
        resolve(this.snapshot());
      };
      const tick = setInterval(() => {
        if (!this.running) {
          done();
          return;
        }
        const now = Date.now();
        if (now >= deadline) {
          done();
          return;
        }
        const last = Math.max(this.lastOutputAt, waitStartedAt);
        const silent = now - last;
        if (this.hasOutput && silent >= idleMs) {
          done();
          return;
        }
        if (!this.hasOutput && now - this.startedAt >= startupIdleMs) {
          done();
          return;
        }
      }, 150);
      this.waiters.add(done);
    });
  }

  private scheduleOutput(): void {
    if (!this.onOutput) return;
    const now = Date.now();
    if (now - this.lastEmit >= this.throttleMs) {
      this.lastEmit = now;
      this.onOutput(this.snapshot());
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.lastEmit = Date.now();
      this.onOutput?.(this.snapshot());
    }, this.throttleMs - (now - this.lastEmit));
  }
}

export class ShellJobRegistry {
  private jobs = new Map<string, ShellJob>();

  add(job: ShellJob): void {
    this.jobs.set(job.id, job);
  }

  get(id: string): ShellJob | undefined {
    return this.jobs.get(id);
  }

  /** Agent-scoped lookup: refuse cross-agent job ids. */
  getForAgent(agentId: string, id: string): ShellJob | undefined {
    const job = this.jobs.get(id);
    return job?.agentId === agentId ? job : undefined;
  }

  remove(id: string): void {
    this.jobs.delete(id);
  }

  listByAgent(agentId: string): ShellJob[] {
    return [...this.jobs.values()].filter((j) => j.agentId === agentId);
  }

  async killAgent(agentId: string): Promise<void> {
    const jobs = this.listByAgent(agentId);
    await Promise.all(jobs.map((j) => j.kill()));
    for (const j of jobs) this.jobs.delete(j.id);
  }
}

const PROGRESS_TAIL = 16_000;

export function tailText(s: string, n = PROGRESS_TAIL): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

export function formatShellToolResult(snap: ShellJobSnapshot): Record<string, unknown> {
  const status = snap.running ? "running" : snap.timedOut ? "timeout" : "exited";
  const out: Record<string, unknown> = {
    status,
    job_id: snap.jobId,
    exitCode: snap.exitCode,
    stdout: snap.stdout,
    stderr: snap.stderr,
    elapsed_ms: snap.elapsedMs,
  };
  if (snap.running) {
    out.note =
      "Command still running. The user can see live output. Call re_shell_exec again with job_id to wait longer, pass stdin (include a trailing newline) to answer prompts, or kill=true to stop it.";
  } else if (snap.timedOut) {
    out.note = "Hard timeout: process was terminated.";
  }
  return out;
}

/** Wire a dockerode hijack stream to a ShellJob. */
export function bindExecStream(
  job: ShellJob,
  stream: NodeJS.ReadWriteStream & { destroy?: () => void; resume?: () => void },
  opts: {
    inspect: () => Promise<{ ExitCode?: number | null; Pid?: number }>;
    killPid?: (pid: number) => Promise<void>;
    resize?: (cols: number, rows: number) => Promise<void>;
  },
): void {
  const mux = new DockerMuxParser();
  stream.on("data", (c: Buffer | string) => {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    const { stdout, stderr } = mux.push(buf);
    if (stdout) job.append("stdout", stdout);
    if (stderr) job.append("stderr", stderr);
  });
  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    void opts
      .inspect()
      .then((info) => {
        const snap = job.snapshot();
        if (!snap.running) return;
        job.finish(info.ExitCode ?? (snap.timedOut ? 124 : 0), snap.timedOut);
      })
      .catch(() => {
        if (job.snapshot().running) job.finish(-1);
      });
  };
  stream.on("end", onEnd);
  stream.on("close", onEnd);
  stream.on("error", () => {
    if (job.snapshot().running) job.finish(-1);
  });
  stream.resume?.();
  job.setIO({
    write: (data) => {
      try {
        stream.write(data, "utf8");
      } catch {
        /* closed */
      }
    },
    kill: async () => {
      let pid: number | undefined;
      try {
        const info = await opts.inspect();
        pid = typeof info.Pid === "number" && info.Pid > 0 ? info.Pid : undefined;
      } catch {
        /* ignore */
      }
      try {
        stream.write("\x03");
      } catch {
        /* ignore */
      }
      if (pid && opts.killPid) {
        try {
          await opts.killPid(pid);
        } catch {
          /* ignore */
        }
      }
      try {
        stream.destroy?.();
      } catch {
        /* ignore */
      }
    },
    resize: opts.resize,
  });
}
