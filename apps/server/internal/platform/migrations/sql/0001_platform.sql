CREATE TABLE IF NOT EXISTS platform_meta (
  singleton INTEGER PRIMARY KEY,
  setup_completed INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT 'go-rewrite',
  mode TEXT NOT NULL DEFAULT 'local',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT,
  title TEXT,
  bio TEXT,
  avatar_mime TEXT,
  avatar_data BLOB,
  avatar_updated_at TEXT,
  email_verified_at TEXT,
  totp_secret TEXT,
  totp_pending_secret TEXT,
  totp_enabled_at TEXT,
  recovery_codes_json TEXT NOT NULL DEFAULT '[]',
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  can_use_local_runner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  suspended_at TEXT,
  suspended_reason TEXT,
  suspended_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  onboarding_steps TEXT NOT NULL DEFAULT '{}',
  mfa_policy TEXT NOT NULL DEFAULT 'optional',
  audit_retention_days INTEGER NOT NULL DEFAULT 365,
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  suspended_at TEXT,
  suspended_reason TEXT,
  suspended_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS tenant_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,user_id)
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS tenant_memberships_user_idx ON tenant_memberships(user_id,status);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  ip TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id,revoked_at,expires_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS tenant_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  meta_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS tenant_domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  join_mode TEXT NOT NULL DEFAULT 'invite_only',
  verification_token TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS tenant_sso_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  issuer TEXT,
  client_id TEXT,
  client_secret_enc TEXT,
  authorize_url TEXT,
  token_url TEXT,
  jwks_url TEXT,
  userinfo_url TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid email profile',
  idp_entity_id TEXT,
  idp_sso_url TEXT,
  idp_certificate_enc TEXT,
  jit_enabled INTEGER NOT NULL DEFAULT 1,
  enforce_sso INTEGER NOT NULL DEFAULT 0,
  default_role TEXT NOT NULL DEFAULT 'member',
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS tenant_scim_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  group_role_map TEXT NOT NULL DEFAULT '{}',
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS user_webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS security_audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  ip TEXT,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS security_audit_tenant_idx ON security_audit_logs(tenant_id,created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  agent_id TEXT,
  space_id TEXT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["*"]',
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL DEFAULT '',
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  response_types_json TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'mcp',
  registration_type TEXT NOT NULL DEFAULT 'dynamic',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id TEXT,
  scope TEXT NOT NULL,
  resource TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  replaced_by TEXT,
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_refresh_family_idx ON oauth_refresh_tokens(family_id,revoked_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS user_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  units INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(owner_key,key)
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_login_failures (
  key_hash TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
