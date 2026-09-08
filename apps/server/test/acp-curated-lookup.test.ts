/**
 * Zakura resolves ACP adapters against TWO different registries:
 *
 *   - upstream  cdn.agentclientprotocol.com  (39 agents, host install plans)
 *   - curated   Moonrend/acp-registry        (42 agents, container images)
 *
 * fx-acp, hermes-acp and kiro-acp are published by us and exist ONLY in the
 * curated index. `ensureInstalled` used to resolve upstream-first, so it threw
 *
 *     ACP 注册表里没有 hermes-acp
 *
 * before the container branch was ever reached. These tests drive the real
 * `ensureInstalled` against an upstream index that (like the real one) does
 * not know about our agents.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AcpRegistryService } from "../src/services/acp/registry.js";
import { acpContainerAgents } from "@zakura/shared";

type Workspace = ConstructorParameters<typeof AcpRegistryService>[0];

/** An upstream index that mirrors reality: our own agents are absent. */
function upstreamWithout(ids: string[]) {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        agents: [
          { id: "codex-acp", name: "Codex", description: "", dist: { version: "1.10.0", platforms: {} } },
        ].filter((a) => !ids.includes(a.id)),
      }),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** Records which image the install path asked the workspace to pull. */
function imageWorkspace() {
  const pulled: string[] = [];
  const workspace = {
    ensureAcpAdapterImage: async (_agent: unknown, image: string) => {
      pulled.push(image);
      return true;
    },
  } as unknown as Workspace;
  return { workspace, pulled };
}

const fakeAgent = { id: "agent-1" } as Parameters<AcpRegistryService["ensureInstalled"]>[0];

describe("ensureInstalled resolves curated container agents", () => {
  it("installs an agent that exists only in the curated index", async () => {
    const { workspace, pulled } = imageWorkspace();
    const registry = new AcpRegistryService(workspace, upstreamWithout(["hermes-acp"]));

    const res = await registry.ensureInstalled(fakeAgent, "hermes-acp");

    assert.ok(
      pulled.length === 1,
      `expected exactly one image pull, got ${JSON.stringify(pulled)}`,
    );
    assert.match(
      pulled[0],
      /^ghcr\.io\/moonrend\/acp-registry\/hermes-acp:/,
      `pulled the wrong image: ${pulled[0]}`,
    );
    assert.ok(res.version, "install must report a concrete version");
  });

  it("does not throw '注册表里没有' for any of our own agents", async () => {
    for (const id of ["fx-acp", "hermes-acp", "kiro-acp"]) {
      const { workspace } = imageWorkspace();
      const registry = new AcpRegistryService(workspace, upstreamWithout([id]));
      await assert.doesNotReject(
        () => registry.ensureInstalled(fakeAgent, id),
        new RegExp(`注册表里没有`),
        `${id} still resolves upstream-first`,
      );
    }
  });

  it("honours an explicit version so 更新 can request a new release", async () => {
    const { workspace, pulled } = imageWorkspace();
    const registry = new AcpRegistryService(workspace, upstreamWithout(["hermes-acp"]));

    await registry.ensureInstalled(fakeAgent, "hermes-acp", false, { version: "9.9.9" });

    assert.equal(
      pulled[0],
      "ghcr.io/moonrend/acp-registry/hermes-acp:9.9.9",
      `explicit version ignored; pulled ${pulled[0]}`,
    );
  });

  it("every curated agent's shipped version matches its image tag", () => {
    // If these drift, install pulls a tag we never built and the container
    // fails to start with "没镜像".
    for (const a of acpContainerAgents()) {
      const tag = a.image.split(":").pop();
      assert.equal(a.version, tag, `${a.id}: version ${a.version} != tag ${tag}`);
    }
  });
});