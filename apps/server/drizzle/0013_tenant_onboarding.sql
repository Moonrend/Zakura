-- 0013_tenant_onboarding
-- Per-tenant onboarding flag. Existing tenants are treated as already completed;
-- new tenants start incomplete (default false after this migration).

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "onboarding_completed" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "onboarding_completed" SET DEFAULT false;
