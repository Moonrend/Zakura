CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"instance_id" text,
	"user_id" text,
	"agent_id" text,
	"content" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_instance_id_component_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."component_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_tenant_user" ON "memories" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memories_tenant_agent" ON "memories" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX "memories_instance" ON "memories" USING btree ("instance_id");