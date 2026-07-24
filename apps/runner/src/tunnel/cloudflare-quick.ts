import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type QuickTunnelHandle = {
  publicUrl: string;
  metricsPort: number;
  stop: () => Promise<void>;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

async function fetchHostname(metricsPort: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { hostname?: string };
    const host = body.hostname?.trim();
    if (!host) return null;
    if (host.startsWith("http://") || host.startsWith("https://")) return host.replace(/\/$/, "");
    return `https://${host.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Start a Cloudflare Quick Tunnel pointing at a local HTTP target.
 * Requires `cloudflared` on PATH (or CLOUDFLARED_BIN / ZAKURA_CLOUDFLARED_BIN).
 */
export async function startCloudflareQuickTunnel(
  targetUrl: string,
  opts?: { timeoutMs?: number; bin?: string },
): Promise<QuickTunnelHandle> {
  const bin =
    opts?.bin ||
    process.env.ZAKURA_CLOUDFLARED_BIN ||
    process.env.CLOUDFLARED_BIN ||
    "cloudflared";
  const metricsPort = await allocatePort();
  const homeDir = mkdtempSync(join(tmpdir(), "zakura-cloudflared-"));
  const timeoutMs = opts?.timeoutMs ?? 45_000;

  let child: ChildProcess;
  try {
    child = spawn(
      bin,
      ["tunnel", "--no-autoupdate", "--url", targetUrl, "--metrics", `127.0.0.1:${metricsPort}`],
      {
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch (err) {
    rmSync(homeDir, { recursive: true, force: true });
    throw new Error(
      `Failed to start cloudflared (${bin}): ${err instanceof Error ? err.message : String(err)}. Install cloudflared or set ZAKURA_CLOUDFLARED_BIN.`,
    );
  }

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });

  const stop = async () => {
    try {
      if (child.pid && !child.killed) {
        child.kill("SIGTERM");
        await sleep(500);
        if (!child.killed) child.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      await stop();
      throw new Error(
        `cloudflared exited early (code ${child.exitCode}): ${stderr.trim() || "no output"}`,
      );
    }
    const url = await fetchHostname(metricsPort);
    if (url) {
      return { publicUrl: url, metricsPort, stop };
    }
    await sleep(1000);
  }

  await stop();
  throw new Error(
    `Timed out waiting for Cloudflare Quick Tunnel URL. ${stderr.trim() || "Is cloudflared installed?"}`.trim(),
  );
}
