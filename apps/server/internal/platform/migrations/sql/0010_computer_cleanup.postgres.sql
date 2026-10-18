-- PostgreSQL form of 0010_computer_cleanup.sql. Row triggers also fire for rows
-- removed by ON DELETE CASCADE, and the NO ACTION checks they satisfy run at
-- the end of the deleting statement.
CREATE OR REPLACE FUNCTION zakura_computers_release_dependents() RETURNS trigger AS $$
BEGIN
 DELETE FROM session_computer_defaults WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM space_computer_defaults WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM run_computer_targets WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM computer_execution_targets WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM computer_project_workspaces WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 DELETE FROM computer_creation_approvals WHERE runtime_id IN (SELECT id FROM computer_runtimes WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id);
 DELETE FROM computer_runtimes WHERE tenant_id=OLD.tenant_id AND space_id=OLD.space_id AND computer_id=OLD.id;
 RETURN OLD;
END
$$ LANGUAGE plpgsql;
-- statement-breakpoint
DROP TRIGGER IF EXISTS computers_release_dependents ON computers;
-- statement-breakpoint
CREATE TRIGGER computers_release_dependents BEFORE DELETE ON computers FOR EACH ROW EXECUTE PROCEDURE zakura_computers_release_dependents();
-- statement-breakpoint
CREATE OR REPLACE FUNCTION zakura_runs_release_computer_jobs() RETURNS trigger AS $$
BEGIN
 DELETE FROM computer_execution_targets WHERE run_id=OLD.id;
 RETURN OLD;
END
$$ LANGUAGE plpgsql;
-- statement-breakpoint
DROP TRIGGER IF EXISTS cloud_agent_runs_release_computer_jobs ON cloud_agent_runs;
-- statement-breakpoint
CREATE TRIGGER cloud_agent_runs_release_computer_jobs BEFORE DELETE ON cloud_agent_runs FOR EACH ROW EXECUTE PROCEDURE zakura_runs_release_computer_jobs();
