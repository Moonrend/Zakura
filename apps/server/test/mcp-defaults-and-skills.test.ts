import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encryptJson } from "@zakura/core";
import { eq } from "drizzle-orm";

describe("MCP defaults and skill resources", () => {
  let dataDir: string;
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let config: import("../src/config.js").AppConfig;
  let tenantId: string;
  let agentId: string;
  let agentService: import("../src/services/agents.js").AgentService;
  let gateway: import("../src/services/mcp-gateway.js").McpGateway;
  let orchestrator: import("../src/services/orchestrator.js").Orchestrator;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-mcp-defaults-"));
    const pgliteDir = join(dataDir, "pglite");
    process.env.ZAKURA_DATA_DIR = dataDir;
    process.env.DATABASE_URL = `pglite:${pgliteDir}`;

    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(`pglite:${pgliteDir}`);

    const { createDb } = await import("../src/db/client.js");
    const { loadConfig } = await import("../src/config.js");
    config = loadConfig();
    (config as { dataDir: string }).dataDir = dataDir;
    const created = await createDb({ databaseUrl: `pglite:${pgliteDir}`, dataDir });
    db = created.db;
    close = created.close;

    const { tenants, agents, newId, providerCatalog, componentInstances } = await import(
      "../src/db/schema.js"
    );
    const now = new Date();
    tenantId = newId();
    agentId = newId();
    await db.insert(tenants).values({
      id: tenantId,
      slug: "mcp-defaults",
      name: "MCP Defaults",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      name: "MCP Agent",
      slug: "mcp-agent",
      description: "",
      status: "ready",
      enableFs: false,
      enableComputer: false,
      enableMemory: false,
      workspaceStatus: "ready",
      configJson: JSON.stringify({
        providers: {
          webSearch: { enabled: false },
          webFetch: { enabled: false },
          mcp: { mode: "selected", instanceIds: [] },
        },
      }),
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(providerCatalog)
      .values({
        id: "generic-mcp",
        name: "Generic MCP",
        description: "",
        version: "1.0.0",
        category: "mcp",
        capabilities: "[]",
        configSchema: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    orchestrator = {
      createInstance: async (input: {
        tenantId: string;
        providerId: string;
        name: string;
        slug: string;
        config: Record<string, unknown>;
      }) => {
        const [row] = await db
          .insert(componentInstances)
          .values({
            id: newId(),
            tenantId: input.tenantId,
            providerId: input.providerId,
            name: input.name,
            slug: input.slug,
            status: "running",
            configEnc: encryptJson(config.secret, input.config),
            endpointUrl:
              typeof input.config.mcpUrl === "string" ? input.config.mcpUrl : null,
            healthStatus: "ok",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return row!;
      },
      startInstance: async () => undefined,
      ensureStarted: async () => undefined,
      toHandle: async () => {
        throw new Error("not used");
      },
    } as unknown as import("../src/services/orchestrator.js").Orchestrator;

    const { DockerRuntime } = await import("../src/runtime/docker.js");
    const { AgentService } = await import("../src/services/agents.js");
    const { McpGateway } = await import("../src/services/mcp-gateway.js");
    agentService = new AgentService(db, new DockerRuntime(), config);
    gateway = new McpGateway(db, orchestrator, new DockerRuntime());
    gateway.setAgentService(agentService);
    gateway.setSkillsService({
      listForAgent: async () => [
        {
          id: "install_1",
          agentId,
          skillId: "skill_1",
          name: "demo-skill",
          title: "Demo Skill",
          description: "Demo description",
          enabled: true,
          path: "/skills/demo-skill",
          version: "v1",
          status: "installed",
          error: null,
          builtin: false,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        {
          id: "install_2",
          agentId,
          skillId: "skill_2",
          name: "disabled-skill",
          title: "Disabled Skill",
          description: "",
          enabled: false,
          path: "/skills/disabled-skill",
          version: "v1",
          status: "installed",
          error: null,
          builtin: false,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      readSkillFile: async (_tenantId: string, _agent: unknown, name: string, path?: string) =>
        name === "demo-skill"
          ? { path: `/skills/demo-skill/${path ?? "SKILL.md"}`, content: "# Demo\n" }
          : null,
    } as unknown as import("../src/services/skills/service.js").SkillsService);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("selects preinstalled Grep MCP for existing agents", async () => {
    const agent = await agentService.get(tenantId, agentId);
    assert.ok(agent);

    const updated = await agentService.ensureDefaultMcpBindings(
      tenantId,
      agent!,
      orchestrator,
    );
    const configJson = JSON.parse(updated.configJson) as {
      providers?: { mcp?: { instanceIds?: string[] } };
    };
    const ids = configJson.providers?.mcp?.instanceIds ?? [];
    assert.equal(ids.length, 1);

    const { componentInstances, agentBindings } = await import("../src/db/schema.js");
    const instances = await db
      .select()
      .from(componentInstances)
      .where(eq(componentInstances.id, ids[0]!));
    assert.equal(instances[0]?.slug, "grep");
    assert.equal(instances[0]?.endpointUrl, "https://mcp.grep.app/");

    const bindings = await db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.agentId, agentId));
    assert.deepEqual(bindings.map((b) => b.instanceId), ids);
  });

  it("exposes enabled skills as MCP resources", async () => {
    const agent = await agentService.get(tenantId, agentId);
    assert.ok(agent);

    const resources = await gateway.listResourcesForAgent(agent!);
    assert.ok(resources.some((r) => r.qualifiedUri === "zakura://agent/skills"));
    assert.ok(
      resources.some(
        (r) => r.qualifiedUri === "zakura://agent/skills/demo-skill/SKILL.md",
      ),
    );
    assert.equal(
      resources.some(
        (r) => r.qualifiedUri === "zakura://agent/skills/disabled-skill/SKILL.md",
      ),
      false,
    );

    const read = await gateway.readResource(
      tenantId,
      "zakura://agent/skills/demo-skill/SKILL.md",
      { agentId },
    );
    assert.equal(read.contents[0]?.mimeType, "text/markdown");
    assert.equal(read.contents[0]?.text, "# Demo\n");

    const templates = await gateway.listResourceTemplatesForAgent(agent!);
    assert.ok(
      templates.some(
        (t) => t.qualifiedUriTemplate === "zakura://agent/skills/{name}/{+path}",
      ),
    );
  });
});
