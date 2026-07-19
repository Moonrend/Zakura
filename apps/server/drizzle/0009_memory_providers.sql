-- Multi memory providers + graph edges + agent binding
CREATE TABLE IF NOT EXISTS "memory_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_providers" ADD CONSTRAINT "memory_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_providers_tenant_slug" ON "memory_providers" USING btree ("tenant_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_providers_tenant" ON "memory_providers" USING btree ("tenant_id");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "memory_provider_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_memory_provider_id_memory_providers_id_fk" FOREIGN KEY ("memory_provider_id") REFERENCES "public"."memory_providers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "provider_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memories" ADD CONSTRAINT "memories_provider_id_memory_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."memory_providers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_provider" ON "memories" USING btree ("provider_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text,
	"from_memory_id" text NOT NULL,
	"to_memory_id" text NOT NULL,
	"relation" text DEFAULT 'related' NOT NULL,
	"weight" text DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_from_memory_id_memories_id_fk" FOREIGN KEY ("from_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_to_memory_id_memories_id_fk" FOREIGN KEY ("to_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_edges_agent" ON "memory_edges" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_edges_from" ON "memory_edges" USING btree ("from_memory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_edges_to" ON "memory_edges" USING btree ("to_memory_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_edges_pair_rel" ON "memory_edges" USING btree ("from_memory_id","to_memory_id","relation");
