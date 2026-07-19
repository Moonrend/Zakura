CREATE TABLE "tool_call_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"api_key_id" text,
	"agent_id" text,
	"qualified_name" text NOT NULL,
	"local_name" text NOT NULL,
	"provider_id" text DEFAULT '' NOT NULL,
	"instance_id" text,
	"args_json" text DEFAULT '{}' NOT NULL,
	"result_json" text DEFAULT '' NOT NULL,
	"is_error" boolean DEFAULT false NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_calls_tenant_created" ON "tool_call_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_agent_created" ON "tool_call_logs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_api_key_created" ON "tool_call_logs" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_qualified" ON "tool_call_logs" USING btree ("tenant_id","qualified_name");