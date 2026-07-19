-- Agent defaults: capabilities opt-in; status column unused for lifecycle
ALTER TABLE "agents" ALTER COLUMN "enable_fs" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "enable_memory" SET DEFAULT false;
