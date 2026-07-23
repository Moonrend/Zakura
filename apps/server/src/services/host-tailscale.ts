/**
 * Host Tailscale / Headscale 数据面加入。
 *
 * 设计前提（平台自托管 Headscale）：
 * - 云端主机同时是 Headscale **控制面**；数据面应加入**同一张** Headscale 网（tag:platform）
 * - 使用 **host 网络 + kernel TUN**（TS_USERSPACE=false），让宿主机出现 tailscale0，
 *   这样 Docker bridge 上的 zakura 可经主机转发直连 Runner 的 100.64/10
 * - Headscale preauthkey 已带 acl_tags 时 **禁止**再传 --advertise-tags（0.29+ 会拒绝）
 * - 控制面主机上不应再跑「个人 Tailscale」内核客户端抢同一 TUN/100.x；否则请迁走个人网
 *
 * 其他模式：
 * - OSS + Tailscale 官方云：可先试宿主机 CLI；否则 sidecar
 * - SaaS + Tailscale 官方云：主机不加入租户网
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

/** userspace SOCKS（仅非平台兜底）；平台模式不用 */
export const HOST_TAILSCALE_SOCKS_PORT = 1055;

const IP_CACHE_TTL_MS = 5 * 60_000;

type IpCache = { ip: string; at: number; key: string };

function dockerErr(err: unknown): Error {
  if (!err || typeof err !== "object") return new Error(String(err));
  const e = err as { message?: string; json?: { message?: string } };
  return new Error(e.json?.message || e.message || String(err));
}

function buildExtraArgs(opts: {
  tags?: string[];
  loginServer?: string;
  /**
   * Headscale preauthkey 已带 acl_tags 时必须为 false。
   * 官方 Tailscale 云可按需 advertise。
   */
  advertiseTags?: boolean;
}): string {
  const parts: string[] = ["--accept-routes"];
  const login = opts.loginServer?.trim().replace(/\/+$/, "");
  if (login) parts.unshift(`--login-server=${login}`);
  if (opts.advertiseTags) {
    const tagList = (opts.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith("tag:") ? t : `tag:${t}`));
    if (tagList.length) parts.push(`--advertise-tags=${tagList.join(",")}`);
  }
  return parts.join(" ");
}

function isHeadscaleLogin(loginServer?: string): boolean {
  return Boolean(loginServer?.trim());
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
      opts.platformHeadscale ? "platform" : "mesh",
    ].join("|");
    const now = Date.now();
    if (this.cache && this.cache.key === cacheKey && now - this.cache.at < IP_CACHE_TTL_MS) {
      return this.cache.ip;
    }

    // 非 Headscale：可先用宿主机已登录的官方 Tailscale CLI
    if (!isHeadscaleLogin(opts.loginServer)) {
      const fromCli = await this.ipFromHostCli();
      if (fromCli) {
        this.cache = { ip: fromCli, at: now, key: cacheKey };
        return fromCli;
      }
    }

    const fromCtr = await this.ensureContainerAndGetIp({
      ...opts,
      platformHeadscale: Boolean(opts.platformHeadscale || isHeadscaleLogin(opts.loginServer)),
    });
    if (fromCtr) {
      this.cache = { ip: fromCtr, at: now, key: cacheKey };
      return fromCtr;
    }
    return null;
  }

  /**
   * Ensure platform host is on Headscale as tag:platform.
   * Auth key comes from platform settings (DB) or a freshly minted key（须含 acl_tags）。
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
    platformHeadscale?: boolean;
  }): Promise<string | null> {
    const authKey = opts.authKey.trim();
    if (!authKey) return null;

    const platform = Boolean(opts.platformHeadscale);
    // 平台 Headscale：标签只来自 preauthkey，禁止 --advertise-tags
    const advertiseTags = !platform && !isHeadscaleLogin(opts.loginServer);
    const extraArgs = buildExtraArgs({
      tags: opts.tags,
      loginServer: opts.loginServer,
      advertiseTags,
    });

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

    let container = this.docker.getContainer(HOST_TAILSCALE_CONTAINER);
    let exists = false;
    try {
      const info = await container.inspect();
      exists = true;
      if (platform && this.platformContainerNeedsRecreate(info, extraArgs)) {
        console.warn(
          "[host-tailscale] recreating platform sidecar (need host net + kernel TUN, no advertise-tags)",
        );
        try {
          await container.stop({ t: 5 }).catch(() => undefined);
          await container.remove({ force: true });
        } catch (err) {
          console.warn("[host-tailscale] remove old container failed:", dockerErr(err).message);
          return null;
        }
        exists = false;
      }
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        container = await this.createMeshContainer({
          image,
          authKey,
          extraArgs,
          stateDir,
          platform,
        });
      } catch (err) {
        console.warn("[host-tailscale] create failed:", dockerErr(err).message);
        if (platform) {
          console.warn(
            "[host-tailscale] 平台模式需要宿主机 /dev/net/tun。" +
              "若本机已有个人 Tailscale 内核客户端，请在 Headscale 控制面主机上停用它，改由本 sidecar 加入自托管网。",
          );
        }
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

    for (let i = 0; i < 15; i++) {
      const ip = await this.ipFromContainer(container);
      if (ip) return ip;
      await sleep(1_000);
    }
    return null;
  }

  /** 旧版 userspace / 带 advertise-tags 的 sidecar 与平台设计不符，需重建 */
  private platformContainerNeedsRecreate(
    info: Docker.ContainerInspectInfo,
    desiredExtraArgs: string,
  ): boolean {
    const env = info.Config?.Env ?? [];
    const get = (key: string) => {
      const row = env.find((e) => e.startsWith(`${key}=`));
      return row ? row.slice(key.length + 1) : "";
    };
    const userspace = get("TS_USERSPACE");
    const extra = get("TS_EXTRA_ARGS");
    if (userspace !== "false") return true;
    if (extra.includes("--advertise-tags")) return true;
    if (extra !== desiredExtraArgs) return true;
    if (info.HostConfig?.NetworkMode !== "host") return true;
    return false;
  }

  private async createMeshContainer(opts: {
    image: string;
    authKey: string;
    extraArgs: string;
    stateDir: string;
    platform: boolean;
  }): Promise<Docker.Container> {
    // 平台自托管 Headscale：host 网络 + kernel TUN，数据面与控制面同机直连
    // 非平台（少见兜底）：userspace，避免抢主机 TUN
    const useKernelTun = opts.platform && process.platform === "linux";

    const env = [
      `TS_AUTHKEY=${opts.authKey}`,
      `TS_HOSTNAME=${HOST_TAILSCALE_HOSTNAME}`,
      "TS_STATE_DIR=/var/lib/tailscale",
      `TS_USERSPACE=${useKernelTun ? "false" : "true"}`,
      `TS_EXTRA_ARGS=${opts.extraArgs}`,
    ];
    if (!useKernelTun) {
      env.push(`TS_SOCKS5_SERVER=127.0.0.1:${HOST_TAILSCALE_SOCKS_PORT}`);
    }

    const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
      RestartPolicy: { Name: "unless-stopped" },
      Binds: [`${opts.stateDir}:/var/lib/tailscale`],
      NetworkMode: process.platform === "linux" ? "host" : "bridge",
      CapAdd: ["NET_ADMIN", "NET_RAW"],
    };
    if (useKernelTun) {
      hostConfig.Devices = [
        { PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" },
      ];
    }

    return this.docker.createContainer({
      name: HOST_TAILSCALE_CONTAINER,
      Image: opts.image,
      Hostname: HOST_TAILSCALE_HOSTNAME,
      Env: env,
      HostConfig: hostConfig,
      Labels: {
        "zakura.managed": "true",
        "zakura.purpose": "host-tailscale",
        "zakura.mesh": opts.platform ? "headscale-platform" : "tailscale",
      },
    });
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
