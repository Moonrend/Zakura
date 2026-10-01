import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import { spaces } from "../../src/db/schema.js";

/**
 * 测试辅助：为租户准备一个默认 Space 并返回其 id。
 * 0062 之后 agents.space_id 必填，旧测试直接插 agents 需要先有空间。
 */
export async function ensureTestSpace(
  db: Db,
  tenantId: string,
  opts?: {
    slug?: string;
    enableComputer?: boolean;
    workspaceImage?: string | null;
    runtimeNodeId?: string | null;
  },
): Promise<string> {
  const slug = opts?.slug ?? "default";
  const existing = await db.query.spaces.findFirst({
    where: and(eq(spaces.tenantId, tenantId), eq(spaces.slug, slug)),
  });
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (opts?.enableComputer && !existing.enableComputer) patch.enableComputer = true;
    if (opts?.runtimeNodeId !== undefined && existing.runtimeNodeId !== opts.runtimeNodeId) {
      patch.runtimeNodeId = opts.runtimeNodeId;
    }
    if (opts?.workspaceImage !== undefined && existing.workspaceImage !== opts.workspaceImage) {
      patch.workspaceImage = opts.workspaceImage;
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date();
      await db.update(spaces).set(patch).where(eq(spaces.id, existing.id));
    }
    return existing.id;
  }
  const id = `spc_test_${tenantId}_${slug}`;
  await db
    .insert(spaces)
    .values({
      id,
      tenantId,
      name: `Test space ${slug}`,
      slug,
      enableComputer: opts?.enableComputer ?? false,
      workspaceImage: opts?.workspaceImage ?? null,
      runtimeNodeId: opts?.runtimeNodeId ?? null,
    })
    .onConflictDoNothing();
  const row = await db.query.spaces.findFirst({
    where: and(eq(spaces.tenantId, tenantId), eq(spaces.slug, slug)),
  });
  if (!row) throw new Error("测试空间创建失败");
  return row.id;
}
