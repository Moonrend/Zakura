/**
 * 迁移必须能从零跑完。
 *
 * drizzle 的 migrator 把每个 statement-breakpoint 分片当成一条语句、走扩展协议
 * （prepared statement）下发，而扩展协议一次只允许一条命令。手写迁移里漏掉分隔
 * 标记时，整个迁移会在该文件上以 42601 `cannot insert multiple commands into a
 * prepared statement` 中断 —— 新装库会卡在半截 schema 上，而且已装库看不出问题
 * （drizzle 按 folderMillis 判断是否已应用，不比对内容哈希），非常容易漏。
 *
 * 这里做两层防护：
 *   1. 静态检查每个分片只含一条顶层命令；
 *   2. 真的对着一个空 PGlite 跑一遍全量迁移，并抽查关键表/列。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const BREAKPOINT = ["--", ">", " statement-breakpoint"].join("");

/**
 * 数出一段 SQL 里的顶层命令数，跳过行/块注释、字符串字面量和 $$ 包裹的函数体
 * （DO 块内部的多条语句属于同一条命令，不该被算成多条）。
 */
function countTopLevelCommands(sql: string): number {
  let i = 0;
  let count = 0;
  let sawContent = false;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      sawContent = true;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      sawContent = true;
      continue;
    }
    if (ch === ";") {
      if (sawContent) count++;
      sawContent = false;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) sawContent = true;
    i++;
  }
  if (sawContent) count++;
  return count;
}

describe("drizzle migrations", () => {
  it("每个 statement-breakpoint 分片只含一条顶层命令", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    assert.ok(files.length > 0, "没有找到迁移文件");

    const offenders: string[] = [];
    for (const file of files) {
      const raw = readFileSync(join(migrationsDir, file), "utf8");
      raw.split(BREAKPOINT).forEach((chunk, idx) => {
        const n = countTopLevelCommands(chunk);
        if (n > 1) offenders.push(`${file} 第 ${idx + 1} 段含 ${n} 条命令`);
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `以下迁移分片含多条命令，会以 42601 中断迁移：\n${offenders.join("\n")}`,
    );
  });

  it("能对空库跑完全量迁移并建出关键表", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zakura-migrations-"));
    try {
      const { runMigrations } = await import("../src/db/migrate.js");
      const { createDb } = await import("../src/db/client.js");
      const url = `pglite:${join(dir, "pglite")}`;

      await runMigrations(url);

      const { db, close } = await createDb({ databaseUrl: url, dataDir: dir });
      try {
        const res = await db.execute(
          `select table_name from information_schema.tables where table_schema = 'public'`,
        );
        const rows = (res as unknown as { rows?: Array<{ table_name: string }> })
          .rows ?? (res as unknown as Array<{ table_name: string }>);
        const tables = new Set(rows.map((r) => r.table_name));

        // 覆盖此前因缺分隔标记而整段没执行的迁移（0034 起）
        for (const table of [
          "store_catalog_entries",
          "upstream_oauth_clients",
          "connector_auth_profiles",
          "connector_settings",
          "agent_channel_bindings",
          "agent_channel_threads",
          "agent_channel_events",
          "email_connector_instances",
          "agent_connector_installations",
          "user_usage_events",
          "user_usage_daily",
        ]) {
          assert.ok(tables.has(table), `缺表 ${table}`);
        }

        const cols = await db.execute(
          `select table_name, column_name from information_schema.columns
           where (table_name = 'cloud_agent_sessions' and column_name = 'project')
              or (table_name = 'agent_schedules' and column_name = 'project')
              or (table_name = 'users' and column_name = 'suspended_at')
              or (table_name = 'agent_channel_bindings' and column_name = 'config_enc')`,
        );
        const colRows =
          (cols as unknown as { rows?: unknown[] }).rows ??
          (cols as unknown as unknown[]);
        assert.equal(colRows.length, 4, "0041/0044/0046 的列没有全部建出");
      } finally {
        await close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
