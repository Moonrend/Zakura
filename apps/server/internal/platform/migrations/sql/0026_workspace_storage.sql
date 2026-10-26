ALTER TABLE spaces ADD COLUMN current_workspace_instance_id TEXT;
ALTER TABLE spaces ADD COLUMN workspace_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE runtime_nodes ADD COLUMN incarnation TEXT NOT NULL DEFAULT '';
ALTER TABLE computer_workspace_leases ADD COLUMN workspace_instance_id TEXT;
ALTER TABLE computer_workspace_leases ADD COLUMN workspace_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE managed_containers ADD COLUMN workspace_instance_id TEXT;
ALTER TABLE workspace_connections ADD COLUMN workspace_instance_id TEXT;
ALTER TABLE run_computer_targets ADD COLUMN workspace_instance_id TEXT;
ALTER TABLE run_computer_targets ADD COLUMN workspace_generation BIGINT NOT NULL DEFAULT 0;
-- statement-breakpoint
-- Storage and cleanup identities outlive their owners. Deleting a Space, node or
-- computer must not cascade away the evidence needed to release remote writers.
CREATE TABLE workspace_disks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_incarnation TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    locator_version BIGINT NOT NULL DEFAULT 1,
    locator_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','available','attached','release_pending','delete_pending','deleted','unknown')),
    attached_instance_id TEXT,
    used_bytes BIGINT,
    sampled_at TEXT,
    verified_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(node_id,node_incarnation,locator_key)
);
CREATE INDEX workspace_disks_space ON workspace_disks(tenant_id,space_id,state);
CREATE UNIQUE INDEX workspace_disks_attachment ON workspace_disks(attached_instance_id) WHERE attached_instance_id IS NOT NULL;
-- statement-breakpoint
CREATE TABLE workspace_instances (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    computer_id TEXT NOT NULL,
    generation BIGINT NOT NULL,
    node_id TEXT NOT NULL,
    node_incarnation TEXT NOT NULL,
    disk_id TEXT NOT NULL,
    locator_version BIGINT NOT NULL,
    config_json TEXT NOT NULL,
    identity_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','creating','running','stopped','unknown','revoked','releasing','released')),
    docker_id TEXT,
    create_operation_id TEXT,
    revoked_at TEXT,
    released_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id,space_id,generation)
);
CREATE INDEX workspace_instances_disk ON workspace_instances(disk_id,state);
CREATE INDEX workspace_instances_node ON workspace_instances(node_id,node_incarnation,state);
-- statement-breakpoint
CREATE TABLE workspace_cleanup_tombstones (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    workspace_instance_id TEXT,
    disk_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_incarnation TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    delete_disk BOOLEAN NOT NULL DEFAULT FALSE,
    phase TEXT NOT NULL DEFAULT 'queued',
    pending BOOLEAN NOT NULL DEFAULT TRUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt BIGINT NOT NULL,
    token TEXT NOT NULL DEFAULT '',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(tenant_id,space_id,request_id)
);
CREATE INDEX workspace_cleanup_tombstones_due ON workspace_cleanup_tombstones(pending,next_attempt);
CREATE INDEX workspace_cleanup_tombstones_instance ON workspace_cleanup_tombstones(workspace_instance_id,pending);
-- statement-breakpoint
CREATE TABLE workspace_disk_projects (
    tenant_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    disk_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    verified_at TEXT,
    PRIMARY KEY(disk_id,project_id)
);
-- statement-breakpoint
ALTER TABLE workspace_create_operations RENAME TO workspace_create_operations_v1;
CREATE TABLE workspace_create_operations (
    operation_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    computer_id TEXT NOT NULL,
    workspace_instance_id TEXT,
    identity_version INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    config_digest TEXT,
    created_at TEXT NOT NULL
);
INSERT INTO workspace_create_operations(operation_id,space_id,tenant_id,node_id,computer_id,name,config_digest,created_at)
SELECT operation_id,space_id,tenant_id,node_id,computer_id,name,config_digest,created_at FROM workspace_create_operations_v1;
DROP TABLE workspace_create_operations_v1;
CREATE UNIQUE INDEX workspace_create_operations_instance ON workspace_create_operations(workspace_instance_id) WHERE workspace_instance_id IS NOT NULL;
-- Compatibility callers retain their original one-operation-per-node behavior
-- until they have explicitly adopted an instance; new generations use its ID.
CREATE UNIQUE INDEX workspace_create_operations_legacy ON workspace_create_operations(space_id,node_id) WHERE workspace_instance_id IS NULL;
CREATE INDEX workspace_create_operations_space ON workspace_create_operations(tenant_id,space_id,node_id);
