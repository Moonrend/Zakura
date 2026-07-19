-- 0014_tenant_isolation_hardening
-- Add tenant_id to agent_bindings; FK on network_audit_logs.tenant_id

ALTER TABLE "agent_bindings" ADD COLUMN IF NOT EXISTS "tenant_id" text;
--> statement-breakpoint
UPDATE "agent_bindings" ab
SET "tenant_id" = a."tenant_id"
FROM "agents" a
WHERE ab."agent_id" = a."id" AND ab."tenant_id" IS NULL;
--> statement-breakpoint
DELETE FROM "agent_bindings" WHERE "tenant_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_bindings" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_bindings"
    ADD CONSTRAINT "agent_bindings_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_bindings_tenant" ON "agent_bindings" ("tenant_id");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "network_audit_logs"
    ADD CONSTRAINT "network_audit_logs_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
