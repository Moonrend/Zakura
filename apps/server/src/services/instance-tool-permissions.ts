export function readToolPermissionOverrides(
  config: Record<string, unknown>,
): Record<string, boolean> {
  const raw = config.toolPermissions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function isToolEnabled(
  config: Record<string, unknown>,
  toolName: string,
): boolean {
  return readToolPermissionOverrides(config)[toolName] ?? true;
}

export function filterEnabledTools<T extends { name: string }>(
  config: Record<string, unknown>,
  tools: T[],
): T[] {
  const overrides = readToolPermissionOverrides(config);
  return tools.filter((t) => overrides[t.name] ?? true);
}
