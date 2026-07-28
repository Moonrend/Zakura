import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { AgentService } from "./agents.js";
import type { MemoryProvidersService } from "./memory-providers.js";
import type { Orchestrator } from "./orchestrator.js";
import type { TenantOnboardingSteps, TenantService } from "./tenants.js";

const DEFAULT_AGENT_NAME = "Zakura";

export type OnboardingBootstrapResult = {
  edition: "oss" | "saas" | string;
  agent: {
    id: string;
    name: string;
    slug: string;
    enableComputer: boolean;
    enableMemory: boolean;
    mcpAgentUrl: string;
  };
  created: boolean;
  computerStarting: boolean;
  steps: TenantOnboardingSteps;
  completed: boolean;
};

/**
 * 引导启动：自动创建默认 Agent、开启记忆；
 * OSS 额外开启电脑环境并异步启动本机工作区。
 */
export async function bootstrapOnboarding(deps: {
  db: Db;
  config: AppConfig;
  tenants: TenantService;
  agentService: AgentService;
  memoryProviders: MemoryProvidersService;
  orchestrator: Orchestrator;
  tenantId: string;
  userId: string;
}): Promise<OnboardingBootstrapResult> {
  const {
    db,
    config,
    tenants: tenantService,
    agentService,
    memoryProviders,
    orchestrator,
    tenantId,
    userId,
  } = deps;

  const isOss = config.edition !== "saas";
  const memory = await memoryProviders.ensureDefault(tenantId);

  const existing = await agentService.list(tenantId);
  let agent = existing[0] ?? null;
  let created = false;
  let computerStarting = false;

  if (!agent) {
    try {
      const result = await agentService.create(tenantId, {
        name: DEFAULT_AGENT_NAME,
        description: "引导自动创建的默认 Agent",
        createApiKey: false,
        enableMemory: true,
        enableComputer: isOss,
        memoryProviderId: memory.id,
      });
      agent = result.agent;
      created = true;

      // 默认 MCP 属于增强能力，后台安装，避免远程服务启动阻塞首次进入。
      const createdAgentId = agent.id;
      void (async () => {
        try {
          const { ensureDefaultAgentMcps, bindDefaultMcpsToAgent } = await import(
            "./default-mcps.js"
          );
          const defaultIds = await ensureDefaultAgentMcps(
            db,
            orchestrator,
            config,
            tenantId,
          );
          if (defaultIds.length) {
            await bindDefaultMcpsToAgent(db, tenantId, createdAgentId, defaultIds);
          }
        } catch (err) {
          console.warn(
            "[onboarding] default MCP auto-install failed:",
            err instanceof Error ? err.message : err,
          );
        }
      })();
    } catch (err) {
      // 并发 bootstrap：另一请求可能已创建同名 Agent
      const again = await agentService.list(tenantId);
      agent = again[0] ?? null;
      if (!agent) throw err;
    }
  }

  if (agent && !created) {
    // 已有 / 并发创建：确保记忆开启 + OSS 电脑开启
    const needsMemory = !agent.enableMemory || !agent.memoryProviderId;
    const needsComputer = isOss && !agent.enableComputer;
    if (needsMemory || needsComputer) {
      agent = await agentService.update(tenantId, agent.id, {
        ...(needsMemory
          ? { enableMemory: true, memoryProviderId: memory.id }
          : {}),
        ...(needsComputer ? { enableComputer: true, restart: false } : {}),
        userId,
      });
    }
  }

  if (!agent) {
    throw new Error("Failed to bootstrap default agent");
  }

  if (isOss && agent.enableComputer) {
    try {
      agent = await agentService.startAsync(tenantId, agent.id, {
        runtimeNodeId: null,
        userId,
      });
      computerStarting = true;
    } catch (err) {
      console.warn(
        "[onboarding] computer start deferred:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 自动准备不写 onboarding steps，避免污染引导进度
  const onboarding = await tenantService.getOnboarding(tenantId);

  const serialized = agentService.serialize(agent);
  return {
    edition: config.edition,
    agent: {
      id: serialized.id,
      name: serialized.name,
      slug: serialized.slug,
      enableComputer: serialized.enableComputer,
      enableMemory: serialized.enableMemory,
      mcpAgentUrl: serialized.mcpAgentUrl,
    },
    created,
    computerStarting,
    steps: onboarding.steps,
    completed: onboarding.completed,
  };
}
