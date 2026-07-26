-- Model upstream connections + capability routes
CREATE TABLE IF NOT EXISTS "model_upstreams" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"protocol" text NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_upstreams" ADD CONSTRAINT "model_upstreams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_upstreams_tenant_slug" ON "model_upstreams" USING btree ("tenant_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_upstreams_tenant" ON "model_upstreams" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"capability" text NOT NULL,
	"upstream_id" text NOT NULL,
	"model" text NOT NULL,
	"options_json" text DEFAULT '{}' NOT NULL,
	"priority" text DEFAULT '100' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_upstream_id_model_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."model_upstreams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_routes_tenant_slug" ON "model_routes" USING btree ("tenant_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_routes_tenant" ON "model_routes" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_routes_capability" ON "model_routes" USING btree ("tenant_id","capability");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_routes_upstream" ON "model_routes" USING btree ("upstream_id");
