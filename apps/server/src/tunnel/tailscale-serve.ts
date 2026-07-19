import { spawn } from "node:child_process";

export type TailscaleServeHandle = {
  /** HTTPS URL reachable inside the tailnet (MagicDNS) */
  publicUrl: string;
  httpsPort: number;
  mountPath: string;
  dnsName: string;
  stop: () => Promise<void>;
};

export type TailscaleBackendProbe = {
  ok: boolean;
  dnsName?: string;
  ip?: string;
  backendState?: string;
  message: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function tailscaleBin(): string {
  return process.env.ZAKURA_TAILSCALE_BIN || process.env.TAILSCALE_BIN || "tailscale";
}

function runTailscale(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = tailscaleBin();
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      reject(
        new Error(
          `Failed to run ${bin}: ${err instanceof Error ? err.message : String(err)}. Install Tailscale or set ZAKURA_TAILSCALE_BIN.`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
      if (stdout.length > 50_000) stdout = stdout.slice(-25_000);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`tailscale ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to run ${bin}: ${err.message}. Install Tailscale CLI or set ZAKURA_TAILSCALE_BIN.`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function normalizeDnsName(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  return raw.trim().replace(/\.$/, "");
}

/**
 * Check that the host Tailscale daemon is up (required for Serve on local Server).
 */
export async function probeTailscaleBackend(): Promise<TailscaleBackendProbe> {
  try {
    const res = await runTailscale(["status", "--json"], { timeoutMs: 12_000 });
    if (res.code !== 0) {
      return {
        ok: false,
        message:
          res.stderr.trim() ||
          res.stdout.trim() ||
          `tailscale status failed (exit ${res.code})`,
      };
    }
    let json: {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: string[]; HostName?: string };
    };
    try {
      json = JSON.parse(res.stdout) as typeof json;
    } catch {
      return { ok: false, message: "tailscale status --json 解析失败" };
    }
    const state = json.BackendState ?? "";
    const dnsName = normalizeDnsName(json.Self?.DNSName) ?? undefined;
    const ip = json.Self?.TailscaleIPs?.[0];
    if (state && state !== "Running") {
      return {
        ok: false,
        dnsName,
        ip,
        backendState: state,
        message: `Tailscale 未就绪（BackendState=${state}）。请先在本机/sidecar 完成 tailscale up。`,
      };
    }
    if (!dnsName && !ip) {
      return {
        ok: false,
        backendState: state,
        message: "Tailscale 已连接但缺少 MagicDNS / Tailscale IP",
      };
    }
    return {
      ok: true,
      dnsName,
      ip,
      backendState: state || "Running",
      message: dnsName ? `Serve 可用 · ${dnsName}` : `Serve 可用 · ${ip}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildServeUrl(dnsName: string | undefined, ip: string | undefined, mountPath: string, httpsPort: number): string {
  const host = dnsName || ip;
  if (!host) throw new Error("无法解析 Tailscale 主机名");
  const path = mountPath.startsWith("/") ? mountPath : `/${mountPath}`;
  if (httpsPort === 443) return `https://${host}${path}`;
  return `https://${host}:${httpsPort}${path}`;
}

/**
 * Expose a local HTTP target via `tailscale serve` (tailnet-only, not Funnel).
 * Uses a unique --set-path so multiple exposures can share HTTPS :443.
 */
export async function startTailscaleServe(opts: {
  targetUrl: string;
  mountPath: string;
  httpsPort?: number;
}): Promise<TailscaleServeHandle> {
  const httpsPort = opts.httpsPort ?? 443;
  const mountPath = opts.mountPath.startsWith("/") ? opts.mountPath : `/${opts.mountPath}`;
  if (mountPath === "/") {
    throw new Error("tailscale-serve 需要非根 mountPath，以便多隧道共存");
  }

  const probe = await probeTailscaleBackend();
  if (!probe.ok) {
    throw new Error(probe.message);
  }

  const target = opts.targetUrl.trim();
  const args = [
    "serve",
    "--bg",
    "--yes",
    `--https=${httpsPort}`,
    `--set-path=${mountPath}`,
    target,
  ];

  const res = await runTailscale(args, { timeoutMs: 30_000 });
  if (res.code !== 0) {
    throw new Error(
      [
        `tailscale serve 失败 (exit ${res.code})`,
        res.stderr.trim() || res.stdout.trim() || "no output",
        "请确认：1) 本机 Tailscale 已登录 2) Admin 已启用 HTTPS Certificates / MagicDNS",
      ].join("\n"),
    );
  }

  // Brief settle; cert provisioning can lag slightly
  await sleep(400);
  const again = await probeTailscaleBackend();
  const dnsName = again.dnsName ?? probe.dnsName;
  const ip = again.ip ?? probe.ip;
  const publicUrl = buildServeUrl(dnsName, ip, mountPath, httpsPort);

  const stop = async () => {
    const off = await runTailscale(
      ["serve", `--https=${httpsPort}`, `--set-path=${mountPath}`, "off"],
      { timeoutMs: 15_000 },
    );
    if (off.code !== 0) {
      // Best-effort; don't throw from TTL cleanup paths
      console.warn(
        `[tailscale-serve] off failed for ${mountPath}:`,
        off.stderr.trim() || off.stdout.trim(),
      );
    }
  };

  return {
    publicUrl,
    httpsPort,
    mountPath,
    dnsName: dnsName ?? ip ?? "",
    stop,
  };
}
