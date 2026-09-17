ALTER TABLE "zakurabot_devices" ADD COLUMN "refresh_token_hash" text;
--> statement-breakpoint
ALTER TABLE "zakurabot_devices" ADD COLUMN "refresh_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "zakurabot_authorizations" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "user_code_hash" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "device_id" text REFERENCES "zakurabot_devices"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL
);
