CREATE INDEX IF NOT EXISTS cloud_agent_events_session_type_seq ON cloud_agent_events(session_id, type, seq);
CREATE INDEX IF NOT EXISTS cloud_agent_events_session_run_type_seq ON cloud_agent_events(session_id, run_id, type, seq);
