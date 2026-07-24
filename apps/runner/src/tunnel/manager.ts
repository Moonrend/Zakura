import type { RunnerDockerWorkspace } from "../docker-workspace.js";
import { startCloudflareQuickTunnel } from "./cloudflare-quick.js";

export type TunnelStartRequest = {
  exposureId: string;
  agentId: string;
  port: number;
  provider: string;
  protocol?: "http" | "https" | "tcp";
  ttlMinutes?: number;
};

export type TunnelStartResult = {
  publicUrl: string;
  relayHost: string;
  relayPort: number;
};

/**
 * Runner-side tunnel manager：在 Runner 主机上做 docker exec 端口中继 + cloudflared。
 */
export class TunnelManager {
  private readonly live = new Map<
    string,
    { stop: () => Promise<void>; relayClose?: () => void; timer?: ReturnType<typeof setTimeout> }
  >();

  async start(
    req: TunnelStartRequest,
    dockerWs: RunnerDockerWorkspace,
  ): Promise<TunnelStartResult> {
    if (req.provider !== "cloudflare-quick") {
      throw new Error(
        `Runner 暂仅支持 cloudflare-quick（收到 ${req.provider}）`,
      );
    }
    if (this.live.has(req.exposureId)) {
      await this.stop(req.exposureId);
    }

    const relay = await dockerWs.openTcpTunnel(req.agentId, req.port);
    let tunnelStop: (() => Promise<void>) | null = null;
    try {
      const tunnel = await startCloudflareQuickTunnel(relay.url);
      tunnelStop = tunnel.stop;
      const ttlMs =
        typeof req.ttlMinutes === "number" && req.ttlMinutes > 0
          ? req.ttlMinutes * 60_000
          : undefined;
      const timer =
        ttlMs != null
          ? setTimeout(() => {
              void this.stop(req.exposureId).catch(() => undefined);
            }, ttlMs)
          : undefined;
      this.live.set(req.exposureId, {
        stop: tunnel.stop,
        relayClose: relay.close,
        timer,
      });
      return {
        publicUrl: tunnel.publicUrl,
        relayHost: relay.host,
        relayPort: relay.port,
      };
    } catch (err) {
      try {
        relay.close();
      } catch {
        /* ignore */
      }
      if (tunnelStop) {
        try {
          await tunnelStop();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  async stop(exposureId: string): Promise<void> {
    const live = this.live.get(exposureId);
    if (!live) return;
    if (live.timer) clearTimeout(live.timer);
    try {
      live.relayClose?.();
    } catch {
      /* ignore */
    }
    try {
      await live.stop();
    } catch {
      /* ignore */
    }
    this.live.delete(exposureId);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.live.keys()]) {
      await this.stop(id);
    }
  }
}
