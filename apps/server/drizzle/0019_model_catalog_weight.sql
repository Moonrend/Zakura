-- Model routes: alias + weight; catalog cache
ALTER TABLE "model_routes" ADD COLUMN IF NOT EXISTS "alias" text;
--> statement-breakpoint
ALTER TABLE "model_routes" ADD COLUMN IF NOT EXISTS "weight" text DEFAULT '100' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_routes_alias" ON "model_routes" USING btree ("tenant_id","capability","alias");
--> statement-breakpoint
UPDATE "model_routes" SET "alias" = "model" WHERE "alias" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_catalog_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_name" text NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"meta_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_catalog_entries" ADD CONSTRAINT "model_catalog_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_catalog_unique" ON "model_catalog_entries" USING btree ("tenant_id","source","provider_id","model_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_catalog_tenant" ON "model_catalog_entries" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_catalog_provider" ON "model_catalog_entries" USING btree ("tenant_id","provider_id");
