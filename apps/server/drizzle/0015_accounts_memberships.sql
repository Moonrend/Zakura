-- 0015_accounts_memberships
-- Global users + tenant memberships/invites. Supports multi-tenant & invites.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "onboarding_steps" text NOT NULL DEFAULT '{}';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_memberships" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_invites" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "token_hash" text NOT NULL,
  "invited_by_user_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Backfill memberships from legacy users.tenant_id / users.role
INSERT INTO "tenant_memberships" ("id", "tenant_id", "user_id", "role", "status", "created_at", "updated_at")
SELECT
  'mig_' || u."id",
  u."tenant_id",
  u."id",
  CASE WHEN u."role" IN ('owner', 'admin', 'member') THEN u."role" ELSE 'admin' END,
  'active',
  COALESCE(u."created_at", now()),
  COALESCE(u."updated_at", now())
FROM "users" u
WHERE u."tenant_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "tenant_memberships" m
    WHERE m."tenant_id" = u."tenant_id" AND m."user_id" = u."id"
  );
--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_platform_admin" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- First admin on the default tenant becomes platform super-admin
UPDATE "users" u
SET "is_platform_admin" = true
FROM "tenant_memberships" m
JOIN "tenants" t ON t."id" = m."tenant_id"
WHERE u."id" = m."user_id"
  AND t."is_default" = true
  AND m."role" IN ('owner', 'admin')
  AND u."id" = (
    SELECT m2."user_id"
    FROM "tenant_memberships" m2
    JOIN "tenants" t2 ON t2."id" = m2."tenant_id"
    WHERE t2."is_default" = true AND m2."role" IN ('owner', 'admin')
    ORDER BY m2."created_at" ASC
    LIMIT 1
  );
--> statement-breakpoint

-- Collapse duplicate emails: keep oldest user, remount memberships, drop extras
DO $$
DECLARE
  r RECORD;
  keep_id text;
  dup_id text;
BEGIN
  FOR r IN
    SELECT lower(email) AS em
    FROM users
    GROUP BY lower(email)
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO keep_id FROM users WHERE lower(email) = r.em ORDER BY created_at ASC LIMIT 1;
    FOR dup_id IN
      SELECT id FROM users WHERE lower(email) = r.em AND id <> keep_id
    LOOP
      UPDATE tenant_memberships SET user_id = keep_id
        WHERE user_id = dup_id
          AND NOT EXISTS (
            SELECT 1 FROM tenant_memberships x
            WHERE x.user_id = keep_id AND x.tenant_id = tenant_memberships.tenant_id
          );
      DELETE FROM tenant_memberships WHERE user_id = dup_id;
      UPDATE oauth_auth_codes SET user_id = keep_id WHERE user_id = dup_id;
      UPDATE oauth_refresh_tokens SET user_id = keep_id WHERE user_id = dup_id;
      DELETE FROM users WHERE id = dup_id;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

-- Drop legacy tenant binding on users (if present)
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_tenant_id_tenants_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "users_tenant_email";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tenant_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "users_email" ON "users" ("email");
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "tenant_memberships"
    ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tenant_memberships"
    ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_memberships_unique" ON "tenant_memberships" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_user" ON "tenant_memberships" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_tenant" ON "tenant_memberships" ("tenant_id");
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "tenant_invites"
    ADD CONSTRAINT "tenant_invites_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tenant_invites"
    ADD CONSTRAINT "tenant_invites_invited_by_user_id_users_id_fk"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_invites_token" ON "tenant_invites" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_invites_tenant_email" ON "tenant_invites" ("tenant_id", "email");
