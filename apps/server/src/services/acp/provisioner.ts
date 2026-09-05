/**
 * ACP 适配器 provisioning。
 *
 * 从 session.ts 里抽出来：安装一个适配器和「跑一个 ACP 会话」是两件事，混在
 * 同一个 2000+ 行的类里让安装逻辑既难测也难改。这里只关心「把 profileId 变成
 * 一条可执行的 command + args」，不碰 JSON-RPC、会话状态或权限。
 *
 * 两条来源（见 @zakura/shared 的 acp-sources）：
 *   - custom：上游自带安装脚本，跑幂等脚本装进 /workspace/.zakura/acp/
 *   - registry：走 AcpRegistryService，pin 版本 + sha256 + 原子切换
 * image 源不需要 provision（适配器随镜像出厂，目前只有 full 镜像里的 fx）。
 */
import type { Agent } from "../../db/schema.js";
import {
  acpAdapterSource,
  acpCustomCommand,
  acpCustomProvisionScript,
} from "@zakura/shared";

export type AcpResolvedAdapter = {
  command: string;
  args: string[];
  /**
   * Registry adapter id + installed version backing this command, when it came
   * from the registry. GC uses these to avoid pruning a directory that a live
   * session is still executing from. Absent for custom sources, which are not
   * version-managed.
   */
  registryId?: string;
  version?: string;
};

/** provisioner 需要的最小工作区能力，便于单测替身。 */
export type AcpProvisionWorkspace = {
  ensureStarted(agent: Agent, opts?: { require?: "shell" | "display" }): Promise<unknown>;
  ensureAcpSidecar(agent: Agent): Promise<unknown>;
  execInWorkspace(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  execInSidecar(
    agent: Agent,
    command: string[],
    opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

export type AcpProvisionRegistry = {
  ensureInstalled(
    agent: Agent,
    registryId: string,
    useSidecar?: boolean,
  ): Promise<{ command: string; args: string[]; version: string; installed: boolean }>;
};

/**
 * 把 provision 脚本吐出的哨兵标记翻译成人能看懂的话。
 *
 * 失败必须在安装这一步就说清楚，否则用户只会在启动时看到一句
 * 「binary not found」，完全不知道是缺 uv、架构不支持还是上游包结构变了。
 */
export function describeAcpProvisionFailure(profileId: string, stderr: string): string {
  const tail = stderr.trim().slice(-800);
  if (stderr.includes("ZAKURA_ACP_NEED_UV")) {
    return `${profileId} 需要 uv（Python 工具链），当前工作区镜像未提供。请更新工作区镜像后重试。`;
  }
  if (stderr.includes("ZAKURA_ACP_UNSUPPORTED_ARCH")) {
    return `${profileId} 不支持该 Runner 的 CPU 架构。`;
  }
  if (stderr.includes("ZAKURA_ACP_BIN_NOT_FOUND")) {
    return `${profileId} 安装完成但没找到可执行文件（上游包结构可能已变化）：\n${tail}`;
  }
  return `${profileId} 安装失败：\n${tail}`;
}

export class AcpProvisioner {
  /** key: `${agentId}:${profileId}`，避免每次启动都跑一遍安装脚本。 */
  private readonly cache = new Map<string, AcpResolvedAdapter>();

  constructor(
    private readonly deps: {
      workspace: AcpProvisionWorkspace;
      registry?: AcpProvisionRegistry;
    },
  ) {}

  /**
   * 确保适配器可用，返回解析后的命令；无需 provision 时返回 null（调用方沿用原命令）。
   *
   * `currentCommand` 含 "/" 说明用户指定了绝对/相对路径，属于自管，直接放行。
   */
  async resolve(
    agent: Agent,
    profileId: string,
    currentCommand: string,
    useSidecar: boolean,
  ): Promise<AcpResolvedAdapter | null> {
    if (currentCommand.includes("/")) return null;

    const source = acpAdapterSource(profileId);
    if (source.kind === "image") return null;
    // Container adapters are not provisioned into the workspace: the session
    // layer starts the image and attaches to its stdio. Nothing to install.
    if (source.kind === "container") return null;

    const cacheKey = `${agent.id}:${profileId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      if (source.kind === "custom") {
        const script = acpCustomProvisionScript(source);
        let res;
        if (useSidecar) {
          await this.deps.workspace.ensureAcpSidecar(agent);
          res = await this.deps.workspace.execInSidecar(agent, ["bash", "-lc", script]);
        } else {
          await this.deps.workspace.ensureStarted(agent, { require: "shell" });
          res = await this.deps.workspace.execInWorkspace(agent, ["bash", "-lc", script]);
        }
        if (res.exitCode !== 0) {
          throw new Error(describeAcpProvisionFailure(profileId, res.stderr));
        }
        const result: AcpResolvedAdapter = { command: acpCustomCommand(source), args: [] };
        this.cache.set(cacheKey, result);
        return result;
      }

      const registry = this.deps.registry;
      if (!registry) return null;
      const installed = await registry.ensureInstalled(agent, source.registryId, useSidecar);
      const result: AcpResolvedAdapter = {
        command: installed.command,
        args: installed.args,
        registryId: source.registryId,
        version: installed.version,
      };
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`无法安装 ${profileId} 适配器：${detail}`);
    }
  }

  /** 安装/更新后清缓存，让下次启动重新解析（版本号可能变了）。 */
  invalidate(agentId: string, profileId?: string): void {
    if (profileId) {
      this.cache.delete(`${agentId}:${profileId}`);
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${agentId}:`)) this.cache.delete(key);
    }
  }
}
