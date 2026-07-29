-- 会话搜索的三元组索引。
--
-- searchSessions 对标题做 similarity() / word_similarity() / ILIKE '%…%'，
-- 三者都无法走 btree，没有 GIN 三元组索引就是全表扫；会话表只增不减，
-- 必须在部署期把索引建好，而不是等第一次搜索时惰性创建。
--
-- 扩展本身由 migrate.ts（远程 Postgres）和 pglite.ts（嵌入式）提前装好。
-- 这里再兜一次底，并在扩展确实不可用时跳过索引 —— 托管 Postgres 可能不提供
-- pg_trgm，那种情况下搜索会自动回退到纯 ILIKE，不该让整个迁移失败。
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm 不可用，会话搜索回退 ILIKE: %', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "cloud_agent_sessions_title_trgm_idx"
      ON "cloud_agent_sessions" USING gin ("title" gin_trgm_ops);
  END IF;
END $$;
