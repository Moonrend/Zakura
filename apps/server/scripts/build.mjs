import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exeExt = process.platform === "win32" ? ".exe" : "";

process.env.CGO_ENABLED ??= "1";

for (const name of ["zakura-server", "zakura-db", "zakura-stdio-bridge"]) {
  const out = path.join(root, "bin", name + exeExt);
  console.log(`[build] ${name} -> ${out}`);
  const result = spawnSync("go", ["build", "-o", out, `./cmd/${name}`], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
