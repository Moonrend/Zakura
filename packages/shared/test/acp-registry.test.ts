/**
 * ACP 注册表解析与分发选择。
 *
 * 这里的取舍会直接决定「装什么、从哪装」，所以每条规则都要钉住：
 * 优先带校验和的二进制、缺 sha256 就拒装、@scope/name@version 的版本切分。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpDistributionUnavailableReason,
  acpPlatformTarget,
  acpWorkspacePlatform,
  isValidSha256,
  parseAcpRegistryIndex,
  resolveAcpDistribution,
  type AcpRegistryAgent,
} from "../src/index.js";

const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LINUX = "linux-x86_64" as const;

describe("acpPlatformTarget", () => {
  it("映射到注册表使用的平台标识", () => {
    assert.equal(acpPlatformTarget("x64", "linux"), "linux-x86_64");
    assert.equal(acpPlatformTarget("arm64", "linux"), "linux-aarch64");
    assert.equal(acpPlatformTarget("arm64", "darwin"), "darwin-aarch64");
    assert.equal(acpPlatformTarget("x64", "win32"), "windows-x86_64");
  });

  it("工作区平台恒为 linux，只随 CPU 变化", () => {
    // 服务端可能跑在 macOS 上，但适配器装进的是 Linux 容器。
    assert.equal(acpWorkspacePlatform("arm64"), "linux-aarch64");
    assert.equal(acpWorkspacePlatform("x64"), "linux-x86_64");
  });
});

describe("resolveAcpDistribution", () => {
  it("优先选带校验和的二进制", () => {
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      version: "1.2.3",
      distribution: {
        npx: { package: "a-acp@1.2.3" },
        binary: { [LINUX]: { archive: "https://e/a.tar.gz", sha256: SHA, cmd: "./a" } },
      },
    };
    const dist = resolveAcpDistribution(agent, LINUX);
    assert.equal(dist?.kind, "binary");
  });

  it("二进制缺 sha256 时拒装，回落到 npx", () => {
    // 下载的是会在用户工作区里执行的东西，没有校验和就不装。
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      version: "1.2.3",
      distribution: {
        npx: { package: "a-acp@1.2.3", args: ["--acp"] },
        binary: { [LINUX]: { archive: "https://e/a.tar.gz", cmd: "./a" } },
      },
    };
    const dist = resolveAcpDistribution(agent, LINUX);
    assert.equal(dist?.kind, "npx");
    if (dist?.kind === "npx") {
      assert.equal(dist.pkg, "a-acp");
      assert.equal(dist.version, "1.2.3");
      assert.deepEqual(dist.args, ["--acp"]);
    }
  });

  it("只有无校验和二进制时判为不可用，并说明原因", () => {
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      distribution: { binary: { [LINUX]: { archive: "https://e/a", cmd: "./a" } } },
    };
    assert.equal(resolveAcpDistribution(agent, LINUX), null);
    assert.match(acpDistributionUnavailableReason(agent, LINUX) ?? "", /sha256/);
  });

  it("正确切分 @scope/name@version", () => {
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.6.2" } },
    };
    const dist = resolveAcpDistribution(agent, LINUX);
    assert.equal(dist?.kind, "npx");
    if (dist?.kind === "npx") {
      // 作用域包名自身带 @，版本必须按最后一个 @ 切。
      assert.equal(dist.pkg, "@agentclientprotocol/codex-acp");
      assert.equal(dist.version, "1.6.2");
    }
  });

  it("没有版本的包按 latest 处理", () => {
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      distribution: { npx: { package: "plain-acp" } },
    };
    const dist = resolveAcpDistribution(agent, LINUX);
    assert.equal(dist?.kind === "npx" && dist.version, "latest");
  });

  it("平台不匹配的二进制不会被选中", () => {
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      distribution: {
        binary: { "darwin-aarch64": { archive: "https://e/a", sha256: SHA, cmd: "./a" } },
      },
    };
    assert.equal(resolveAcpDistribution(agent, LINUX), null);
    assert.match(acpDistributionUnavailableReason(agent, LINUX) ?? "", /linux-x86_64/);
  });

  it("uvx 作为最后回落", () => {
    const agent: AcpRegistryAgent = {
      id: "a",
      name: "A",
      distribution: { uvx: { package: "fast-agent@0.10.1", args: ["serve"] } },
    };
    const dist = resolveAcpDistribution(agent, LINUX);
    assert.equal(dist?.kind, "uvx");
    if (dist?.kind === "uvx") assert.equal(dist.version, "0.10.1");
  });

  it("完全没有分发信息时给出可读原因", () => {
    const agent: AcpRegistryAgent = { id: "a", name: "A" };
    assert.equal(resolveAcpDistribution(agent, LINUX), null);
    assert.ok(acpDistributionUnavailableReason(agent, LINUX));
  });
});

describe("isValidSha256", () => {
  it("只接受 64 位十六进制", () => {
    assert.equal(isValidSha256(SHA), true);
    assert.equal(isValidSha256(SHA.toUpperCase()), true);
    assert.equal(isValidSha256("abc"), false);
    assert.equal(isValidSha256(undefined), false);
    assert.equal(isValidSha256(`${SHA}zz`), false);
  });
});

describe("parseAcpRegistryIndex", () => {
  it("解析上游真实结构", () => {
    const index = parseAcpRegistryIndex({
      version: "1.0.0",
      agents: [
        {
          id: "codex-acp",
          name: "Codex",
          version: "1.6.2",
          description: "d",
          distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.6.2" } },
        },
      ],
      extensions: [],
    });
    assert.equal(index.version, "1.0.0");
    assert.equal(index.agents.length, 1);
    assert.equal(index.agents[0]!.id, "codex-acp");
  });

  it("跳过缺 id/name 的条目而不是整份失败", () => {
    // 注册表每小时自动更新，一条畸形记录不该让整个目录消失。
    const index = parseAcpRegistryIndex({
      version: "1.0.0",
      agents: [{ name: "no id" }, { id: "no-name" }, null, "x", { id: "ok", name: "OK" }],
    });
    assert.deepEqual(
      index.agents.map((a) => a.id),
      ["ok"],
    );
  });

  it("结构不对时抛错", () => {
    assert.throws(() => parseAcpRegistryIndex(null), /不是对象/);
    assert.throws(() => parseAcpRegistryIndex({ version: "1" }), /agents/);
  });
});
