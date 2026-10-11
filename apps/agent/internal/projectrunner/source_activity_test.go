package projectrunner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func activityIDs(t *testing.T, m *Manager) []string {
	t.Helper()
	result := rpcResult(t, m, "project.source.activities", scoped(nil))
	var records []SourceActivityInfo
	if err := json.Unmarshal(result["activities"], &records); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, record := range records {
		ids = append(ids, record.ID)
	}
	return ids
}

func confirmation(ids []string, operationID string) map[string]any {
	return scoped(map[string]any{"operationId": operationID, "activityIds": ids, "reviewId": "operator_review", "approved": true, "comment": "Host writers were stopped by the operator."})
}

func TestSourceRecoveryRequiresExactOrphanSetAndPersistsHumanAudit(t *testing.T) {
	initial, _, _ := testManager(t, nil)
	for i := 0; i < 2; i++ {
		if _, err := initial.BeginSourceProcess("space_a"); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate an agent crash: the durable registrations survive while their
	// runtime handles do not. No actual process is spawned by this test.
	restarted := New(initial.storageRoot)
	ids := activityIDs(t, restarted)
	if len(ids) != 2 {
		t.Fatalf("lost orphaned registrations: %v", ids)
	}
	records, err := restarted.SourceActivities("space_a")
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if record.Status != "orphaned" || record.RuntimeLive {
			t.Fatalf("restart claimed live runtime handle: %+v", record)
		}
	}
	if _, err := restarted.LockPublication("space_a"); err == nil {
		t.Fatal("restart silently released source protection")
	}
	invalidSets := [][]string{{ids[0]}, {ids[0], ids[0]}, {ids[0], "unknown_activity"}, {ids[0], ids[1], "unknown_activity"}}
	for i, invalid := range invalidSets {
		if _, err := rpcCall(restarted, "project.source.confirm", confirmation(invalid, "invalid_"+string(rune('a'+i)))); err == nil {
			t.Fatalf("accepted incomplete/duplicate/unknown IDs: %v", invalid)
		}
	}
	args := confirmation(ids, "source_confirm")
	// Worst-case JSON escaping remains loadable on restart.
	args["comment"] = strings.Repeat("\x01", 4096)
	rpcResult(t, restarted, "project.source.confirm", args)
	rpcResult(t, restarted, "project.source.confirm", args)
	args["comment"] = "changed review"
	if _, err := rpcCall(restarted, "project.source.confirm", args); err == nil {
		t.Fatal("operation ID allowed changed operator attestation")
	}
	for _, id := range ids {
		data, err := os.ReadFile(filepath.Join(initial.storageRoot, "source-processes", id+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var record sourceActivity
		if err := json.Unmarshal(data, &record); err != nil {
			t.Fatal(err)
		}
		if record.State != "settled" || record.Resolution != "human_attestation" || record.ReviewID != "operator_review" || len(record.Comment) != 4096 {
			t.Fatalf("missing durable human audit: %+v", record)
		}
	}
	secondRestart := New(initial.storageRoot)
	if active := activityIDs(t, secondRestart); len(active) != 0 {
		t.Fatalf("settled source activities resurrected: %v", active)
	}
	unlock, err := secondRestart.LockPublication("space_a")
	if err != nil {
		t.Fatalf("audited recovery failed to release protection: %v", err)
	}
	unlock()
}

func TestSourceRecoveryRefusesCurrentAndUnscopedRegistrations(t *testing.T) {
	m, _, _ := testManager(t, nil)
	release, err := m.BeginSourceProcess("space_a")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ids := activityIDs(t, m)
	if _, err := rpcCall(m, "project.source.confirm", confirmation(ids, "current_confirm")); err == nil || !strings.Contains(err.Error(), "current source") {
		t.Fatalf("cleared current runtime registration: %v", err)
	}
	release()
	if _, err := m.BeginSourceProcess("space_b"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.BeginSourceProcess(""); err != nil {
		t.Fatal(err)
	}
	restarted := New(m.storageRoot)
	ids = activityIDs(t, restarted)
	if len(ids) != 1 {
		t.Fatalf("scope leaked another space activity: %v", ids)
	}
	if _, err := rpcCall(restarted, "project.source.confirm", confirmation(ids, "global_confirm")); err == nil || !strings.Contains(err.Error(), "node administration") {
		t.Fatalf("project cleared unscoped source activity: %v", err)
	}
	if _, err := restarted.LockPublication("space_a"); err == nil {
		t.Fatal("global orphan no longer protects source")
	}
}

func TestSourceRecoveryCannotClearAnotherSpacesOrphans(t *testing.T) {
	m, _, _ := testManager(t, nil)
	if _, err := m.BeginSourceProcess("space_b"); err != nil {
		t.Fatal(err)
	}
	restarted := New(m.storageRoot)
	other, err := restarted.SourceActivities("space_b")
	if err != nil || len(other) != 1 {
		t.Fatalf("missing foreign registration: %+v %v", other, err)
	}
	if ids := activityIDs(t, restarted); len(ids) != 0 {
		t.Fatalf("scope disclosed foreign source IDs: %v", ids)
	}
	if _, err := rpcCall(restarted, "project.source.confirm", confirmation([]string{other[0].ID}, "foreign_confirm")); err == nil {
		t.Fatal("project cleared another space's orphan")
	}
	if _, err := restarted.LockPublication("space_b"); err == nil {
		t.Fatal("foreign orphan protection disappeared")
	}
}
