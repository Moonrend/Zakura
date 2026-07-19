CREATE TABLE IF NOT EXISTS "runtime_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'runner' NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"endpoint" text,
	"capabilities_json" text DEFAULT '{}' NOT NULL,
	"host_info_json" text DEFAULT '{}' NOT NULL,
	"storage_root" text NOT NULL,
	"agent_version" text,
	"last_seen_at" timestamp with time zone,
	"token_hash" text,
	"labels_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD CONSTRAINT "runtime_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_nodes_tenant_slug" ON "runtime_nodes" USING btree ("tenant_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_nodes_tenant" ON "runtime_nodes" USING btree ("tenant_id");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "runtime_node_id" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workspace_status" text DEFAULT 'ready' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workspace_revision" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "last_migration_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_node_id_runtime_nodes_id_fk" FOREIGN KEY ("runtime_node_id") REFERENCES "public"."runtime_nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"target_node_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"message" text,
	"manifest_json" text,
	"archive_path" text,
	"archive_size" text,
	"archive_sha256" text,
	"exclude_patterns_json" text DEFAULT '[]' NOT NULL,
	"source_retained" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_migrations" ADD CONSTRAINT "workspace_migrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_migrations" ADD CONSTRAINT "workspace_migrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_migrations" ADD CONSTRAINT "workspace_migrations_source_node_id_runtime_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."runtime_nodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_migrations" ADD CONSTRAINT "workspace_migrations_target_node_id_runtime_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."runtime_nodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_migrations_agent" ON "workspace_migrations" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_migrations_status" ON "workspace_migrations" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "managed_containers" ADD COLUMN IF NOT EXISTS "runtime_node_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "managed_containers" ADD CONSTRAINT "managed_containers_runtime_node_id_runtime_nodes_id_fk" FOREIGN KEY ("runtime_node_id") REFERENCES "public"."runtime_nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
