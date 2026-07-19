/**
 * Host Tailscale join helper.
 *
 * - OSS + Tailscale cloud: host may optionally join tenant tailnet (CLI or Docker sidecar).
 * - SaaS + platform Headscale: host joins shared tailnet as tag:platform.
 * - SaaS + Tailscale cloud: host never joins (returns publicBaseUrl).
 */
import Docker from "dockerode";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { demuxDockerExecOutput } from "../runtime/docker.js";
import { probeTailscaleBackend } from "../tunnel/tailscale-serve.js";
import { HEADSCALE_PLATFORM_TAG } from "./headscale-admin.js";

export const HOST_TAILSCALE_CONTAINER = "zakura-host-ts";
export const HOST_TAILSCALE_HOSTNAME = "zakura-server";

const IP_CACHE_TTL_MS = 5 * 60_000;

type IpCache = { ip: string; at: number; key: string };

function dockerErr(err: unknown): Error {
  if (!err || typeof err !== "object") return new Error(String(err));
  const e = err as { message?: string; json?: { message?: string } };
  return new Error(e.json?.message || e.message || String(err));
}

function buildExtraArgs(opts: { tags?: string[]; loginServer?: string }): string {
  const parts: string[] = ["--accept-routes"];
  const login = opts.loginServer?.trim().replace(/\/+$/, "");
  if (login) parts.unshift(`--login-server=${login}`);
  const tagList = (opts.tags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("tag:") ? t : `tag:${t}`));
  if (tagList.length) parts.push(`--advertise-tags=${tagList.join(",")}`);
  return parts.join(" ");
}

export class HostTailscaleService {
  private readonly docker: Docker;
  private cache: IpCache | null = null;

  constructor(private readonly config: AppConfig) {
    this.docker = new Docker();
  }

  /**
   * Whether this deployment should join a mesh from the control-plane host.
   * Platform Headscale is the SaaS exception (caller sets platformHeadscale).
   */
  hostMayJoinMesh(opts?: { platformHeadscale?: boolean }): boolean {
    if (opts?.platformHeadscale) return true;
    return !this.config.multiTenant;
  }

  /** Resolve http(s) URL runners should dial when Tailscale is enabled. */
  async resolveServerUrl(opts: {
    authKey: string;
    tags?: string[];
    loginServer?: string;
    /** SaaS + Headscale platform mode */
    platformHeadscale?: boolean;
  }): Promise<string> {
    if (!this.hostMayJoinMesh({ platformHeadscale: opts.platformHeadscale })) {
      return this.config.publicBaseUrl;
    }
    const ip = await this.ensureAndGetIp(opts).catch(() => null);
    if (!ip) return this.config.publicBaseUrl;
    return `http://${ip}:${this.config.port}`;
  }

  async ensureAndGetIp(opts: {
    authKey: string;
    tags?: string[];
    loginServer?: string;
    platformHeadscale?: boolean;
  }): Promise<string | null> {
    if (!this.hostMayJoinMesh({ platformHeadscale: opts.platformHeadscale })) {
      return null;
    }

    const cacheKey = [
      opts.loginServer ?? "",
      opts.authKey.slice(0, 12),
      (opts.tags ?? []).join(","),
    ].join("|");
    const now = Date.now();
    if (this.cache && this.cache.key === cacheKey && now - this.cache.at < IP_CACHE_TTL_MS) {
      return this.cache.ip;
    }

    // Host CLI only when not forcing a custom login-server (Headscale)
    if (!opts.loginServer?.trim()) {
      const fromCli = await this.ipFromHostCli();
      if (fromCli) {
        this.cache = { ip: fromCli, at: now, key: cacheKey };
        return fromCli;
      }
    }

    const fromCtr = await this.ensureContainerAndGetIp(opts);
    if (fromCtr) {
      this.cache = { ip: fromCtr, at: now, key: cacheKey };
      return fromCtr;
    }
    return null;
  }

  /**
   * Ensure platform host is on Headscale as tag:platform.
   * Auth key comes from platform settings (DB) or a freshly minted key.
   */
  async ensurePlatformHost(opts: {
    authKey: string;
    loginServer: string;
  }): Promise<string | null> {
    return this.ensureAndGetIp({
      authKey: opts.authKey,
      loginServer: opts.loginServer,
      tags: [HEADSCALE_PLATFORM_TAG],
      platformHeadscale: true,
    });
  }

  private async ipFromHostCli(): Promise<string | null> {
    const probe = await probeTailscaleBackend();
    if (probe.ok && probe.ip) return probe.ip;
    return null;
  }

  private async ensureContainerAndGetIp(opts: {
    authKey: string;
    tags?: string[];
    loginServer?: string;
  }): Promise<string | null> {
    const authKey = opts.authKey.trim();
    if (!authKey) return null;

    try {
      await this.ensureImage(
        process.env.ZAKURA_TAILSCALE_IMAGE?.trim() || "tailscale/tailscale:latest",
      );
    } catch (err) {
      console.warn("[host-tailscale] pull image failed:", dockerErr(err).message);
      return null;
    }

    const stateDir = join(this.config.dataDir, "host-tailscale");
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const image =
      process.env.ZAKURA_TAILSCALE_IMAGE?.trim() || "tailscale/tailscale:latest";
    const extraArgs = buildExtraArgs({
      tags: opts.tags,
      loginServer: opts.loginServer,
    });

    let container = this.docker.getContainer(HOST_TAILSCALE_CONTAINER);
    let exists = false;
    try {
      await container.inspect();
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        container = await this.docker.createContainer({
          name: HOST_TAILSCALE_CONTAINER,
          Image: image,
          Hostname: HOST_TAILSCALE_HOSTNAME,
          Env: [
            `TS_AUTHKEY=${authKey}`,
            `TS_HOSTNAME=${HOST_TAILSCALE_HOSTNAME}`,
            "TS_STATE_DIR=/var/lib/tailscale",
            "TS_USERSPACE=true",
            `TS_EXTRA_ARGS=${extraArgs}`,
          ],
          HostConfig: {
            RestartPolicy: { Name: "unless-stopped" },
            Binds: [`${stateDir}:/var/lib/tailscale`],
            NetworkMode: process.platform === "linux" ? "host" : "bridge",
            CapAdd: ["NET_ADMIN", "NET_RAW"],
          },
          Labels: {
            "zakura.managed": "true",
            "zakura.purpose": "host-tailscale",
          },
        });
      } catch (err) {
        console.warn("[host-tailscale] create failed:", dockerErr(err).message);
        return null;
      }
    }

    try {
      const info = await container.inspect();
      if (!info.State?.Running) {
        await container.start();
      }
    } catch (err) {
      console.warn("[host-tailscale] start failed:", dockerErr(err).message);
      return null;
    }

    for (let i = 0; i < 10; i++) {
      const ip = await this.ipFromContainer(container);
      if (ip) return ip;
      await sleep(1_000);
    }
    return null;
  }

  private async ipFromContainer(container: Docker.Container): Promise<string | null> {
    try {
      const exec = await container.exec({
        Cmd: ["tailscale", "ip", "-4"],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve());
        stream.on("error", reject);
      });
      const inspect = await exec.inspect();
      void inspect;
      const demuxed = demuxDockerExecOutput(Buffer.concat(chunks));
      const text = `${demuxed.stdout}\n${demuxed.stderr}`.trim();
      const m = text.match(/\b(100\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      /* pull */
    }
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(dockerErr(err));
          return;
        }
        this.docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) reject(dockerErr(err2));
          else resolve();
        });
      });
    });
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
