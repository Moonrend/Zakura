ALTER TABLE "agents" ADD COLUMN "enable_memory" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "layer" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "tags_json" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "importance" text DEFAULT '3' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_agent_layer" ON "memories" USING btree ("agent_id","layer");