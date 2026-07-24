/**
 * 将 stdio-bridge.ts 打成单文件 ESM，供容器挂载（无需容器内 node_modules）。
 */
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src/mcp/stdio-bridge.ts");
const srcOut = join(root, "src/mcp/stdio-bridge.bundle.mjs");
const distOut = join(root, "dist/mcp/stdio-bridge.bundle.mjs");

await esbuild.build({
  entryPoints: [entry],
  outfile: srcOut,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  packages: "bundle",
  banner: {
    js: `
import { createRequire as __stdioBridgeCreateRequire } from 'node:module';
import { fileURLToPath as __stdioBridgeFileURLToPath } from 'node:url';
import { dirname as __stdioBridgeDirname } from 'node:path';
const require = __stdioBridgeCreateRequire(import.meta.url);
const __filename = __stdioBridgeFileURLToPath(import.meta.url);
const __dirname = __stdioBridgeDirname(__filename);
`.trim(),
  },
});

mkdirSync(dirname(distOut), { recursive: true });
copyFileSync(srcOut, distOut);
console.log(`[build:stdio-bridge] wrote ${srcOut}`);
console.log(`[build:stdio-bridge] wrote ${distOut}`);
