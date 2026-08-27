CREATE TABLE IF NOT EXISTS "upstream_oauth_clients" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "mcp_url" text NOT NULL,
  "host" text NOT NULL,
  "client_id" text NOT NULL,
  "secret_enc" text,
  "client_name" text DEFAULT '' NOT NULL,
  "source" text NOT NULL,
  "registration_endpoint" text,
  "scope" text DEFAULT '' NOT NULL,
  "instance_id" text REFERENCES "component_instances"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upstream_oauth_clients_tenant_host_client"
  ON "upstream_oauth_clients" ("tenant_id", "host", "client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_oauth_clients_tenant"
  ON "upstream_oauth_clients" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_oauth_clients_source"
  ON "upstream_oauth_clients" ("source");
