ALTER TABLE "component_instances" ADD COLUMN IF NOT EXISTS "runtime_node_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "component_instances" ADD CONSTRAINT "component_instances_runtime_node_id_runtime_nodes_id_fk"
    FOREIGN KEY ("runtime_node_id") REFERENCES "public"."runtime_nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instances_runtime_node" ON "component_instances" USING btree ("runtime_node_id");
