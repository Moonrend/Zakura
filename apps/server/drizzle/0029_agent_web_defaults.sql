-- Agent web tool defaults are stored in settings(owner_key='platform', key='agents.web-defaults').
-- No new table is required; this migration documents the reserved setting key for deployments.
INSERT INTO "settings" ("id", "owner_key", "key", "value")
VALUES ('agent-web-defaults', 'platform', 'agents.web-defaults', '{"webSearchEnabled":true,"webFetchEnabled":true,"searchEngine":null,"fetchBackend":null,"autoManagedServices":[]}')
ON CONFLICT ("owner_key", "key") DO NOTHING;
