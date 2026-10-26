-- Computer rows are referenced by selections, Run pins, runtimes and jobs whose
-- foreign keys have no ON DELETE action, so deleting a Space, a tenant or a chat
-- failed once any of them existed. Rebuilding those tables is unsafe with
-- foreign keys enforced, so dependents are released by triggers instead; they
-- also fire for rows removed by ON DELETE CASCADE from spaces and tenants.
CREATE TRIGGER IF NOT EXISTS computers_release_dependents BEFORE DELETE ON computers
BEGIN
 DELETE FROM session_computer_defaults WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM space_computer_defaults WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM run_computer_targets WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM computer_execution_targets WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM computer_project_workspaces WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM computer_creation_approvals WHERE runtime_id IN (SELECT id FROM computer_runtimes WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id);
 DELETE FROM computer_runtimes WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
END;
-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS cloud_agent_runs_release_computer_jobs BEFORE DELETE ON cloud_agent_runs
BEGIN
 DELETE FROM computer_execution_targets WHERE run_id=OLD.id;
END;
