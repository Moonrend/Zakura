#!/usr/bin/env node
/**
 * Produce a pure open-source tree by removing the SaaS edition package
 * and SaaS-only web routes listed in packages/saas/strip-manifest.json.
 *
 * Usage:
 *   node scripts/strip-saas.mjs              # in-place (destructive)
 *   node scripts/strip-saas.mjs --dry-run    # print actions only
 *   node scripts/strip-saas.mjs --out ../Zakura-oss  # copy then strip
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1] ?? "") : null;

if (outIdx >= 0 && !outDir) {
  console.error("Usage: --out <directory>");
  process.exit(1);
}

const root = outDir ?? repoRoot;

if (outDir) {
  if (existsSync(outDir)) {
    console.error(`Refusing to overwrite existing directory: ${outDir}`);
    process.exit(1);
  }
  console.log(`Copying ${repoRoot} → ${outDir} …`);
  if (!dryRun) {
    mkdirSync(dirname(outDir), { recursive: true });
    cpSync(repoRoot, outDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(repoRoot.length).replace(/\\/g, "/");
        if (
          rel.includes("node_modules") ||
          rel.includes("/.git/") ||
          rel.endsWith("/.git") ||
          rel.includes("/data/") ||
          rel.endsWith("/data") ||
          rel.includes("/.next/") ||
          rel.includes("/dist/")
        ) {
          return false;
        }
        return true;
      },
    });
  }
}

const manifestPath = join(root, "packages/saas/strip-manifest.json");
if (!existsSync(manifestPath) && !dryRun) {
  // When stripping in-place after a previous run, or when copying without saas
  console.error(`Manifest not found: ${manifestPath}`);
  console.error("Is this already an OSS tree, or is packages/saas missing?");
  process.exit(1);
}

const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : {
      directories: ["packages/saas"],
      files: [
        "apps/web/src/app/register/page.tsx",
        "apps/web/src/app/invite/[token]/page.tsx",
        "apps/web/src/app/dashboard/admin/page.tsx",
        "apps/web/src/app/dashboard/settings/members/page.tsx",
        "apps/web/src/app/dashboard/settings/tenants/page.tsx",
      ],
      packageJsonDeps: {
        "apps/server/package.json": ["@zakura/saas"],
        "apps/web/package.json": ["@zakura/saas"],
      },
    };

function removePath(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    console.log(`  skip (missing): ${rel}`);
    return;
  }
  console.log(`  remove: ${rel}`);
  if (!dryRun) rmSync(abs, { recursive: true, force: true });
}

console.log(dryRun ? "Dry run — would strip:" : "Stripping SaaS edition:");

for (const dir of manifest.directories ?? []) removePath(dir);
for (const file of manifest.files ?? []) removePath(file);

for (const [pkgRel, deps] of Object.entries(manifest.packageJsonDeps ?? {})) {
  const pkgPath = join(root, pkgRel);
  if (!existsSync(pkgPath)) {
    console.log(`  skip package.json (missing): ${pkgRel}`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  let changed = false;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!pkg[section]) continue;
    for (const dep of deps) {
      if (pkg[section][dep]) {
        console.log(`  ${pkgRel}: drop ${section}.${dep}`);
        delete pkg[section][dep];
        changed = true;
      }
    }
  }
  if (changed && !dryRun) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

// Soften README SaaS env docs if present
const readmePath = join(root, "README.md");
if (existsSync(readmePath) && !dryRun) {
  let readme = readFileSync(readmePath, "utf8");
  if (readme.includes("ZAKURA_EDITION") || readme.includes("ZAKURA_MULTI_TENANT")) {
    // Leave README; docs/edition.md may be removed with saas. No rewrite required.
  }
  void readme;
}

console.log(dryRun ? "Dry run complete." : `Done. OSS tree at: ${root}`);
console.log("Next: pnpm install && pnpm setup  (edition defaults to oss)");
