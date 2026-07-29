import type { ResolvedRoute } from "./types.js";

export function acceptsImageInput(route: ResolvedRoute): boolean {
  const inputs = (route.meta?.modalities?.input ?? []).map((m) =>
    String(m).toLowerCase(),
  );
  return inputs.includes("image");
}

export function imageOmittedText(): string {
  return "[Image omitted: selected model does not support image input]";
}
