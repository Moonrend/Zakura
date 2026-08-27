-- 连接器凭据从「按 connector 组件 id」改为「按命名档案」。
-- 多个连接器可引用同一个 profile_key 共享一份客户端；管理员也可预配目录里
-- 尚不存在的名字，供后续连接器或上游 MCP 引用。
CREATE TABLE IF NOT EXISTS "connector_auth_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "scope_key" text NOT NULL,
  "profile_key" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "kind" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "config_enc" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_auth_profiles_scope_profile"
  ON "connector_auth_profiles" ("scope_key", "profile_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_auth_profiles_scope"
  ON "connector_auth_profiles" ("scope_key");
--> statement-breakpoint
-- 连接器自身设置（如自建实例地址）。与档案分开：这些值不应随共享客户端传播。
CREATE TABLE IF NOT EXISTS "connector_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "scope_key" text NOT NULL,
  "connector_ref" text NOT NULL,
  "config_enc" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_settings_scope_ref"
  ON "connector_settings" ("scope_key", "connector_ref");
--> statement-breakpoint
-- 回填：旧凭据按 connector.ref 迁到同名档案。config_enc 用同一 app secret 加密，可整体搬运。
-- connector_credentials 可能早已被删（新装库不会有），所以整段放进 DO 块里按存在性判断。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'connector_credentials'
  ) THEN
    INSERT INTO "connector_auth_profiles"
      ("id", "scope_key", "profile_key", "label", "kind", "enabled", "config_enc", "created_at", "updated_at")
    SELECT
      cc."id",
      cc."scope_key",
      ic."ref",
      ic."name",
      CASE cc."credential_kind"
        WHEN 'oauth2_client' THEN 'oauth2'
        WHEN 'oauth2_dynamic' THEN 'oauth2_dynamic'
        WHEN 'api_key' THEN 'token'
        WHEN 'token' THEN 'token'
        WHEN 'none' THEN 'none'
        ELSE 'custom'
      END,
      cc."enabled",
      cc."config_enc",
      cc."created_at",
      cc."updated_at"
    FROM "connector_credentials" cc
    JOIN "integration_components" ic ON ic."id" = cc."connector_id"
    ON CONFLICT ("scope_key", "profile_key") DO NOTHING;

    DROP TABLE IF EXISTS "connector_credentials";
  END IF;
END $$;
