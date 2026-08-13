import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { initTelemetry, log } from "@zakura/core";
import { createAuthConfig } from "./auth.js";
import { createRunnerApp } from "./app.js";
import { startServerSync } from "./server-sync.js";

const VERSION = "0.1.0";

export type RunnerLaunchOptions = {
  port?: number;
  host?: string;
  storageRoot?: string;
  token?: string;
  publicUrl?: string;
  serverUrl?: string;
};

export function loadRunnerEnv(): Required<
  Pick<RunnerLaunchOptions, "port" | "host" | "storageRoot" | "token">
> &
  Pick<RunnerLaunchOptions, "publicUrl" | "serverUrl"> {
  const token = process.env.ZAKURA_RUNNER_TOKEN ?? "";
  if (!token) {
    throw new Error("ZAKURA_RUNNER_TOKEN is required (rnr_*)");
  }
  const storageRoot = resolve(
    process.env.ZAKURA_RUNNER_STORAGE_ROOT ?? "./data/runner-storage",
  );
  return {
    port: Number(process.env.ZAKURA_RUNNER_PORT ?? 7443),
    host: process.env.ZAKURA_RUNNER_HOST ?? "0.0.0.0",
    storageRoot,
    token,
    publicUrl: process.env.ZAKURA_RUNNER_PUBLIC_URL,
    serverUrl: process.env.ZAKURA_RUNNER_SERVER_URL,
  };
}

export async function startRunner(opts?: RunnerLaunchOptions): Promise<{
  port: number;
  host: string;
  storageRoot: string;
  close: () => Promise<void>;
}> {
  const env = opts?.token
    ? {
        port: opts.port ?? 7443,
        host: opts.host ?? "0.0.0.0",
        storageRoot: resolve(opts.storageRoot ?? "./data/runner-storage"),
        token: opts.token,
        publicUrl: opts.publicUrl,
        serverUrl: opts.serverUrl,
      }
    : loadRunnerEnv();

  mkdirSync(env.storageRoot, { recursive: true });
  const telemetry = initTelemetry({ service: "zakura-runner", version: VERSION });
  const auth = createAuthConfig(env.token);
  const app = createRunnerApp({
    storageRoot: env.storageRoot,
    token: env.token,
    auth,
    version: VERSION,
    publicUrl: env.publicUrl,
    serverUrl: env.serverUrl,
  });

  log.info("process.starting", { version: VERSION, bind_port: env.port });

  return new Promise((resolvePromise, reject) => {
    const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
      telemetry.health.setReady(true);
      log.info("process.ready", {
        version: VERSION,
        bind_host: info.address,
        bind_port: info.port,
      });

      let stopSync: (() => void) | undefined;
      const serverUrl = env.serverUrl?.trim();
      if (serverUrl) {
        stopSync = startServerSync({
          serverUrl,
          token: env.token,
          storageRoot: env.storageRoot,
          version: VERSION,
          publicUrl: env.publicUrl,
        }).stop;
      } else {
        log.warn("runner.sync_disabled");
      }

      resolvePromise({
        port: info.port,
        host: info.address,
        storageRoot: env.storageRoot,
        close: () =>
          new Promise<void>((res, rej) => {
            stopSync?.();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.on("error", reject);
  });
}

// Only auto-start when this file is the process entrypoint (not when imported by tests).
const isDirectRun =
  typeof process.argv[1] === "string" &&
  /[/\\]apps[/\\]runner[/\\]src[/\\]index\.(ts|js)$/.test(process.argv[1]);

if (isDirectRun) {
  startRunner().catch((err) => {
    log.fatal("process.fatal", { err });
    process.exit(1);
  });
}
