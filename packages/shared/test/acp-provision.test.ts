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
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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

/**
 * bash on this host may be WSL or Git-for-Windows, and neither reads a native
 * `C:\...` path the way node hands it over. Passing a path relative to the
 * package dir works under both, and is a no-op on Linux/macOS CI.
 */
function bashPath(abs: string): string {
  const rel = relative(process.cwd(), abs);
  return process.platform === "win32" ? rel.split(sep).join("/") : abs;
}

/**
 * Scratch root for tests. On Windows the system temp dir usually sits on another
 * drive than the checkout, and a cross-drive relative path is impossible to
 * express — so keep scratch dirs inside the package there.
 */
function scratchRoot(): string {
  if (process.platform !== "win32") return tmpdir();
  const local = join(process.cwd(), ".test-tmp");
  mkdirSync(local, { recursive: true });
  return local;
}

function assertValidBash(script: string, label: string): void {
  const dir = mkdtempSync(join(scratchRoot(), "acp-syntax-"));
  try {
    const file = join(dir, "script.sh");
    writeFileSync(file, script);
    execFileSync("bash", ["-n", bashPath(file)], { stdio: "pipe" });
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

  it("每个走注册表的内置 profile 都能解析到注册表来源（容器化的除外）", () => {
    const ids = acpProfileIdsWithRegistrySource();
    assert.ok(ids.length >= 8, `注册表映射过少：${ids.length}`);
    let containerized = 0;
    for (const id of ids) {
      const source = acpAdapterSource(id);
      // 容器化灰度中的 profile 由镜像分发，会覆盖注册表来源；这是预期的，
      // 但其余 profile 必须仍然走注册表，否则就是灰度开关误伤。
      if (source.kind === "container") {
        containerized += 1;
        continue;
      }
      assert.equal(source.kind, "registry", `${id} 应走注册表`);
    }
    // 灰度必须是少数：如果哪天所有 profile 都被切成容器，这条断言会提醒我们
    // 这个测试已经失去意义，需要重写而不是继续放行。
    assert.ok(
      containerized < ids.length,
      "不应所有注册表 profile 都被容器化，该测试需重写",
    );
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

  it("npx 计划可携带伴生包，并写入同一条 install 命令", () => {
    const plan: AcpProvisionPlan = {
      kind: "npx",
      pkg: "pi-acp",
      version: "0.0.33",
      extraPackages: ["@earendil-works/pi-coding-agent@0.84.4"],
    };
    const script = acpProvisionScript("pi-acp", plan);
    assertValidBash(script, "npx+extraPackages");
    assert.ok(script.includes("pi-acp@0.0.33"));
    assert.ok(script.includes("@earendil-works/pi-coding-agent@0.84.4"));
    // 必须同一条 install 命令，否则第二次 --prefix 安装会清掉第一个包。
    assert.ok(
      /npm install[^\n]*pi-acp@0\.0\.33[^\n]*@earendil-works\/pi-coding-agent@0\.84\.4/.test(script),
      "伴生包应与主包在同一条 npm install 里",
    );
  });
});

describe("ACP 安装脚本行为（桩掉真实安装）", () => {
  /** 把绝对工作区路径改写到临时目录，并用「创建可执行文件」替换真实安装步骤。 */
  function stubbed(script: string, root: string, binPath: string): string {
    // 安装行有两种形态：latest 是裸命令，钉版本时包在 `if ! ... ; then` 回退分支里。
    // 桩必须同时覆盖，否则会漏桩并真的去调 npm。
    const stubCmd =
      `mkdir -p ${JSON.stringify(bashPath(join(root, binPath)))} && ` +
      `printf '#!/bin/sh\\n' > ${JSON.stringify(bashPath(join(root, binPath, "codex-acp")))}`;
    return script
      .split(ACP_PROVISION_ROOT)
      .join(bashPath(join(root, "acp")))
      .split("/workspace/.zakura/cache")
      .join(bashPath(join(root, "cache")))
      .replace(/^if ! npm_config_cache=.*$/m, `if ! ${stubCmd}; then`)
      // 回退分支里的第二次 npm 调用也要桩掉，否则钉版本用例会去调真实 npm。
      .replace(/^\s*npm_config_cache=.*$/gm, stubCmd);
  }

  it("首次安装写入 .ok 并把 .partial 原子改名", () => {
    const root = mkdtempSync(join(scratchRoot(), "acp-behave-"));
    try {
      const script = stubbed(
        acpProvisionScript("codex-acp", { kind: "npx", pkg: "codex-acp", version: "1.6.2" }),
        root,
        "acp/codex-acp/1.6.2.partial/node_modules/.bin",
      );
      const file = join(root, "install.sh");
      writeFileSync(file, script);
      execFileSync("bash", [bashPath(file)], { stdio: "pipe" });

      assert.ok(existsSync(join(root, "acp/codex-acp/1.6.2/.ok")), "缺少 .ok 标记");
      assert.ok(
        !existsSync(join(root, "acp/codex-acp/1.6.2.partial")),
        ".partial 应已改名，中断的安装不能被当成完成",
      );

      // 二次运行必须靠 .ok 短路：删掉可执行文件后重跑，它不应该被重新装回来。
      rmSync(join(root, "acp/codex-acp/1.6.2/node_modules/.bin/codex-acp"), { force: true });
      execFileSync("bash", [bashPath(file)], { stdio: "pipe" });
      assert.ok(
        !existsSync(join(root, "acp/codex-acp/1.6.2/node_modules/.bin/codex-acp")),
        "已有 .ok 时不应重复安装",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("包把可执行文件改名时，按 package.json 的 bin 字段建别名", () => {
    const root = mkdtempSync(join(scratchRoot(), "acp-rename-"));
    try {
      const binDir = join(root, "acp/qwen-code/0.22.3.partial/node_modules/.bin");
      const pkgDir = join(root, "acp/qwen-code/0.22.3.partial/node_modules/@qwen-code/qwen-code");
      const script = acpProvisionScript("qwen-code", {
        kind: "npx",
        pkg: "@qwen-code/qwen-code",
        version: "0.22.3",
      })
        .split(ACP_PROVISION_ROOT)
        .join(bashPath(join(root, "acp")))
        .split("/workspace/.zakura/cache")
        .join(join(root, "cache"))
        .replace(
          /^npm_config_cache=.*$/m,
          `mkdir -p ${JSON.stringify(pkgDir)} && ` +
            `printf '%s' '{"name":"@qwen-code/qwen-code","version":"0.22.3","bin":{"qwen":"cli-entry.js"}}' > ${JSON.stringify(join(pkgDir, "package.json"))} && ` +
            `mkdir -p ${JSON.stringify(binDir)} && ` +
            `printf '#!/bin/sh\n' > ${JSON.stringify(join(binDir, "qwen"))} && ` +
            `chmod +x ${JSON.stringify(join(binDir, "qwen"))} && ` +
            // 传递依赖污染 .bin，逼逻辑去读 package.json 而不是数条目。
            `printf '#!/bin/sh\n' > ${JSON.stringify(join(binDir, "node-gyp-build"))} && ` +
            `printf '#!/bin/sh\n' > ${JSON.stringify(join(binDir, "semver"))}`,
        );
      const file = join(root, "install.sh");
      writeFileSync(file, script);
      execFileSync("bash", [bashPath(file)], { stdio: "pipe" });

      assert.ok(existsSync(join(root, "acp/qwen-code/0.22.3/.ok")), "缺少 .ok 标记");
      const alias = join(root, "acp/qwen-code/0.22.3/node_modules/.bin/qwen-code");
      assert.ok(existsSync(alias), "缺少 qwen-code 别名");
      assert.equal(readlinkSync(alias), "qwen", "别名应指向真实的 qwen 可执行文件");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GC 保留指定版本、清掉其余版本与残留 .partial", () => {
    const root = mkdtempSync(join(scratchRoot(), "acp-gc-"));
    try {
      for (const v of ["1.6.2", "9.9.9"]) {
        mkdirSync(join(root, `acp/codex-acp/${v}`), { recursive: true });
        writeFileSync(join(root, `acp/codex-acp/${v}/.ok`), "");
      }
      mkdirSync(join(root, "acp/codex-acp/1.0.0.partial"), { recursive: true });

      const gc = acpGcScript([{ id: "codex-acp", version: "1.6.2" }])
        .split(ACP_PROVISION_ROOT)
        .join(bashPath(join(root, "acp")));
      const file = join(root, "gc.sh");
      writeFileSync(file, gc);
      execFileSync("bash", [bashPath(file)], { stdio: "pipe" });

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
