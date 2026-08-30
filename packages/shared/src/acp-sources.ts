/**
 * Where each builtin ACP profile's binary comes from.
 *
 * Most builtin profiles correspond 1:1 to an entry in the upstream ACP registry, so
 * they can be provisioned on demand with pinned versions and no image release. A
 * few ship their own installer and are not in the curated registry (which requires
 * verified `authMethods`); those get an explicit script.
 *
 * Keeping this as a table rather than a chain of `if (id === …)` is deliberate: the
 * registry has ~39 agents and grows weekly, and the old per-id branching in
 * `acp-storage.ts` is exactly what made adding one a multi-file change.
 */

import { ACP_PROVISION_CACHE, acpVersionDir } from "./acp-provision.js";

export type AcpAdapterSource =
  /** Provision from the upstream registry under this id. */
  | { kind: "registry"; registryId: string }
  /**
   * Vendor-specific installer. `probeVersion` is a shell snippet printing the
   * installed version to stdout, used to detect updates the same way registry
   * versions are.
   */
  | {
      kind: "custom";
      /** Directory-name segment used for the install; also the GC key. */
      slug: string;
      /** Shell script installing into `$ZAKURA_ACP_DIR`, which we create. */
      install: string;
      /** Path of the executable, relative to `$ZAKURA_ACP_DIR`. */
      bin: string;
      probeVersion?: string;
    }
  /** Present in the image already; nothing to install. */
  | { kind: "image" };

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Builtin profile id → registry id.
 *
 * Verified against the live registry index (39 agents). Ids that differ from our
 * own profile naming are the reason this mapping is explicit rather than inferred.
 */
const REGISTRY_BY_PROFILE: Record<string, string> = {
  "claude-code": "claude-acp",
  codex: "codex-acp",
  "gemini-cli": "gemini",
  opencode: "opencode",
  copilot: "github-copilot-cli",
  "kimi-code": "kimi",
  pi: "pi-acp",
  grok: "grok-build",
  auggie: "auggie",
  cline: "cline",
  cursor: "cursor",
  devin: "devin",
  "factory-droid": "factory-droid",
  goose: "goose",
  junie: "junie",
  "qwen-code": "qwen-code",
  "mistral-vibe": "mistral-vibe",
  nova: "nova",
  "fast-agent": "fast-agent",
  dirac: "dirac",
  codebuddy: "codebuddy-code",
  amp: "amp-acp",
  deepagents: "deepagents",
  poolside: "poolside",
  sigit: "sigit",
};

/**
 * Installers for adapters the registry does not carry.
 *
 * Both fx and Kiro install into `$HOME/...` and append to a shell rc file by
 * default. We override the install directory instead, because ACP adapters run with
 * `HOME` pointed at a throwaway state dir — an rc-file PATH entry is never sourced,
 * which is precisely why `exec fx` used to fail with "not found".
 */
const CUSTOM_SOURCES: Record<string, Extract<AcpAdapterSource, { kind: "custom" }>> = {
  fx: {
    kind: "custom",
    slug: "fx",
    bin: "bin/fx",
    install: [
      'mkdir -p "$ZAKURA_ACP_DIR/bin"',
      'curl -fsSL https://fx.sh/setup.sh | FX_INSTALL_DIR="$ZAKURA_ACP_DIR/bin" bash >&2',
    ].join("\n"),
    probeVersion: '"$ZAKURA_ACP_BIN" --version 2>/dev/null | head -1',
  },
  kiro: {
    kind: "custom",
    slug: "kiro",
    bin: "bin/kiro-cli",
    // The vendor installer only targets $HOME/.local/bin and needs a TTY-ish env;
    // fetch the published archive directly so the install is contained and scriptable.
    install: [
      'mkdir -p "$ZAKURA_ACP_DIR/bin" "$ZAKURA_ACP_DIR/tmp"',
      'arch="$(uname -m)"',
      'case "$arch" in',
      '  x86_64|amd64) kiro_arch=x86_64 ;;',
      '  aarch64|arm64) kiro_arch=aarch64 ;;',
      '  *) echo "ZAKURA_ACP_UNSUPPORTED_ARCH:$arch" >&2; exit 1 ;;',
      'esac',
      // musl vs glibc: the vendor ships both; pick musl when glibc is absent.
      'if ldd --version 2>&1 | grep -qi musl || [ ! -e /lib/x86_64-linux-gnu/libc.so.6 -a ! -e /lib64/libc.so.6 -a ! -e /lib/aarch64-linux-gnu/libc.so.6 ]; then',
      '  kiro_file="kirocli-${kiro_arch}-linux-musl.zip"',
      'else',
      '  kiro_file="kirocli-${kiro_arch}-linux.zip"',
      'fi',
      'curl -fsSL --max-time 300 -o "$ZAKURA_ACP_DIR/tmp/kiro.zip" "https://prod.download.cli.kiro.dev/stable/${kiro_file}"',
      'unzip -q -o "$ZAKURA_ACP_DIR/tmp/kiro.zip" -d "$ZAKURA_ACP_DIR/tmp/extract"',
      'found="$(find "$ZAKURA_ACP_DIR/tmp/extract" -type f -name kiro-cli -perm -u+x -print -quit 2>/dev/null || true)"',
      '[ -n "$found" ] || found="$(find "$ZAKURA_ACP_DIR/tmp/extract" -type f -name kiro-cli -print -quit 2>/dev/null || true)"',
      '[ -n "$found" ] || { echo "ZAKURA_ACP_BIN_NOT_FOUND:kiro-cli" >&2; exit 1; }',
      'cp "$found" "$ZAKURA_ACP_DIR/bin/kiro-cli"',
      // kiro-cli-chat ships alongside and is required by some subcommands.
      'chat="$(find "$ZAKURA_ACP_DIR/tmp/extract" -type f -name kiro-cli-chat -print -quit 2>/dev/null || true)"',
      '[ -z "$chat" ] || cp "$chat" "$ZAKURA_ACP_DIR/bin/kiro-cli-chat"',
      'chmod +x "$ZAKURA_ACP_DIR/bin/"kiro-cli*',
      'rm -rf "$ZAKURA_ACP_DIR/tmp"',
    ].join("\n"),
    probeVersion: '"$ZAKURA_ACP_BIN" --version 2>/dev/null | head -1',
  },
  hermes: {
    kind: "custom",
    slug: "hermes",
    bin: "bin/hermes-acp",
    install: [
      'mkdir -p "$ZAKURA_ACP_DIR/bin"',
      `command -v uv >/dev/null 2>&1 || { echo "ZAKURA_ACP_NEED_UV" >&2; exit 127; }`,
      `UV_CACHE_DIR=${shq(`${ACP_PROVISION_CACHE}/uv`)} ` +
        'uv tool install --force --tool-dir "$ZAKURA_ACP_DIR/tools" ' +
        '--tool-bin-dir "$ZAKURA_ACP_DIR/bin" "hermes-agent[acp]" >&2',
      // The package exposes `hermes`; ACP mode is a subcommand, so wrap it.
      'if [ ! -x "$ZAKURA_ACP_DIR/bin/hermes-acp" ]; then',
      '  printf \'%s\\n\' \'#!/bin/sh\' \'exec "$(dirname "$0")/hermes" acp "$@"\' >"$ZAKURA_ACP_DIR/bin/hermes-acp"',
      '  chmod +x "$ZAKURA_ACP_DIR/bin/hermes-acp"',
      'fi',
    ].join("\n"),
    probeVersion: '"$ZAKURA_ACP_DIR/bin/hermes" --version 2>/dev/null | head -1',
  },
};

/** How to obtain the adapter for a builtin profile id. */
export function acpAdapterSource(profileId: string): AcpAdapterSource {
  const registryId = REGISTRY_BY_PROFILE[profileId];
  if (registryId) return { kind: "registry", registryId };
  const custom = CUSTOM_SOURCES[profileId];
  if (custom) return custom;
  // Custom/user-defined profiles supply their own command; nothing to provision.
  return { kind: "image" };
}

/** Registry id for a builtin profile, when it has one. */
export function acpRegistryIdForProfile(profileId: string): string | null {
  return REGISTRY_BY_PROFILE[profileId] ?? null;
}

export function acpProfileIdsWithRegistrySource(): string[] {
  return Object.keys(REGISTRY_BY_PROFILE);
}

/**
 * Install script for a `custom` source. Versioned like registry adapters so the
 * same `.ok` marker, atomic-rename and GC logic applies; `version` is a build tag
 * ("stable") rather than a semver because these installers only publish a channel.
 */
export function acpCustomProvisionScript(
  source: Extract<AcpAdapterSource, { kind: "custom" }>,
  version = "stable",
): string {
  const dir = acpVersionDir(source.slug, version);
  const partial = `${dir}.partial`;
  return [
    "set -eu",
    `if [ -f ${shq(`${dir}/.ok`)} ]; then exit 0; fi`,
    `rm -rf ${shq(partial)}`,
    `mkdir -p ${shq(partial)} ${shq(ACP_PROVISION_CACHE)}`,
    `ZAKURA_ACP_DIR=${shq(partial)}`,
    "export ZAKURA_ACP_DIR",
    source.install,
    `if [ ! -e ${shq(`${partial}/${source.bin}`)} ]; then`,
    `  echo ${shq(`ZAKURA_ACP_BIN_NOT_FOUND:${dir}/${source.bin}`)} >&2`,
    `  rm -rf ${shq(partial)}`,
    `  exit 1`,
    `fi`,
    `touch ${shq(`${partial}/.ok`)}`,
    `rm -rf ${shq(dir)}`,
    `mv ${shq(partial)} ${shq(dir)}`,
    `echo ${shq(`ZAKURA_ACP_INSTALLED:${source.slug}:${version}`)} >&2`,
  ].join("\n");
}

/** Absolute path of a `custom` source's executable once installed. */
export function acpCustomCommand(
  source: Extract<AcpAdapterSource, { kind: "custom" }>,
  version = "stable",
): string {
  return `${acpVersionDir(source.slug, version)}/${source.bin}`;
}
