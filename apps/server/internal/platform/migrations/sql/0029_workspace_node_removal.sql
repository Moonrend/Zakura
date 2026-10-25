-- A removed node ends synchronization, without claiming remote data was erased.
ALTER TABLE workspace_disks ADD COLUMN node_removed_at TEXT;
