import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === "win32" ? "zakura-server.exe" : "zakura-server";
const binPath = path.join(root, "bin", exe);
const envFile = path.join(root, "data", "dev.env");

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

loadEnvFile(envFile);

function ensureSecret() {
  const secret = process.env.ZAKURA_SECRET;
  if (secret && secret.length >= 32) return;
  const generated = crypto.randomBytes(48).toString("hex").toUpperCase();
  process.env.ZAKURA_SECRET = generated;
  mkdirSync(path.dirname(envFile), { recursive: true });
  appendFileSync(envFile, `ZAKURA_SECRET=${generated}\n`, "utf8");
  console.log(`[dev] generated ZAKURA_SECRET and appended to ${envFile}`);
}

ensureSecret();

const defaults = {
  DATABASE_URL: "file:./data/zakura.db",
  DATA_DIR: "./data",
  PUBLIC_BASE_URL: "http://localhost:8787",
  WEB_PUBLIC_URL: "http://localhost:3001",
  CGO_ENABLED: "1",
};
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}

mkdirSync(path.join(root, "data"), { recursive: true });
mkdirSync(path.dirname(binPath), { recursive: true });

console.log("[dev] building zakura-server ...");
const build = spawnSync("go", ["build", "-o", binPath, "./cmd/zakura-server"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

console.log("[dev] starting zakura-server on", process.env.PUBLIC_BASE_URL);
const server = spawn(binPath, [], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

let exiting = false;
function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  server.kill(signal);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
server.on("exit", (code) => {
  process.exit(code ?? 0);
});
