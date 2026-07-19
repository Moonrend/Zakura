import { networkInterfaces, hostname, platform, arch } from "node:os";
import fs, { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  RunnerHostInfo,
  RunnerNetworkInterface,
  RunnerTailscaleInfo,
} from "@zakura/shared";

function isInternalIface(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "lo" ||
    n === "localhost" ||
    n.startsWith("docker") ||
    n.startsWith("veth") ||
    n.startsWith("br-") ||
    n.startsWith("virbr") ||
    n.startsWith("cni") ||
    n.startsWith("flannel")
  );
}

function isTailscaleIface(name: string): boolean {
  const n = name.toLowerCase();
  return n === "tailscale0" || n.startsWith("tailscale") || n === "ts0";
}

function isCgNat100(ip: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip);
}

function collectOsInterfaces(): RunnerNetworkInterface[] {
  const nets = networkInterfaces();
  const out: RunnerNetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    const ipv4: string[] = [];
    const ipv6: string[] = [];
    let mac: string | undefined;
    let internal = isInternalIface(name);
    for (const a of addrs) {
      if (a.internal) internal = true;
      if (a.mac && a.mac !== "00:00:00:00:00:00") mac = a.mac;
      if (a.family === "IPv4" || (a.family as unknown) === 4) ipv4.push(a.address);
      if (a.family === "IPv6" || (a.family as unknown) === 6) ipv6.push(a.address);
    }
    out.push({ name, mac, ipv4, ipv6, internal });
  }
  return out;
}

/** Optional host sysfs merge when mounted at /host/sys/class/net */
function mergeHostSysNet(ifaces: RunnerNetworkInterface[]): RunnerNetworkInterface[] {
  const hostNet = "/host/sys/class/net";
  if (!existsSync(hostNet)) return ifaces;
  const byName = new Map(ifaces.map((i) => [i.name, { ...i }]));
  try {
    for (const name of readdirSync(hostNet)) {
      const existing = byName.get(name);
      let mac = existing?.mac;
      let operstate: string | undefined;
      try {
        mac = readFileSync(join(hostNet, name, "address"), "utf8").trim() || mac;
      } catch {
        /* ignore */
      }
      try {
        operstate = readFileSync(join(hostNet, name, "operstate"), "utf8").trim();
      } catch {
        /* ignore */
      }
      byName.set(name, {
        name,
        mac,
        ipv4: existing?.ipv4 ?? [],
        ipv6: existing?.ipv6 ?? [],
        internal: existing?.internal ?? isInternalIface(name),
        operstate,
      });
    }
  } catch {
    return ifaces;
  }
  return [...byName.values()];
}

function diskFor(root: string): { totalBytes: number; freeBytes: number } | undefined {
  try {
    const statfsSync = (
      fs as typeof fs & {
        statfsSync?: (p: string) => {
          bsize: number | bigint;
          blocks: number | bigint;
          bavail: number | bigint;
          bfree: number | bigint;
        };
      }
    ).statfsSync;
    if (typeof statfsSync !== "function") return undefined;
    const s = statfsSync(root);
    const bsize = Number(s.bsize) || 4096;
    return {
      totalBytes: Number(s.blocks) * bsize,
      freeBytes: Number(s.bavail ?? s.bfree) * bsize,
    };
  } catch {
    return undefined;
  }
}

function findTailscaleIpFromIfaces(ifaces: RunnerNetworkInterface[]): string | undefined {
  for (const iface of ifaces) {
    if (isTailscaleIface(iface.name)) {
      const ip = iface.ipv4.find((a) => isCgNat100(a) || a.startsWith("100."));
      if (ip) return ip;
    }
  }
  for (const iface of ifaces) {
    const ip = iface.ipv4.find((a) => isCgNat100(a));
    if (ip) return ip;
  }
  return undefined;
}

function collectTailscaleInfo(ifaces: RunnerNetworkInterface[]): RunnerTailscaleInfo | undefined {
  const ifaceIp = findTailscaleIpFromIfaces(ifaces);

  // Prefer CLI when available (host install or sidecar with tailscale in PATH)
  try {
    const bin =
      process.env.ZAKURA_TAILSCALE_BIN || process.env.TAILSCALE_BIN || "tailscale";
    const res = spawnSync(bin, ["status", "--json"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) {
      const json = JSON.parse(res.stdout) as {
        BackendState?: string;
        Self?: {
          DNSName?: string;
          TailscaleIPs?: string[];
          HostName?: string;
          Tags?: string[];
        };
      };
      const state = json.BackendState ?? "";
      const connected = !state || state === "Running";
      const ip =
        json.Self?.TailscaleIPs?.find((a) => a.includes(".")) ||
        ifaceIp;
      if (ip || connected) {
        return {
          connected,
          ip,
          magicDnsName: json.Self?.DNSName?.replace(/\.$/, ""),
          hostname: json.Self?.HostName,
          tags: json.Self?.Tags,
        };
      }
    }
  } catch {
    /* fall through */
  }

  if (ifaceIp) {
    return { connected: true, ip: ifaceIp };
  }
  return undefined;
}

export function collectHostInfo(storageRoot: string, publicUrl?: string): RunnerHostInfo {
  let interfaces = collectOsInterfaces();
  interfaces = mergeHostSysNet(interfaces);

  const tailscale = collectTailscaleInfo(interfaces);

  const publicHost = process.env.ZAKURA_RUNNER_PUBLIC_HOST?.trim();
  let primaryIp = publicHost || undefined;
  if (!primaryIp && tailscale?.connected && tailscale.ip) {
    primaryIp = tailscale.ip;
  }
  if (!primaryIp) {
    const ext = interfaces.find((i) => !i.internal && i.ipv4.length > 0);
    primaryIp = ext?.ipv4[0];
  }

  const resolvedPublic =
    publicUrl ||
    process.env.ZAKURA_RUNNER_PUBLIC_URL ||
    (primaryIp ? `http://${primaryIp}:${process.env.ZAKURA_RUNNER_PORT ?? "7443"}` : undefined);

  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    primaryIp,
    interfaces,
    publicUrl: resolvedPublic,
    storageRoot,
    disk: diskFor(storageRoot),
    ...(tailscale ? { tailscale } : {}),
  };
}
