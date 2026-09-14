-- 0053 converted the implicit server-local node to computer, but it has no Go
-- token/session. Preserve IDs and bindings when restoring its original kind.
UPDATE "runtime_nodes"
SET "kind" = 'local',
    "status" = CASE WHEN "status" = 'draining' THEN 'draining' ELSE 'online' END,
    "is_shared" = false, "updated_at" = now()
WHERE "kind" = 'computer' AND "slug" = 'local' AND "token_hash" IS NULL;
