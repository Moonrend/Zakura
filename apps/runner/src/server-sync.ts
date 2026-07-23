import type { RunnerHostInfo, RuntimeNodeDto } from "@zakura/shared";
import { collectHostInfo } from "./host-info.js";

export type ServerSyncConfig = {
  serverUrl: string;
  token: string;
  storageRoot: string;
  version: string;
  publicUrl?: string;
  /** Default 20s; keep well under server runnerHeartbeatTimeoutSec */
  intervalMs?: number;
};

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolveEndpoint(hostInfo: RunnerHostInfo, publicUrl?: string): string | null {
  const fromEnv = process.env.ZAKURA_RUNNER_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (publicUrl?.trim()) return publicUrl.replace(/\/+$/, "");
  if (hostInfo.publicUrl?.trim()) return hostInfo.publicUrl.replace(/\/+$/, "");
  const port = process.env.ZAKURA_RUNNER_PORT ?? "7443";
  if (hostInfo.primaryIp) return `http://${hostInfo.primaryIp}:${port}`;
  return null;
}

async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/**
 * Runner → Server：注册 endpoint + 周期性心跳。
 * 云端凭 lastSeenAt / status 判定在线，再经 Tailscale endpoint 回调 Runner。
 */
export function startServerSync(cfg: ServerSyncConfig): { stop: () => void } {
  const base = normalizeBase(cfg.serverUrl);
  const intervalMs = cfg.intervalMs ?? 20_000;
  let nodeId: string | null = process.env.ZAKURA_RUNNER_NODE_ID?.trim() || null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const hostInfo = collectHostInfo(cfg.storageRoot, cfg.publicUrl);
      const endpoint = resolveEndpoint(hostInfo, cfg.publicUrl);
      if (!endpoint) {
        console.warn("[runner-sync] skip: no reachable endpoint (waiting for Tailscale/IP)");
        return;
      }

      if (!nodeId) {
        const reg = await postJson(`${base}/api/runtime-nodes/register`, {
          token: cfg.token,
          endpoint,
          hostInfo,
          agentVersion: cfg.version,
          storageRoot: cfg.storageRoot,
          capabilities: { docker: true, runner: true },
        });
        if (!reg.ok) {
          console.warn(
            `[runner-sync] register failed status=${reg.status}`,
            typeof reg.json === "object" ? reg.json : "",
          );
          return;
        }
        const node = (reg.json as { node?: RuntimeNodeDto } | null)?.node;
        if (!node?.id) {
          console.warn("[runner-sync] register ok but missing node.id");
          return;
        }
        nodeId = node.id;
        console.log(
          `[runner-sync] registered id=${nodeId} endpoint=${endpoint} status=${node.status}`,
        );
        return;
      }

      const hb = await postJson(
        `${base}/api/runtime-nodes/${encodeURIComponent(nodeId)}/heartbeat`,
        { hostInfo, agentVersion: cfg.version },
        { authorization: `Bearer ${cfg.token}` },
      );
      if (hb.status === 401 || hb.status === 404) {
        console.warn(`[runner-sync] heartbeat ${hb.status}, will re-register`);
        nodeId = null;
        return;
      }
      if (!hb.ok) {
        console.warn(
          `[runner-sync] heartbeat failed status=${hb.status}`,
          typeof hb.json === "object" ? hb.json : "",
        );
        return;
      }
      // Periodically refresh endpoint via register (IP may change)
      const node = (hb.json as { node?: RuntimeNodeDto } | null)?.node;
      const currentEndpoint = node?.endpoint?.replace(/\/+$/, "");
      if (currentEndpoint && currentEndpoint !== endpoint) {
        await postJson(`${base}/api/runtime-nodes/register`, {
          token: cfg.token,
          endpoint,
          hostInfo,
          agentVersion: cfg.version,
          storageRoot: cfg.storageRoot,
          capabilities: { docker: true, runner: true },
        });
        console.log(`[runner-sync] endpoint refreshed → ${endpoint}`);
      }
    } catch (err) {
      console.warn(
        "[runner-sync] error",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      inFlight = false;
    }
  };

  console.log(
    `[runner-sync] enabled server=${base} intervalMs=${intervalMs}`,
  );
  void tick();
  timer = setInterval(() => void tick(), intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
