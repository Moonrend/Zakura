CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text DEFAULT '["*"]' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "component_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"config_enc" text NOT NULL,
	"endpoint_url" text,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_containers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"instance_id" text,
	"docker_id" text,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"purpose" text DEFAULT 'component' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"labels_json" text DEFAULT '{}' NOT NULL,
	"ports_json" text DEFAULT '[]' NOT NULL,
	"env_enc" text,
	"allocated_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"api_key_id" text,
	"instance_ids" text DEFAULT '[]' NOT NULL,
	"tool_allowlist" text,
	"tool_denylist" text,
	"include_builtin" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_meta" (
	"id" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
	"setup_completed" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'single-tenant' NOT NULL,
	"version" text DEFAULT '0.1.0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"capabilities" text DEFAULT '[]' NOT NULL,
	"config_schema" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_key" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_provider_id_provider_catalog_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_containers" ADD CONSTRAINT "managed_containers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_containers" ADD CONSTRAINT "managed_containers_instance_id_component_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."component_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_policies" ADD CONSTRAINT "mcp_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_policies" ADD CONSTRAINT "mcp_policies_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instances_tenant_slug" ON "component_instances" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "instances_tenant_provider" ON "component_instances" USING btree ("tenant_id","provider_id");--> statement-breakpoint
CREATE INDEX "containers_tenant_purpose" ON "managed_containers" USING btree ("tenant_id","purpose");--> statement-breakpoint
CREATE INDEX "containers_docker_id" ON "managed_containers" USING btree ("docker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_owner_key" ON "settings" USING btree ("owner_key","key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email" ON "users" USING btree ("tenant_id","email");