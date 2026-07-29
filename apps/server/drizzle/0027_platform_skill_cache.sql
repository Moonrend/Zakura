-- 平台级技能缓存：跨租户共享一份仓库内容，安装时只做版本检查
CREATE TABLE IF NOT EXISTS "platform_skill_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_key" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"source_json" text DEFAULT '{}' NOT NULL,
	"ref" text,
	"version" text,
	"upstream_etag" text,
	"packages_json" text DEFAULT '[]' NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"skill_count" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"warnings_json" text DEFAULT '[]' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ref_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_skill_repos_key" ON "platform_skill_repos" ("repo_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skill_repos_checked" ON "platform_skill_repos" ("checked_at");--> statement-breakpoint

-- 技能来源令牌：scope_key = 'platform' 或 tenant_id，值加密存储
CREATE TABLE IF NOT EXISTS "skill_source_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"token_enc" text NOT NULL,
	"label" text,
	"hint" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_source_tokens_scope" ON "skill_source_tokens" ("scope_key","provider");--> statement-breakpoint

-- 租户技能记录指回共享缓存，便于判断"有没有新版本"
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "repo_key" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_repo_key" ON "skills" ("repo_key");
