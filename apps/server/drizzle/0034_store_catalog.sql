-- 商店目录索引：只存名称/描述供 pg_trgm 模糊搜索，不缓存完整内容（git 仓库仍走原缓存）。
-- tenant_id NULL = 平台内置；非空 = 租户自定义市场条目。

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm 不可用，商店搜索回退 ILIKE: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS "store_catalog_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "source_id" text NOT NULL,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "meta_json" text NOT NULL DEFAULT '{}',
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "store_catalog_source_ref"
  ON "store_catalog_entries" ("source_id", "ref", (COALESCE("tenant_id", '')));

CREATE INDEX IF NOT EXISTS "store_catalog_tenant" ON "store_catalog_entries" ("tenant_id");
CREATE INDEX IF NOT EXISTS "store_catalog_source" ON "store_catalog_entries" ("source_id");
CREATE INDEX IF NOT EXISTS "store_catalog_kind" ON "store_catalog_entries" ("kind");

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "store_catalog_name_trgm_idx"
      ON "store_catalog_entries" USING gin ("name" gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS "store_catalog_desc_trgm_idx"
      ON "store_catalog_entries" USING gin ("description" gin_trgm_ops);
  END IF;
END $$;
