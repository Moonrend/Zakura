/**
 * 非 TTY、双向 stdin/stdout：给 ACP JSON-RPC 用。
 * stdout/stderr 走 Docker multiplex；stdin 可写。
 */
import { DockerMuxBinaryParser } from "./shell-job.js";

export type StdioInspect = () => Promise<{ ExitCode?: number | null; Running?: boolean; Pid?: number }>;

export type StdioExecOptions = {
  inspect: StdioInspect;
  killPid?: (pid: number) => Promise<void>;
  /**
   * Prefix the very first write with a newline.
   *
   * Only needed when the stream came from a hijacked `container.attach`:
   * docker-modem serializes the attach options as the HTTP request body, and
   * if Docker upgrades the socket before draining that body it lands on the
   * container's stdin (measured ~13% of attaches). The stray newline forces
   * such a leaked prefix to terminate as its own line, so a line-delimited
   * JSON-RPC peer rejects just that junk line instead of our first frame.
   */
  newlineGuard?: boolean;
};

export class StdioExec {
  readonly id: string;
  private readonly mux = new DockerMuxBinaryParser();
  private readonly stdoutChunks: Uint8Array[] = [];
  private stdoutWaiters: Array<(chunk: Uint8Array | null) => void> = [];
  private exitCode: number | null = null;
  private exited = false;
  private readonly exitWaiters: Array<(code: number | null) => void> = [];
  private readonly stderrListeners = new Set<(chunk: string) => void>();
  private wroteFirst = false;

  constructor(
    readonly stream: NodeJS.ReadWriteStream,
    private readonly opts: StdioExecOptions,
    id?: string,
  ) {
    this.id = id ?? `stdio_${Math.random().toString(36).slice(2, 12)}`;
    stream.on("data", (buf: Buffer) => {
      const { stdout, stderr } = this.mux.push(Buffer.from(buf));
      for (const chunk of stdout) this.pushStdout(chunk);
      for (const chunk of stderr) {
        const text = chunk.toString("utf8");
        for (const fn of this.stderrListeners) fn(text);
      }
    });
    stream.on("end", () => void this.markExit());
    stream.on("error", () => void this.markExit());
  }

  onStderr(fn: (chunk: string) => void): () => void {
    this.stderrListeners.add(fn);
    return () => this.stderrListeners.delete(fn);
  }

  write(data: Uint8Array | string): void {
    if (this.exited) return;
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    if (!this.wroteFirst) {
      this.wroteFirst = true;
      if (this.opts.newlineGuard) {
        this.stream.write(Buffer.from("\n", "utf8"));
      }
    }
    this.stream.write(buf);
  }

  async kill(): Promise<void> {
    try {
      const info = await this.opts.inspect();
      if (info.Pid && this.opts.killPid) await this.opts.killPid(info.Pid);
    } catch {
      /* gone */
    }
    try {
      this.stream.end();
    } catch {
      /* ignore */
    }
    await this.markExit();
  }

  wait(): Promise<number | null> {
    if (this.exited) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  toWebStreams(): {
    writable: WritableStream<Uint8Array>;
    readable: ReadableStream<Uint8Array>;
  } {
    const exec = this;
    return {
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          exec.write(chunk);
        },
      }),
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = exec.stdoutChunks.shift();
          if (next) {
            controller.enqueue(next);
            return;
          }
          if (exec.exited) {
            controller.close();
            return;
          }
          return new Promise<void>((resolve) => {
            exec.stdoutWaiters.push((chunk) => {
              if (chunk) controller.enqueue(chunk);
              else controller.close();
              resolve();
            });
          });
        },
        cancel() {
          void exec.kill();
        },
      }),
    };
  }

  private pushStdout(chunk: Uint8Array) {
    const waiter = this.stdoutWaiters.shift();
    if (waiter) waiter(chunk);
    else this.stdoutChunks.push(chunk);
  }

  private async markExit() {
    if (this.exited) return;
    this.exited = true;
    try {
      const info = await this.opts.inspect();
      this.exitCode = info.ExitCode ?? 0;
    } catch {
      this.exitCode = null;
    }
    for (const w of this.stdoutWaiters.splice(0)) w(null);
    for (const w of this.exitWaiters.splice(0)) w(this.exitCode);
  }
}

export class StdioExecRegistry {
  private readonly jobs = new Map<string, StdioExec>();

  add(job: StdioExec): void {
    this.jobs.set(job.id, job);
    void job.wait().then(() => {
      setTimeout(() => this.jobs.delete(job.id), 60_000);
    });
  }

  get(id: string): StdioExec | undefined {
    return this.jobs.get(id);
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.kill()));
    this.jobs.clear();
  }
}
