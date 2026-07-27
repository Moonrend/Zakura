-- Host-level shared services (SearXNG / Jina Reader / Firecrawl / Crawl4AI)
CREATE TABLE IF NOT EXISTS "platform_services" (
	"id" text PRIMARY KEY NOT NULL,
	"service_key" text NOT NULL,
	"mode" text DEFAULT 'disabled' NOT NULL,
	"desired_state" text DEFAULT 'stopped' NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"config_enc" text DEFAULT '{}' NOT NULL,
	"endpoint_url" text,
	"containers_json" text DEFAULT '[]' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_services_key" ON "platform_services" USING btree ("service_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_service_quotas" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"service_key" text NOT NULL,
	"monthly_limit" integer,
	"daily_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_service_quotas_scope" ON "platform_service_quotas" USING btree ("scope_key","service_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_service_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"service_key" text NOT NULL,
	"period" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_service_usage" ADD CONSTRAINT "platform_service_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_service_usage_unique" ON "platform_service_usage" USING btree ("tenant_id","user_id","service_key","period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_service_usage_tenant_period" ON "platform_service_usage" USING btree ("tenant_id","period");
