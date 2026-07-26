-- 上游模型库存：每个上游的模型单独记录；canonical 用于聚合调度，native 用于实际调用
CREATE TABLE IF NOT EXISTS "upstream_models" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"upstream_id" text NOT NULL,
	"native_model" text NOT NULL,
	"canonical_model" text NOT NULL,
	"display_name" text,
	"capability" text NOT NULL,
	"weight" text DEFAULT '100' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"options_json" text DEFAULT '{}' NOT NULL,
	"meta_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"last_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_upstream_id_model_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."model_upstreams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upstream_models_unique" ON "upstream_models" USING btree ("tenant_id","upstream_id","native_model","capability");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_models_tenant" ON "upstream_models" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_models_canonical" ON "upstream_models" USING btree ("tenant_id","capability","canonical_model");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_models_upstream" ON "upstream_models" USING btree ("upstream_id");
