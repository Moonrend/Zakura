/**
 * ACP 适配器按需安装。
 *
 * 这些脚本在工作区容器里跑，语法错误只会表现为用户第一次启动 ACP 时一个莫名的
 * exit 2，所以每个生成的脚本都要过一遍 `bash -n`；而幂等标记、原子改名和 GC
 * 这些语义直接决定「更新一次适配器会不会把磁盘占用翻倍」，所以对着真实临时目录跑。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_PROVISION_ROOT,
  acpAdapterSource,
  acpCustomCommand,
  acpCustomProvisionScript,
  acpDiskUsageScript,
  acpGcScript,
  acpInstalledVersionsScript,
  acpProfileIdsWithRegistrySource,
  acpProvisionScript,
  acpProvisionedCommand,
  acpVersionDir,
  type AcpProvisionPlan,
} from "../src/index.js";

const SHA = "a".repeat(64);

function assertValidBash(script: string, label: string): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-syntax-"));
  try {
    const file = join(dir, "script.sh");
    writeFileSync(file, script);
    execFileSync("bash", ["-n", file], { stdio: "pipe" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    assert.fail(`${label} 不是合法的 bash：${detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLANS: Array<[string, AcpProvisionPlan]> = [
  ["npx pinned", { kind: "npx", pkg: "@agentclientprotocol/codex-acp", version: "1.6.2" }],
  ["npx latest", { kind: "npx", pkg: "nova", version: "latest" }],
  ["uvx", { kind: "uvx", pkg: "fast-agent", version: "0.10.1" }],
  ["binary zip", { kind: "binary", url: "https://e/x-linux-x86_64.zip", sha256: SHA, cmd: "./agent", version: "1.0.0" }],
  ["binary tar.gz", { kind: "binary", url: "https://e/x.tar.gz", sha256: SHA, cmd: "bin/agent", version: "1.0.0" }],
  ["binary raw", { kind: "binary", url: "https://e/agent", sha256: SHA, cmd: "agent", version: "1.0.0" }],
];

describe("ACP 适配器安装脚本", () => {
  it("所有分发形态生成的脚本语法合法", () => {
    for (const [label, plan] of PLANS) {
      assertValidBash(acpProvisionScript("some-agent", plan), label);
    }
  });

  it("自带安装器的适配器脚本语法合法", () => {
    for (const id of ["fx", "kiro", "hermes"]) {
      const source = acpAdapterSource(id);
      assert.equal(source.kind, "custom", `${id} 应使用自带安装器`);
      if (source.kind !== "custom") return;
      assertValidBash(acpCustomProvisionScript(source), `custom:${id}`);
      // 必须是绝对路径：适配器以空 HOME 启动，PATH 查找不可靠。
      assert.ok(acpCustomCommand(source).startsWith(ACP_PROVISION_ROOT));
    }
  });

  it("维护脚本语法合法", () => {
    assertValidBash(acpInstalledVersionsScript(), "installed-versions");
    assertValidBash(acpDiskUsageScript(), "disk-usage");
    assertValidBash(acpGcScript([]), "gc empty");
    assertValidBash(
      acpGcScript([
        { id: "codex-acp", version: "1.6.2" },
        { id: "kiro", version: "stable" },
      ]),
      "gc with keep",
    );
  });

  it("二进制安装必须校验 sha256", () => {
    const script = acpProvisionScript("x", {
      kind: "binary",
      url: "https://e/x.tar.gz",
      sha256: SHA,
      cmd: "bin/x",
      version: "1.0.0",
    });
    // 下载的是会在用户工作区里执行的可执行文件，「注册表这么说」不足以作为来源证明。
    assert.ok(script.includes("sha256sum -c -"), "必须校验校验和");
    assert.ok(
      script.indexOf("sha256sum -c -") < script.indexOf("tar -xzf"),
      "必须先校验再解包",
    );
  });

  it("每个走注册表的内置 profile 都能解析到注册表来源", () => {
    const ids = acpProfileIdsWithRegistrySource();
    assert.ok(ids.length >= 8, `注册表映射过少：${ids.length}`);
    for (const id of ids) {
      const source = acpAdapterSource(id);
      assert.equal(source.kind, "registry", `${id} 应走注册表`);
    }
  });

  it("未知 profile 视为镜像内置，不做安装", () => {
    assert.equal(acpAdapterSource("my-custom-cli").kind, "image");
  });

  it("路径按 id/version 分目录，便于原子切换与回收", () => {
    const plan: AcpProvisionPlan = { kind: "npx", pkg: "codex-acp", version: "1.6.2" };
    assert.equal(acpVersionDir("codex-acp", "1.6.2"), `${ACP_PROVISION_ROOT}/codex-acp/1.6.2`);
    assert.ok(acpProvisionedCommand("codex-acp", plan).startsWith(ACP_PROVISION_ROOT));
    // 版本必须出现在路径里，否则两个版本会互相覆盖，也就无法原子切换。
    assert.ok(acpProvisionedCommand("codex-acp", plan).includes("1.6.2"));
  });

  it("id / version 里的路径穿越字符被清理", () => {
    const dir = acpVersionDir("../../etc", "../evil");
    assert.ok(dir.startsWith(`${ACP_PROVISION_ROOT}/`), dir);
    assert.ok(!dir.includes(".."), dir);
  });
});

describe("ACP 安装脚本行为（桩掉真实安装）", () => {
  /** 把绝对工作区路径改写到临时目录，并用「创建可执行文件」替换真实安装步骤。 */
  function stubbed(script: string, root: string, binPath: string): string {
    return script
      .split(ACP_PROVISION_ROOT)
      .join(join(root, "acp"))
      .split("/workspace/.zakura/cache")
      .join(join(root, "cache"))
      .replace(
        /^npm_config_cache=.*$/m,
        `mkdir -p ${JSON.stringify(join(root, binPath))} && ` +
          `printf '#!/bin/sh\\n' > ${JSON.stringify(join(root, binPath, "codex-acp"))}`,
      );
  }

  it("首次安装写入 .ok 并把 .partial 原子改名", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-behave-"));
    try {
      const script = stubbed(
        acpProvisionScript("codex-acp", { kind: "npx", pkg: "codex-acp", version: "1.6.2" }),
        root,
        "acp/codex-acp/1.6.2.partial/bin",
      );
      const file = join(root, "install.sh");
      writeFileSync(file, script);
      execFileSync("bash", [file], { stdio: "pipe" });

      assert.ok(existsSync(join(root, "acp/codex-acp/1.6.2/.ok")), "缺少 .ok 标记");
      assert.ok(
        !existsSync(join(root, "acp/codex-acp/1.6.2.partial")),
        ".partial 应已改名，中断的安装不能被当成完成",
      );

      // 二次运行必须靠 .ok 短路：删掉可执行文件后重跑，它不应该被重新装回来。
      rmSync(join(root, "acp/codex-acp/1.6.2/bin/codex-acp"), { force: true });
      execFileSync("bash", [file], { stdio: "pipe" });
      assert.ok(
        !existsSync(join(root, "acp/codex-acp/1.6.2/bin/codex-acp")),
        "已有 .ok 时不应重复安装",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GC 保留指定版本、清掉其余版本与残留 .partial", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-gc-"));
    try {
      for (const v of ["1.6.2", "9.9.9"]) {
        mkdirSync(join(root, `acp/codex-acp/${v}`), { recursive: true });
        writeFileSync(join(root, `acp/codex-acp/${v}/.ok`), "");
      }
      mkdirSync(join(root, "acp/codex-acp/1.0.0.partial"), { recursive: true });

      const gc = acpGcScript([{ id: "codex-acp", version: "1.6.2" }])
        .split(ACP_PROVISION_ROOT)
        .join(join(root, "acp"));
      const file = join(root, "gc.sh");
      writeFileSync(file, gc);
      execFileSync("bash", [file], { stdio: "pipe" });

      assert.ok(existsSync(join(root, "acp/codex-acp/1.6.2")), "不该删掉要保留的版本");
      assert.ok(!existsSync(join(root, "acp/codex-acp/9.9.9")), "旧版本应被回收");
      assert.ok(
        !existsSync(join(root, "acp/codex-acp/1.0.0.partial")),
        "中断的安装残留应被清掉",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
