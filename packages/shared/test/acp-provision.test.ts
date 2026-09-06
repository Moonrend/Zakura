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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  ACP_PROVISION_ROOT,
  acpAdapterSource,
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

/**
 * The generated script resolves a package's bin entry with `node -e`. Inside the
 * adapter image node is always present, but the host bash used by these tests may
 * be WSL, where only `node.exe` exists via interop and no POSIX `node` is on PATH.
 *
 * Rather than weaken the script for the sake of the test, hand the test its own
 * `node`: a shim that delegates to `node.exe`. That keeps the test hermetic and
 * leaves production behaviour untouched.
 *
 * Runs `file` under bash with the shim first on PATH. Note WSL *rebuilds* PATH on
 * startup and discards whatever is handed over via the child env, so the
 * assignment has to happen inside the bash command line itself.
 */
function runInstallScript(file: string): void {
  if (process.platform !== "win32") {
    execFileSync("bash", [bashPath(file)], { stdio: "pipe" });
    return;
  }
  const dir = mkdtempSync(join(scratchRoot(), "acp-nodeshim-"));
  const shim = join(dir, "node");
  writeFileSync(shim, '#!/bin/sh\nexec node.exe "$@"\n');
  chmodSync(shim, 0o755);
  execFileSync("bash", ["-c", `PATH="$PWD/${bashPath(dir)}:$PATH" bash ${bashPath(file)}`], {
    stdio: "pipe",
  });
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

  it("fx / kiro / hermes 已由注册表接管，不再走宿主机安装脚本", () => {
    // 这三个曾经是仅剩的「自带安装器」特例：宿主机维护安装脚本，其余 39 个
    // 都只是拉镜像。加进注册表后它们必须和别人走同一条路径，否则等于把已经
    // 删掉的分支又悄悄养回来。
    for (const id of ["fx", "kiro", "hermes"]) {
      const source = acpAdapterSource(id);
      assert.equal(source.kind, "container", `${id} 应由注册表镜像提供`);
      if (source.kind !== "container") continue;
      assert.match(source.image, /^ghcr\.io\/moonrend\/acp-registry\//);
    }
  });

  it("uv 安装脚本不传 uv 不认识的 --tool-dir/--tool-bin-dir", () => {
    // `uv tool install` 只认 UV_TOOL_DIR / UV_TOOL_BIN_DIR 环境变量，没有对应的
    // 命令行参数。写成 flag 时 uv 会直接拒绝整条命令：
    //   error: unexpected argument '--tool-dir' found
    // 脚本本身仍是合法 bash，所以语法检查抓不到，只能断言调用约定。
    const scripts = [
      acpProvisionScript("fast-agent", { kind: "uvx", pkg: "fast-agent", version: "0.10.1" }),
      acpProvisionScript("hermes-acp", { kind: "uvx", pkg: "hermes-agent[acp]", version: "0.19.0" }),
    ];
    for (const script of scripts) {
      for (const line of script.split("\n")) {
        if (!/\buv tool install\b/.test(line)) continue;
        assert.ok(!/--tool-dir\b/.test(line), `uv tool install 不能带 --tool-dir：${line.trim()}`);
        assert.ok(!/--tool-bin-dir\b/.test(line), `uv tool install 不能带 --tool-bin-dir：${line.trim()}`);
        assert.match(line, /UV_TOOL_DIR=/, `必须用 UV_TOOL_DIR 指定安装根目录：${line.trim()}`);
        assert.match(line, /UV_TOOL_BIN_DIR=/, `必须用 UV_TOOL_BIN_DIR 指定 bin 目录：${line.trim()}`);
      }
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

  it("每个注册表 profile 都解析到已发布的容器镜像", () => {
    const ids = acpProfileIdsWithRegistrySource();
    assert.ok(ids.length >= 8, `注册表映射过少：${ids.length}`);
    for (const id of ids) {
      const source = acpAdapterSource(id);
      // 注册表为每个声明都构建并推送镜像，因此不再有"灰度"一说：
      // 任何注册表 profile 都必须解析到容器来源，解析不到就说明镜像缺失。
      assert.equal(source.kind, "container", `${id} 应走容器`);
      if (source.kind === "container") {
        assert.match(
          source.image,
          /^ghcr\.io\/moonrend\/acp-registry\//,
          `${id} 镜像地址异常：${source.image}`,
        );
      }
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
    //
    // 两处站点的上下文不同，必须分别处理：
    //   1) `if ! npm_config_cache=... ; then`
    //   2) 回退分支里缩进的 `npm_config_cache=...`
    // 站点 1 前面带 `!`，而 `! A && B` 在 shell 里解析成 `(! A) && B`：mkdir 成功
    // 后被 `!` 取反成假，`&&` 直接短路，printf 永远不执行，桩只建了目录却没造出
    // 可执行文件，最后表现为 BIN_NOT_FOUND。所以要用 `{ ...; }` 包成一条复合命令，
    // 让 `!` 作用在整个序列上而不是第一条。
    const stubCmd =
      `mkdir -p ${JSON.stringify(bashPath(join(root, binPath)))} && ` +
      `printf '#!/bin/sh\\n' > ${JSON.stringify(bashPath(join(root, binPath, "codex-acp")))}`;
    return script
      .split(ACP_PROVISION_ROOT)
      .join(bashPath(join(root, "acp")))
      .split("/workspace/.zakura/cache")
      .join(bashPath(join(root, "cache")))
      .replace(/^if ! npm_config_cache=.*$/m, `if ! { ${stubCmd}; }; then`)
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
        .join(bashPath(join(root, "cache")))
        .replace(
          // 两处 npm 站点必须都桩掉。旧写法 `/^npm_config_cache=/m` 一处都匹配不上：
          // 首处前面有 `if ! `，回退分支那处带缩进，于是脚本真的去调 npm，在没有
          // npm 的 bash 里直接 `command not found`。
          /^(?:if ! )?[ \t]*npm_config_cache=.*$/gm,
          (line) => {
            const cmd =
              `mkdir -p ${JSON.stringify(bashPath(pkgDir))} && ` +
              `printf '%s' '{"name":"@qwen-code/qwen-code","version":"0.22.3","bin":{"qwen":"cli-entry.js"}}' > ${JSON.stringify(bashPath(join(pkgDir, "package.json")))} && ` +
              `mkdir -p ${JSON.stringify(bashPath(binDir))} && ` +
              `printf '#!/bin/sh\\n' > ${JSON.stringify(bashPath(join(binDir, "qwen")))} && ` +
              `chmod +x ${JSON.stringify(bashPath(join(binDir, "qwen")))} && ` +
              // 传递依赖污染 .bin，逼逻辑去读 package.json 而不是数条目。
              `printf '#!/bin/sh\\n' > ${JSON.stringify(bashPath(join(binDir, "node-gyp-build")))} && ` +
              `printf '#!/bin/sh\\n' > ${JSON.stringify(bashPath(join(binDir, "semver")))}`;
            // 同样要包成复合命令：`! A && B` 解析成 `(! A) && B`，会短路掉后续。
            return line.startsWith("if ! ") ? `if ! { ${cmd}; }; then` : cmd;
          },
        );
      const file = join(root, "install.sh");
      writeFileSync(file, script);
      // 脚本用 `node -e` 读 package.json 的 bin 字段。适配器镜像里必有 node，
      // 但宿主的 bash 可能是 WSL——那里只有 node.exe，没有 POSIX node。
      runInstallScript(file);

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
