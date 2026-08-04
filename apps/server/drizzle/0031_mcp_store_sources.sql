CREATE TABLE "mcp_store_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text NOT NULL,
	"format" text DEFAULT 'auto' NOT NULL,
	"manifest_json" text DEFAULT '{}' NOT NULL,
	"servers_json" text DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_store_sources" ADD CONSTRAINT "mcp_store_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_store_sources_tenant_url" ON "mcp_store_sources" USING btree ("tenant_id","source_url");
--> statement-breakpoint
CREATE INDEX "mcp_store_sources_tenant" ON "mcp_store_sources" USING btree ("tenant_id");
