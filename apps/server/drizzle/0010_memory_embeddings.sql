-- Built-in hybrid memory: pgvector semantic seeds (PGlite + Postgres)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding_model" text;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding_dim" integer;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "content_hash" text;
--> statement-breakpoint
-- Drop legacy JSON column if an earlier draft migration added it
ALTER TABLE "memories" DROP COLUMN IF EXISTS "embedding_json";
