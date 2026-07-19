CREATE TABLE "agent_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"workspace_profile" text DEFAULT 'files' NOT NULL,
	"enable_fs" boolean DEFAULT true NOT NULL,
	"enable_shell" boolean DEFAULT false NOT NULL,
	"enable_computer" boolean DEFAULT false NOT NULL,
	"workspace_image" text,
	"config_json" text DEFAULT '{}' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "managed_containers" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bindings" ADD CONSTRAINT "agent_bindings_instance_id_component_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."component_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_bindings_unique" ON "agent_bindings" USING btree ("agent_id","instance_id");--> statement-breakpoint
CREATE INDEX "agent_bindings_agent" ON "agent_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_tenant_slug" ON "agents" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "agents_tenant" ON "agents" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_containers" ADD CONSTRAINT "managed_containers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "containers_agent" ON "managed_containers" USING btree ("agent_id");