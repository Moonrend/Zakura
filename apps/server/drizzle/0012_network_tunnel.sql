-- 0012_network_tunnel
-- Network mesh integrations, tunnel providers, security policies, port exposures, audit logs

CREATE TABLE IF NOT EXISTS "network_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"display_name" text,
	"credentials_enc" text DEFAULT '{}' NOT NULL,
	"meta_json" text DEFAULT '{}' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "network_integrations" ADD CONSTRAINT "network_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "network_integrations_tenant_kind" ON "network_integrations" USING btree ("tenant_id","kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_integrations_tenant" ON "network_integrations" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tunnel_provider_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config_enc" text DEFAULT '{}' NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tunnel_provider_settings" ADD CONSTRAINT "tunnel_provider_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tunnel_provider_settings_tenant_provider" ON "tunnel_provider_settings" USING btree ("tenant_id","provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tunnel_provider_settings_tenant" ON "tunnel_provider_settings" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_security_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"scope" text DEFAULT 'tenant' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"exposure_enabled" boolean DEFAULT true NOT NULL,
	"default_ttl_minutes" integer DEFAULT 60 NOT NULL,
	"max_ttl_minutes" integer DEFAULT 1440 NOT NULL,
	"max_active_per_agent" integer DEFAULT 3 NOT NULL,
	"max_active_per_tenant" integer DEFAULT 50 NOT NULL,
	"denied_ports_json" text DEFAULT '[22,2375,2376,5432,6379,27017,5900,6080,9222,8787,7443]' NOT NULL,
	"allow_desktop_exposure" boolean DEFAULT false NOT NULL,
	"allow_public_exposure" boolean DEFAULT true NOT NULL,
	"allow_tcp_exposure" boolean DEFAULT false NOT NULL,
	"agents_can_expose" boolean DEFAULT true NOT NULL,
	"require_user_approval" boolean DEFAULT false NOT NULL,
	"require_tailscale_for_remote_runners" boolean DEFAULT false NOT NULL,
	"audit_retention_days" integer DEFAULT 90 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "network_security_policies" ADD CONSTRAINT "network_security_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "network_security_policies_tenant_scope" ON "network_security_policies" USING btree ("tenant_id","scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_security_policies_tenant" ON "network_security_policies" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "port_exposures" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runtime_node_id" text,
	"name" text,
	"port" integer NOT NULL,
	"protocol" text DEFAULT 'http' NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"public_url" text,
	"relay_host" text,
	"relay_port" integer,
	"integration_id" text,
	"ttl_minutes" integer,
	"expires_at" timestamp with time zone,
	"last_error" text,
	"created_by_type" text,
	"created_by_id" text,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "port_exposures" ADD CONSTRAINT "port_exposures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "port_exposures" ADD CONSTRAINT "port_exposures_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "port_exposures" ADD CONSTRAINT "port_exposures_runtime_node_id_runtime_nodes_id_fk" FOREIGN KEY ("runtime_node_id") REFERENCES "public"."runtime_nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "port_exposures" ADD CONSTRAINT "port_exposures_integration_id_network_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."network_integrations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "port_exposures_tenant" ON "port_exposures" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "port_exposures_agent" ON "port_exposures" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "port_exposures_status" ON "port_exposures" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "port_exposures_expires" ON "port_exposures" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail_json" text DEFAULT '{}' NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_audit_tenant_time" ON "network_audit_logs" USING btree ("tenant_id","created_at");
