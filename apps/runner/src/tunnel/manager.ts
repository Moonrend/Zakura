/**
 * Runner-side tunnel manager (Phase 1 scaffold).
 * Local workspace exposures currently run on the Server (Docker + cloudflared).
 * Remote Runner will own TunnelManager here in a later phase.
 */

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

export interface TunnelProvider {
  id: string;
  start(targetUrl: string): Promise<{ publicUrl: string; stop: () => Promise<void> }>;
}

export class TunnelManager {
  private readonly live = new Map<
    string,
    { stop: () => Promise<void>; relayClose?: () => void }
  >();

  async start(
    _req: TunnelStartRequest,
    _openRelay: (port: number) => Promise<{ host: string; port: number; close: () => void }>,
    _provider: TunnelProvider,
  ): Promise<TunnelStartResult> {
    throw new Error(
      "Runner TunnelManager not yet wired; local exposures are handled by Server",
    );
  }

  async stop(exposureId: string): Promise<void> {
    const live = this.live.get(exposureId);
    if (!live) return;
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
