CREATE TABLE "integration_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"publisher" text DEFAULT 'Zakura' NOT NULL,
	"category" text DEFAULT 'productivity' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"accent" text DEFAULT '#64748b' NOT NULL,
	"homepage" text,
	"verified" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"manifest_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_packages_slug" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "integration_components" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_components_package_ref" UNIQUE("package_id","kind","ref")
);
--> statement-breakpoint
CREATE TABLE "connector_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"connector_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"credential_kind" text NOT NULL,
	"config_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_credentials_scope_connector" UNIQUE("scope_key","connector_id")
);
--> statement-breakpoint
ALTER TABLE "integration_components" ADD CONSTRAINT "integration_components_package_id_integration_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."integration_packages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_connector_id_integration_components_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."integration_components"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "integration_components_kind_ref" ON "integration_components" USING btree ("kind","ref");
--> statement-breakpoint
CREATE INDEX "connector_credentials_scope" ON "connector_credentials" USING btree ("scope_key");
