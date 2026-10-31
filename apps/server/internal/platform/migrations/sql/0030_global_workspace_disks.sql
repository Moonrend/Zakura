-- Managed directory disks are tenant storage: any Space may attach a released
-- disk. Only legacy-bind disks keep the Space whose directory they adopted.
UPDATE workspace_disks SET space_id='' WHERE locator_json NOT LIKE '%"legacy-bind"%';
UPDATE workspace_cleanup_tombstones SET space_id='' WHERE workspace_instance_id IS NULL AND disk_id IN (SELECT id FROM workspace_disks WHERE space_id='');
CREATE INDEX workspace_disks_tenant ON workspace_disks(tenant_id,state);
