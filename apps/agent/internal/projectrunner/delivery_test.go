// SPDX-License-Identifier: AGPL-3.0-or-later
package projectrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/delivery"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

func deliveryResult[T any](t *testing.T, m *Manager, method string, args map[string]any) T {
	t.Helper()
	value, err := rpcCall(m, method, args)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result T
	if err = json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func exportDelivery(t *testing.T, m *Manager, snapshot string) (delivery.ArchiveInfo, []byte) {
	t.Helper()
	manifest := delivery.Manifest{Schema: delivery.Schema, Version: 1, ID: "delivery_a", Name: "Reviewed feature", Release: "v1", ProjectID: "project_a", RunID: "run_a", SnapshotID: snapshot, Goal: "Useful result", Review: delivery.Review{ID: "review_a", Author: "human", Comment: "Reviewed immutable output", PreviewID: "preview_a", PreviewRevision: 2}, CreatedAt: time.Unix(1000, 0).UTC()}
	args := scoped(map[string]any{"operationId": "export_a", "deliveryId": "delivery_a", "manifest": manifest})
	info := deliveryResult[delivery.ArchiveInfo](t, m, "project.delivery.prepare", args)
	again := deliveryResult[delivery.ArchiveInfo](t, New(m.storageRoot), "project.delivery.prepare", args)
	if again.SHA256 != info.SHA256 || again.ManifestHash != info.ManifestHash {
		t.Fatal("export replay changed frozen bytes")
	}
	body := []byte{}
	for offset := int64(0); offset < info.Bytes; {
		result := deliveryResult[struct {
			Base64     string
			NextOffset int64
		}](t, m, "project.delivery.read", scoped(map[string]any{"deliveryId": "delivery_a", "offset": offset, "maxBytes": delivery.ChunkBytes}))
		data, err := base64.StdEncoding.Strict().DecodeString(result.Base64)
		if err != nil {
			t.Fatal(err)
		}
		if result.NextOffset != offset+int64(len(data)) || len(data) == 0 {
			t.Fatal("chunk cursor did not advance")
		}
		body = append(body, data...)
		offset = result.NextOffset
	}
	hash := sha256.Sum256(body)
	if int64(len(body)) != info.Bytes || hex.EncodeToString(hash[:]) != info.SHA256 {
		t.Fatal("streamed export does not match immutable archive hash")
	}
	return info, body
}

func importScope(extras map[string]any) map[string]any {
	args := scoped(extras)
	args["projectId"] = "project_b"
	return args
}

func TestDeliveryRealRoundTripRestartTailRetryRecoveryPinAndSourceIsolation(t *testing.T) {
	m, source, base := testManager(t, nil)
	transferID := strings.Repeat("x", 128)
	branch(t, m, base, "author")
	rpcResult(t, m, "project.branch.write", scoped(map[string]any{"operationId": "artifact_write", "branchId": "author", "path": "result.txt", "content": strings.Repeat("useful artifact\n", 20000)}))
	snapshot := textField(t, rpcResult(t, m, "project.branch.capture", scoped(map[string]any{"operationId": "artifact_capture", "branchId": "author"})), "snapshotId")
	info, archive := exportDelivery(t, m, snapshot)
	exportProject, err := m.get(Scope{"space_a", "project_a"})
	if err != nil {
		t.Fatal(err)
	}
	exportDir, err := deliveryExistingFolder(exportProject, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Crash immediately after the fsynced archive rename, before archive.json.
	if err := os.Remove(filepath.Join(exportDir, "archive.json")); err != nil {
		t.Fatal(err)
	}
	recoveredInfo := deliveryResult[delivery.ArchiveInfo](t, New(m.storageRoot), "project.delivery.info", scoped(map[string]any{"deliveryId": info.ID}))
	if recoveredInfo.SHA256 != info.SHA256 || recoveredInfo.ManifestHash != info.ManifestHash {
		t.Fatal("complete archive could not reconstruct its cache receipt")
	}
	transfer := deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.begin", importScope(map[string]any{"transferId": transferID, "totalBytes": info.Bytes, "sha256": info.SHA256}))
	first := archive[:delivery.ChunkBytes]
	chunk := func(manager *Manager, offset int64, data []byte) deliveryTransfer {
		return deliveryResult[deliveryTransfer](t, manager, "project.delivery.upload.chunk", importScope(map[string]any{"transferId": transferID, "offset": offset, "base64": base64.StdEncoding.EncodeToString(data)}))
	}
	transfer = chunk(m, 0, first)
	p, err := m.get(Scope{"space_a", "project_b"})
	if err != nil {
		t.Fatal(err)
	}
	dir, err := deliveryFolder(p, transferID)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, "upload.tar"), os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Write([]byte("uncommitted crash tail"))
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Sync()
	_ = f.Close()
	restarted := New(m.storageRoot)
	transfer = chunk(restarted, 0, first)
	st, err := os.Stat(filepath.Join(dir, "upload.tar"))
	if err != nil || st.Size() != int64(len(first)) || transfer.Received != int64(len(first)) {
		t.Fatal("restart did not discard the uncommitted tail")
	}
	wrong := append([]byte(nil), first...)
	wrong[0] ^= 1
	if _, err := rpcCall(restarted, "project.delivery.upload.chunk", importScope(map[string]any{"transferId": transferID, "offset": 0, "base64": base64.StdEncoding.EncodeToString(wrong)})); err == nil {
		t.Fatal("retry overwrote already committed bytes")
	}
	for offset := transfer.Received; offset < int64(len(archive)); {
		end := min(offset+delivery.ChunkBytes, int64(len(archive)))
		transfer = chunk(restarted, offset, archive[offset:end])
		offset = transfer.Received
	}
	finish := importScope(map[string]any{"operationId": "finish_a", "transferId": transferID})
	completed := deliveryResult[deliveryTransfer](t, restarted, "project.delivery.upload.finish", finish)
	if completed.Status != "completed" || !completed.UntrustedReview || completed.Manifest == nil || completed.SnapshotID != snapshot {
		t.Fatalf("import lost immutable identity/provenance: %+v", completed)
	}
	target, err := restarted.get(Scope{"space_a", "project_b"})
	if err != nil {
		t.Fatal(err)
	}
	file, err := target.repository.ReadSnapshot(context.Background(), snapshot, "result.txt")
	if err != nil || !bytes.HasPrefix(file, []byte("useful artifact")) {
		t.Fatal("imported CAS content missing")
	}
	// Reproduce a crash after the repository pin committed but before its
	// completed transfer receipt became durable. The journal is ambiguous.
	partial := completed
	partial.Status = "uploading"
	partial.Manifest = nil
	partial.SnapshotID = ""
	if err := deliveryWriteJSON(filepath.Join(dir, "upload.json"), partial); err != nil {
		t.Fatal(err)
	}
	op, err := loadOperation(target, "finish_a")
	if err != nil {
		t.Fatal(err)
	}
	op.Status = "running"
	op.Result = nil
	if err := persistOperation(target, op); err != nil {
		t.Fatal(err)
	}
	again := New(m.storageRoot)
	recovered := deliveryResult[deliveryTransfer](t, again, "project.delivery.upload.status", importScope(map[string]any{"transferId": transferID}))
	if recovered.Status != "completed" || recovered.SnapshotID != snapshot {
		t.Fatalf("pin/receipt gap could not be inspected: %+v", recovered)
	}
	inspection, err := again.Inspect(Scope{"space_a", "project_b"}, "finish_a")
	if err != nil || inspection.Known || inspection.Status != "unknown" {
		t.Fatal("ambiguous journal was guessed completed")
	}
	if _, err := rpcCall(again, "project.delivery.upload.finish", finish); err == nil {
		t.Fatal("unknown operation blindly replayed")
	}
	for _, method := range []string{"project.branch.write", "project.branch.patch", "project.exec", "project.branch.gc", "project.branch.capture"} {
		args := importScope(map[string]any{"operationId": "pin_" + strings.ReplaceAll(method, ".", "_"), "branchId": deliveryPinID(transferID)})
		switch method {
		case "project.branch.write":
			args["path"] = "result.txt"
			args["content"] = "changed"
		case "project.branch.patch":
			args["path"] = "result.txt"
			args["oldText"] = "useful"
			args["newText"] = "changed"
		case "project.exec":
			args["command"] = []string{"touch", "result.txt"}
		case "project.branch.gc":
			delete(args, "branchId")
			args["branchIds"] = []string{deliveryPinID(transferID)}
		}
		if _, err := rpcCall(again, method, args); err == nil {
			t.Fatalf("mutable delivery pin accepted %s", method)
		}
	}
	target, err = again.get(Scope{"space_a", "project_b"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := target.repository.GC(context.Background(), workspace.GCOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := target.repository.GetSnapshot(context.Background(), snapshot); err != nil {
		t.Fatal("GC collected completed immutable import")
	}
	if _, err := rpcCall(again, "project.delivery.info", importScope(map[string]any{"deliveryId": "delivery_a"})); err == nil {
		t.Fatal("export crossed project scope")
	}
	sourceBytes, err := os.ReadFile(filepath.Join(source, "hello.txt"))
	if err != nil || string(sourceBytes) != "hello\n" {
		t.Fatal("import changed original source")
	}
	if _, err := os.Stat(filepath.Join(source, "result.txt")); !os.IsNotExist(err) {
		t.Fatal("import materialized source files")
	}
}

func TestDeliveryAdmissionCrashQuotasSymlinksAndChangedTransferIdentity(t *testing.T) {
	m, _, _ := testManager(t, nil)
	p, err := m.get(Scope{"space_a", "project_b"})
	if err != nil {
		t.Fatal(err)
	}
	dir, err := deliveryFolder(p, "interrupted")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "upload.tar"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("not uploaded yet"))
	hash := hex.EncodeToString(sum[:])
	begin := func(id string, size int64) map[string]any {
		return importScope(map[string]any{"transferId": id, "totalBytes": size, "sha256": hash})
	}
	state := deliveryResult[deliveryTransfer](t, New(m.storageRoot), "project.delivery.upload.begin", begin("interrupted", 2048))
	if state.Status != "uploading" || state.Received != 0 {
		t.Fatal("empty pre-admission crash could not resume")
	}
	if _, err := rpcCall(m, "project.delivery.upload.begin", begin("interrupted", 4096)); err == nil {
		t.Fatal("transfer identity changed after admission")
	}
	// Quota counts unreceived reserved bytes, not just sparse on-disk bytes.
	deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.begin", begin("large_a", delivery.MaxArchiveBytes))
	deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.begin", begin("large_b", delivery.MaxArchiveBytes))
	if _, err := rpcCall(m, "project.delivery.upload.begin", begin("large_c", delivery.MaxArchiveBytes)); err == nil {
		t.Fatal("reserved upload bytes overcommitted cache")
	}
	deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.abort", importScope(map[string]any{"transferId": "large_a"}))
	deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.begin", begin("large_c", delivery.MaxArchiveBytes))
	root, err := deliveryRoot(p)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skip("symlinks unavailable")
	}
	if _, err := rpcCall(m, "project.delivery.upload.begin", begin("linked", 2048)); err == nil {
		t.Fatal("delivery folder symlink followed")
	}
	if _, err := rpcCall(m, "project.delivery.upload.begin", importScope(map[string]any{"transferId": "bad", "totalBytes": 2048, "sha256": strings.Repeat("A", 64)})); err == nil {
		t.Fatal("uppercase digest accepted")
	}
	if _, err := rpcCall(m, "project.delivery.upload.begin", importScope(map[string]any{"transferId": "../bad", "totalBytes": 2048, "sha256": hash})); err == nil {
		t.Fatal("transfer ID escaped scope")
	}
}

func TestDeliveryAbortedAdmissionsAndMissingReadsDoNotConsumePackageSlots(t *testing.T) {
	m, _, _ := testManager(t, nil)
	hash := strings.Repeat("a", 64)
	for i := 0; i < deliveryPackages+8; i++ {
		id := "aborted_" + strings.Repeat("x", i+1)
		deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.begin", importScope(map[string]any{"transferId": id, "totalBytes": 2048, "sha256": hash}))
		deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.abort", importScope(map[string]any{"transferId": id}))
	}
	longID := strings.Repeat("x", 128)
	deliveryResult[deliveryTransfer](t, m, "project.delivery.upload.begin", importScope(map[string]any{"transferId": longID, "totalBytes": 2048, "sha256": hash}))
	if err := ValidateID(deliveryPinID(longID)); err != nil {
		t.Fatal("maximum-length transfer cannot create a bounded import pin")
	}
	p, err := m.get(Scope{"space_a", "project_b"})
	if err != nil {
		t.Fatal(err)
	}
	root, err := deliveryRoot(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"project.delivery.info", "project.delivery.read", "project.delivery.upload.status"} {
		args := importScope(map[string]any{"deliveryId": "missing"})
		if strings.Contains(method, "upload") {
			delete(args, "deliveryId")
			args["transferId"] = "missing"
		}
		if _, err := rpcCall(m, method, args); err == nil {
			t.Fatal("missing delivery read succeeded")
		}
	}
	if _, err := os.Stat(filepath.Join(root, "missing")); !os.IsNotExist(err) {
		t.Fatal("read-only request created a package slot")
	}
	_, packages, uploads, err := deliveryQuota(root)
	if err != nil || packages != 1 || uploads != 1 {
		t.Fatalf("aborted metadata consumed live quota: %d/%d %v", packages, uploads, err)
	}
}

func TestSnapshotCopyImmutableCrossProjectOppositeDirectionsAndRestart(t *testing.T) {
	m, source, a := testManager(t, nil)
	b := textField(t, rpcResult(t, m, "project.base", importScope(map[string]any{"operationId": "base_b"})), "snapshotId")
	rpcResult(t, m, "project.branch.create", importScope(map[string]any{"operationId": "branch_b", "snapshotId": b, "branchId": "author_b"}))
	rpcResult(t, m, "project.branch.write", importScope(map[string]any{"operationId": "write_b", "branchId": "author_b", "path": "b.txt", "content": "second scoped artifact"}))
	b = textField(t, rpcResult(t, m, "project.branch.capture", importScope(map[string]any{"operationId": "capture_b", "branchId": "author_b"})), "snapshotId")
	copyA := importScope(map[string]any{"operationId": "copy_a_to_b", "sourceProjectId": "project_a", "snapshotId": a})
	copyB := scoped(map[string]any{"operationId": "copy_b_to_a", "sourceProjectId": "project_b", "snapshotId": b})
	done := make(chan error, 2)
	for _, args := range []map[string]any{copyA, copyB} {
		go func(args map[string]any) { _, err := rpcCall(m, "project.snapshot.copy", args); done <- err }(args)
	}
	for i := 0; i < 2; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("opposite-direction copy deadlocked")
		}
	}
	value := rpcResult(t, New(m.storageRoot), "project.snapshot.copy", copyB)
	if textField(t, value, "snapshotId") != b {
		t.Fatal("restart replay changed snapshot identity")
	}
	pa, err := m.get(Scope{"space_a", "project_a"})
	if err != nil {
		t.Fatal(err)
	}
	file, err := pa.repository.ReadSnapshot(context.Background(), b, "b.txt")
	if err != nil || string(file) != "second scoped artifact" {
		t.Fatal("copy read the live source instead of frozen CAS")
	}
	if _, err := os.Stat(filepath.Join(source, "b.txt")); !os.IsNotExist(err) {
		t.Fatal("snapshot copy materialized original source")
	}
	copyB["sourceSpaceId"] = "another"
	if _, err := rpcCall(m, "project.snapshot.copy", copyB); err == nil {
		t.Fatal("unapproved source space accepted")
	}
	delete(copyB, "sourceSpaceId")
	copyB["snapshotId"] = a
	if _, err := rpcCall(m, "project.snapshot.copy", copyB); err == nil {
		t.Fatal("operation replay accepted changed source snapshot")
	}
}
