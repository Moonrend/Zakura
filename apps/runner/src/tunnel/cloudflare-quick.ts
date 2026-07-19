/**
 * Cloudflare Quick Tunnel helper for Runner (Phase 1 scaffold).
 * Server already implements the same flow under apps/server/src/tunnel/.
 */

export async function startCloudflareQuickTunnel(_targetUrl: string): Promise<{
  publicUrl: string;
  stop: () => Promise<void>;
}> {
  throw new Error(
    "Runner cloudflared Quick Tunnel not wired yet; use Server-local exposure for now",
  );
}
