-- 账户企业扩展：会话、令牌、MFA、域名、SSO、SCIM、合规审计
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text,
  "kind" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "meta_json" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_tokens_hash" ON "auth_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_tokens_user_kind" ON "auth_tokens" ("user_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_tokens_expires" ON "auth_tokens" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "is_platform_admin" boolean DEFAULT false NOT NULL,
  "user_agent" text,
  "ip" text,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_user" ON "user_sessions" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_expires" ON "user_sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_totp" (
  "user_id" text PRIMARY KEY NOT NULL,
  "secret_enc" text NOT NULL,
  "enabled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_recovery_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_recovery_codes_user" ON "user_recovery_codes" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_webauthn_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  "counter" integer DEFAULT 0 NOT NULL,
  "name" text,
  "transports_json" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_webauthn_credential_id" ON "user_webauthn_credentials" ("credential_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_webauthn_user" ON "user_webauthn_credentials" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_domains" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "domain" text NOT NULL,
  "txt_token" text NOT NULL,
  "verified_at" timestamp with time zone,
  "join_mode" text DEFAULT 'invite_only' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_domains_domain" ON "tenant_domains" ("domain");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_domains_tenant" ON "tenant_domains" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_sso_configs" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "protocol" text DEFAULT 'oidc' NOT NULL,
  "issuer" text,
  "client_id" text,
  "client_secret_enc" text,
  "authorize_url" text,
  "token_url" text,
  "jwks_url" text,
  "userinfo_url" text,
  "scopes" text DEFAULT 'openid email profile' NOT NULL,
  "idp_entity_id" text,
  "idp_sso_url" text,
  "idp_certificate_enc" text,
  "jit_enabled" boolean DEFAULT true NOT NULL,
  "enforce_sso" boolean DEFAULT false NOT NULL,
  "default_role" text DEFAULT 'member' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_sso_configs_tenant" ON "tenant_sso_configs" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sso_login_states" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "protocol" text NOT NULL,
  "code_verifier" text,
  "nonce" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_login_states_expires" ON "sso_login_states" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_scim_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "name" text DEFAULT 'SCIM' NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "group_role_map" text DEFAULT '{}' NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_scim_tokens_hash" ON "tenant_scim_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_scim_tokens_tenant" ON "tenant_scim_tokens" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_user_mappings" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "user_id" text NOT NULL,
  "external_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_user_mappings_ext" ON "scim_user_mappings" ("tenant_id", "external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_user_mappings_user" ON "scim_user_mappings" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_audit_logs" (
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
CREATE INDEX IF NOT EXISTS "security_audit_tenant_time" ON "security_audit_logs" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_audit_action" ON "security_audit_logs" ("tenant_id", "action");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_webauthn_credentials" ADD CONSTRAINT "user_webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_sso_configs" ADD CONSTRAINT "tenant_sso_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sso_login_states" ADD CONSTRAINT "sso_login_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_scim_tokens" ADD CONSTRAINT "tenant_scim_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_user_mappings" ADD CONSTRAINT "scim_user_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_user_mappings" ADD CONSTRAINT "scim_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
