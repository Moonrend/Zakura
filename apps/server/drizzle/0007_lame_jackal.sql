CREATE TABLE "oauth_auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"scope" text DEFAULT 'mcp' NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_auth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"client_name" text DEFAULT '' NOT NULL,
	"redirect_uris_json" text DEFAULT '[]' NOT NULL,
	"grant_types_json" text DEFAULT '["authorization_code","refresh_token"]' NOT NULL,
	"response_types_json" text DEFAULT '["code"]' NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"scope" text DEFAULT 'mcp' NOT NULL,
	"registration_type" text DEFAULT 'dynamic' NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text,
	"scope" text DEFAULT 'mcp' NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_codes_client" ON "oauth_auth_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_tenant" ON "oauth_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_client" ON "oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_user" ON "oauth_refresh_tokens" USING btree ("user_id");