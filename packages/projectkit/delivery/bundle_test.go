// SPDX-License-Identifier: AGPL-3.0-or-later
package delivery

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

func bundleFixture(t *testing.T) (Manifest, []byte, []byte) {
	t.Helper()
	ctx := context.Background()
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "feature.txt"), bytes.Repeat([]byte("useful immutable artifact\n"), 9000), 0644); err != nil {
		t.Fatal(err)
	}
	repo, err := workspace.New(t.TempDir(), workspace.Options{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := repo.Snapshot(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	var payload bytes.Buffer
	if err := repo.Export(ctx, snapshot.ID, &payload); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(payload.Bytes())
	manifest := Manifest{Schema: Schema, Version: 1, ID: "delivery_a", Name: "Useful artifact", Release: "v1", ProjectID: "project_a", RunID: "run_a", SnapshotID: snapshot.ID, Goal: "Deliver immutable results", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "task", Title: "Author", Prompt: "Implement artifact", Writes: []string{"feature.txt"}, Checks: []mission.CheckSpec{{ID: "exists", Kind: "path_exists", Path: "feature.txt", Required: true}}}}}, Review: Review{ID: "review_a", Author: "human", Comment: "Artifact inspected", PreviewID: "preview_a", PreviewRevision: 2, Evidence: json.RawMessage(`{"policyHash":"untrusted_policy","participants":[{"userId":"human","voteId":"vote_a"}]}`)}, CreatedAt: time.Unix(1000, 0).UTC(), PayloadBytes: int64(payload.Len()), PayloadSHA256: hex.EncodeToString(hash[:])}
	var archive bytes.Buffer
	if err := Write(ctx, &archive, manifest, bytes.NewReader(payload.Bytes())); err != nil {
		t.Fatal(err)
	}
	return manifest, payload.Bytes(), archive.Bytes()
}

func TestBundleActualWorkspaceRoundTripAndUnsignedReview(t *testing.T) {
	manifest, _, archive := bundleFixture(t)
	repo, err := workspace.New(t.TempDir(), workspace.Options{})
	if err != nil {
		t.Fatal(err)
	}
	imported, snapshot, err := Import(context.Background(), bytes.NewReader(archive), int64(len(archive)), func(input io.Reader) (workspace.Snapshot, error) { return repo.Import(context.Background(), input) })
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ID != manifest.SnapshotID || !reflect.DeepEqual(imported.Review, manifest.Review) {
		t.Fatal("immutable artifact or review metadata changed")
	}
	// Retaining a comment in unsigned metadata does not constitute an approval
	// in any execution database. A receiver must create and review its own run.
	b, err := repo.ReadSnapshot(context.Background(), snapshot.ID, "feature.txt")
	if err != nil || !bytes.HasPrefix(b, []byte("useful immutable artifact")) {
		t.Fatalf("round trip file: %v", err)
	}
	first, err := ManifestHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	imported.Review.Comment = "untrusted alternate assertion"
	second, err := ManifestHash(imported)
	if err != nil || first == second {
		t.Fatal("provenance comment omitted from integrity hash")
	}
}

func customEnvelope(t *testing.T, m Manifest, payload []byte, manifestType byte, name string, extra bool) []byte {
	t.Helper()
	var out bytes.Buffer
	tw := tar.NewWriter(&out)
	raw, _ := json.Marshal(m)
	header := &tar.Header{Name: name, Mode: 0600, Size: int64(len(raw)), Typeflag: manifestType}
	if manifestType != tar.TypeReg {
		header.Size = 0
		header.Linkname = "outside"
	}
	if err := tw.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if header.Size > 0 {
		if _, err := tw.Write(raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.WriteHeader(&tar.Header{Name: "workspace.tar", Mode: 0600, Size: int64(len(payload)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if extra {
		if err := tw.WriteHeader(&tar.Header{Name: "unexpected.txt", Mode: 0600, Size: 1, Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte("x"))
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestBundleInvalidEnvelopeNeverInvokesWorkspaceImporter(t *testing.T) {
	manifest, payload, valid := bundleFixture(t)
	tampered := append([]byte(nil), payload...)
	tampered[len(tampered)/2] ^= 1
	cases := map[string][]byte{
		"payload-digest":    customEnvelope(t, manifest, tampered, tar.TypeReg, "delivery.json", false),
		"manifest-link":     customEnvelope(t, manifest, payload, tar.TypeSymlink, "delivery.json", false),
		"manifest-hardlink": customEnvelope(t, manifest, payload, tar.TypeLink, "delivery.json", false),
		"manifest-path":     customEnvelope(t, manifest, payload, tar.TypeReg, "../delivery.json", false),
		"extra-entry":       customEnvelope(t, manifest, payload, tar.TypeReg, "delivery.json", true),
		"nonzero-trailer":   append(append([]byte(nil), valid...), []byte("foreign trailer")...),
		"truncated-payload": valid[:len(valid)/2],
	}
	for name, archive := range cases {
		t.Run(name, func(t *testing.T) {
			called := false
			_, _, err := Import(context.Background(), bytes.NewReader(archive), int64(len(archive)), func(io.Reader) (workspace.Snapshot, error) {
				called = true
				return workspace.Snapshot{ID: manifest.SnapshotID}, nil
			})
			if err == nil || called {
				t.Fatalf("invalid envelope reached importer: %v called=%v", err, called)
			}
		})
	}
}

func TestBundleRejectsMissingEndMarkersAndInvalidWorkspaceLinks(t *testing.T) {
	manifest, payload, valid := bundleFixture(t)
	truncated := valid[:len(valid)-1024]
	_, _, err := Import(context.Background(), bytes.NewReader(truncated), int64(len(truncated)), func(io.Reader) (workspace.Snapshot, error) { return workspace.Snapshot{ID: manifest.SnapshotID}, nil })
	if err == nil {
		t.Fatal("complete payload without outer tar end markers was accepted")
	}
	// A correctly hashed outer envelope must still pass the real workspace
	// archive rules; replacing an object entry with a link is never extracted.
	reader := tar.NewReader(bytes.NewReader(payload))
	var bad bytes.Buffer
	writer := tar.NewWriter(&bad)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		copyHeader := *header
		if strings.HasPrefix(header.Name, "objects/") {
			copyHeader.Typeflag = tar.TypeSymlink
			copyHeader.Size = 0
			copyHeader.Linkname = "../../outside"
		}
		if err := writer.WriteHeader(&copyHeader); err != nil {
			t.Fatal(err)
		}
		if copyHeader.Size > 0 {
			_, _ = writer.Write(data)
		}
	}
	_ = writer.Close()
	sum := sha256.Sum256(bad.Bytes())
	manifest.PayloadBytes = int64(bad.Len())
	manifest.PayloadSHA256 = hex.EncodeToString(sum[:])
	archive := customEnvelope(t, manifest, bad.Bytes(), tar.TypeReg, "delivery.json", false)
	target, err := workspace.New(t.TempDir(), workspace.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Import(context.Background(), bytes.NewReader(archive), int64(len(archive)), func(input io.Reader) (workspace.Snapshot, error) { return target.Import(context.Background(), input) }); err == nil {
		t.Fatal("workspace symlink archive accepted")
	}
	if _, err := target.GetSnapshot(context.Background(), manifest.SnapshotID); err == nil {
		t.Fatal("invalid workspace published a manifest")
	}
}

func TestBundleRejectsRehashedInnerTrailingDataBeforePublishingSnapshot(t *testing.T) {
	manifest, payload, _ := bundleFixture(t)
	for _, invalid := range [][]byte{
		append(append([]byte(nil), payload...), append([]byte("unreviewed inner trailer"), make([]byte, 512-len("unreviewed inner trailer"))...)...),
		payload[:len(payload)-1024],
	} {
		sum := sha256.Sum256(invalid)
		manifest.PayloadBytes = int64(len(invalid))
		manifest.PayloadSHA256 = hex.EncodeToString(sum[:])
		archive := customEnvelope(t, manifest, invalid, tar.TypeReg, "delivery.json", false)
		called := false
		_, _, err := Import(context.Background(), bytes.NewReader(archive), int64(len(archive)), func(io.Reader) (workspace.Snapshot, error) {
			called = true
			return workspace.Snapshot{ID: manifest.SnapshotID}, nil
		})
		if err == nil || called {
			t.Fatal("a recomputed payload digest admitted incomplete or unreviewed inner tar data")
		}
	}
}

func TestBundleWriteChecksLengthDigestCancellationAndMetadata(t *testing.T) {
	manifest, payload, _ := bundleFixture(t)
	for _, data := range [][]byte{payload[:len(payload)-1], append(append([]byte(nil), payload...), 1)} {
		if err := Write(context.Background(), io.Discard, manifest, bytes.NewReader(data)); err == nil {
			t.Fatal("payload length mismatch accepted")
		}
	}
	changed := manifest
	changed.PayloadSHA256 = strings.Repeat("a", 64)
	if err := Write(context.Background(), io.Discard, changed, bytes.NewReader(payload)); err == nil {
		t.Fatal("payload digest mismatch accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Write(ctx, io.Discard, manifest, bytes.NewReader(payload)); err == nil {
		t.Fatal("cancelled writer completed")
	}
	changed = manifest
	changed.ID = "../outside"
	if err := Validate(changed, true); err == nil {
		t.Fatal("invalid delivery identifier accepted")
	}
	changed = manifest
	changed.PayloadBytes = MaxArchiveBytes
	if err := Validate(changed, true); err == nil {
		t.Fatal("payload left no room for envelope")
	}
	changed = manifest
	changed.Name = strings.Repeat("x", 257)
	if err := Validate(changed, true); err == nil {
		t.Fatal("unbounded manifest name accepted")
	}
}
