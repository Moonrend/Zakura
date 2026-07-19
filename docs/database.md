# 数据库（Drizzle · 一套 schema · 两种运行时）

Zakura 使用 **Drizzle ORM + 单一 PostgreSQL 方言 schema**。

| 运行时 | 何时用 | `DATABASE_URL` |
|--------|--------|----------------|
| **PGlite**（默认） | 自托管 / 本地开发，零外部依赖 | `pglite:./data/pglite` 或不设（自动） |
| **Postgres** | 云端多租户 / 托管库 | `postgresql://user:pass@host:5432/zakura` |

**只维护一份** `apps/server/src/db/schema.ts` 和一份 `drizzle/` 迁移；运行时按 URL 选驱动，不改 schema、不维护双文件。

## 本地开发（默认 PGlite）

```bash
pnpm setup    # install + generate + migrate
pnpm dev
```

`apps/server/.env` 可留空或：

```env
DATABASE_URL=pglite:../../data/pglite
```

## 切到 Postgres

```bash
pnpm db:up    # docker compose --profile postgres up -d postgres
```

```env
DATABASE_URL=postgresql://zakura:zakura@127.0.0.1:5432/zakura
```

```bash
pnpm db:migrate
```

云端（Neon / RDS / Supabase）同理，只改连接串。

## 命令

| 命令 | 作用 |
|------|------|
| `pnpm db:generate` | 根据 schema 生成 SQL 迁移（dialect=postgresql） |
| `pnpm db:migrate` | 对当前 `DATABASE_URL` 应用迁移（PGlite 或 Postgres） |

## 为何不用 Prisma 双 provider

Prisma 的 `provider` 写死在 schema 里，SQLite/PG 双后端通常要两套 schema 或改写脚本。Drizzle 用同一套 PG SQL + PGlite/Postgres 双驱动，自托管仍可「一个数据目录搞定」。
