import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type DockerContextConfig = {
  currentContext?: unknown;
};

type DockerContextMeta = {
  Endpoints?: {
    docker?: {
      Host?: unknown;
    };
  };
};

export type DockerContextSocketOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function socketPathFromHost(host: string): string | undefined {
  if (host.startsWith("npipe://")) {
    return host.slice("npipe://".length) || undefined;
  }
  if (host.startsWith("unix://")) {
    return host.slice("unix://".length) || undefined;
  }
  return undefined;
}

/**
 * Resolve the socket selected by the Docker CLI context.
 *
 * dockerode still defaults to `//./pipe/docker_engine` on Windows, while
 * Docker Desktop normally selects `desktop-linux` and exposes
 * `//./pipe/dockerDesktopLinuxEngine`. Keep dockerode on the same endpoint as
 * `docker` without spawning the CLI. Explicit DOCKER_HOST remains owned by
 * dockerode and takes precedence.
 */
export function resolveDockerContextSocketPath(
  options: DockerContextSocketOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  if (env.DOCKER_HOST?.trim()) return undefined;

  const dockerConfigDir = env.DOCKER_CONFIG?.trim() || join(options.homeDir ?? homedir(), ".docker");
  const cliConfig = readJson(join(dockerConfigDir, "config.json")) as DockerContextConfig | null;
  const configuredContext =
    typeof cliConfig?.currentContext === "string" ? cliConfig.currentContext.trim() : "";
  const contextName = env.DOCKER_CONTEXT?.trim() || configuredContext;
  if (!contextName || contextName === "default") return undefined;

  const contextHash = createHash("sha256").update(contextName).digest("hex");
  const meta = readJson(
    join(dockerConfigDir, "contexts", "meta", contextHash, "meta.json"),
  ) as DockerContextMeta | null;
  const host = meta?.Endpoints?.docker?.Host;
  return typeof host === "string" ? socketPathFromHost(host.trim()) : undefined;
}
