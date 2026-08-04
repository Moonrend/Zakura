ALTER TABLE "component_instances" ADD COLUMN "last_health_check_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "component_instances" ADD COLUMN "next_health_check_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "component_instances" ADD COLUMN "health_failure_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "component_instances" ADD COLUMN "health_claim_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "instances_health_due" ON "component_instances" USING btree ("status","next_health_check_at");
