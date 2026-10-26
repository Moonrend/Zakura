package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

func TestE2BCleanupSnapshotUsesOriginalSealedAccountAfterDeletion(t *testing.T) {
	for _, mode := range []string{"success", "absent", "foreign", "wrong-id", "incomplete", "probe-failure", "delete-failure", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			h, r := e2bTestSetup(t)
			r.ExternalID = "original-sandbox"
			r.State = computers.Stopping
			if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state='stopping',external_id=? WHERE id=?`, r.ExternalID, r.ID).Error; err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			probes, deletes := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if req.Header.Get("X-API-Key") != "test-key" || req.URL.Path != "/sandboxes/original-sandbox" {
					t.Error("cleanup account or sandbox redirected")
					http.Error(w, "bad", 400)
					return
				}
				switch req.Method {
				case http.MethodGet:
					probes++
					switch mode {
					case "absent":
						w.WriteHeader(404)
						return
					case "probe-failure":
						http.Error(w, "secret-key-in-response", 503)
						return
					case "incomplete":
						_, _ = w.Write([]byte(`{"sandboxID":`))
						return
					case "redirect":
						w.Header().Set("Location", "/must-not-follow")
						w.WriteHeader(302)
						return
					}
					metadata := e2bMetadata(r)
					id := r.ExternalID
					if mode == "foreign" {
						metadata["zakura.incarnation"] = "replacement"
					}
					if mode == "wrong-id" {
						id = "replacement"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": id, "metadata": metadata})
				case http.MethodDelete:
					deletes++
					if mode == "delete-failure" {
						http.Error(w, "secret-key-in-response", 503)
						return
					}
					w.WriteHeader(204)
				default:
					http.Error(w, "unexpected", 400)
				}
			}))
			defer server.Close()
			p := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
			snapshot, err := p.CaptureCleanup(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(snapshot), "test-key") || strings.Contains(string(snapshot), server.URL) {
				t.Fatal("cleanup snapshot exposed original account configuration")
			}
			// Reconfiguration must not change the captured account, then deletion removes
			// both computer and runtime rows completely.
			sealed, err := computers.SealCredentials(h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, []byte(`{"apiKey":"replacement-key","template":"replacement"}`))
			if err != nil {
				t.Fatal(err)
			}
			if err = h.deps.Gorm.Exec(`UPDATE computers SET secret_ref=? WHERE id=?`, sealed, r.ComputerID).Error; err != nil {
				t.Fatal(err)
			}
			if err = h.deps.Gorm.Exec(`DELETE FROM computers WHERE id=?`, r.ComputerID).Error; err != nil {
				t.Fatal(err)
			}
			err = p.DestroyCleanup(context.Background(), r, snapshot)
			if mode == "success" || mode == "absent" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe cleanup accepted")
				}
				if strings.Contains(err.Error(), "secret-key-in-response") || strings.Contains(err.Error(), "test-key") {
					t.Fatalf("credential leaked: %v", err)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			expected := 0
			if mode == "success" || mode == "delete-failure" {
				expected = 1
			}
			if probes != 1 || deletes != expected {
				t.Fatalf("probes=%d deletes=%d", probes, deletes)
			}
		})
	}
}

func TestE2BCleanupQueueRetriesAfterOwnerDeletion(t *testing.T) {
	h, r := e2bTestSetup(t)
	ctx := context.Background()
	now := h.store.now()
	r.ExternalID = "queued-original"
	r.State = computers.Stopping
	if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET state='stopping',external_id=? WHERE id=?`, r.ExternalID, r.ID).Error; err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	fail := true
	deletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if req.Header.Get("X-API-Key") != "test-key" {
			t.Error("original account lost")
		}
		if req.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": r.ExternalID, "metadata": e2bMetadata(r)})
			return
		}
		if req.Method != http.MethodDelete {
			http.Error(w, "unexpected", 400)
			return
		}
		deletes++
		if fail {
			http.Error(w, "provider unavailable", 503)
			return
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	p := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
	d := computers.CleanupDeps{Store: h.computerStore(), Destroyers: map[computers.Provider]computers.DestructionProvider{computers.E2B: p}, Now: func() time.Time { return now }}
	if err := d.QueueCleanup(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.Gorm.Exec(`DELETE FROM computers WHERE id=?`, r.ComputerID).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.ExpireOverdue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	var pending bool
	if err := h.deps.DB.QueryRow(`SELECT pending FROM computer_cleanup_intents WHERE runtime_id=?`, r.ID).Scan(&pending); err != nil || !pending {
		t.Fatalf("failed removal lost cleanup: %v %v", pending, err)
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	now = now.Add(2 * time.Minute)
	if _, _, err := d.ExpireOverdue(ctx, 10); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.DB.QueryRow(`SELECT pending FROM computer_cleanup_intents WHERE runtime_id=?`, r.ID).Scan(&pending); err != nil || pending {
		t.Fatalf("retry not completed: %v %v", pending, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if deletes != 2 {
		t.Fatalf("deletes=%d", deletes)
	}
}

func TestE2BCleanupUnknownCreationDiscoversAfterOwnerDeletion(t *testing.T) {
	for _, mode := range []string{"found", "late", "foreign", "ambiguous"} {
		t.Run(mode, func(t *testing.T) {
			h, r := e2bTestSetup(t)
			deletes, lists := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Header.Get("X-API-Key") != "test-key" {
					t.Error("cleanup lost original API key")
				}
				if req.URL.Path == "/sandboxes" {
					lists++
					if req.URL.Query().Get("metadata") != "zakura.operation="+r.CreateOperationID {
						t.Error("cleanup lookup lost operation identity")
					}
					if mode == "late" && lists == 1 {
						_, _ = w.Write([]byte(`[]`))
						return
					}
					metadata := e2bMetadata(r)
					if mode == "foreign" {
						metadata["zakura.incarnation"] = "replacement"
					}
					items := []map[string]any{{"sandboxID": "discovered", "metadata": metadata}}
					if mode == "ambiguous" {
						items = append(items, items[0])
					}
					_ = json.NewEncoder(w).Encode(items)
					return
				}
				if req.URL.Path != "/sandboxes/discovered" {
					t.Errorf("wrong sandbox path: %s", req.URL.Path)
				}
				if req.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode(map[string]any{"sandboxID": "discovered", "metadata": e2bMetadata(r)})
					return
				}
				if req.Method != http.MethodDelete {
					t.Errorf("unexpected method: %s", req.Method)
				}
				deletes++
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			p := e2bComputerProvider{h: h, apiBase: server.URL, httpClient: server.Client()}
			data, err := p.CaptureCleanup(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			if err = h.deps.Gorm.Exec(`DELETE FROM computers WHERE id=?`, r.ComputerID).Error; err != nil {
				t.Fatal(err)
			}
			err = p.DestroyCleanup(context.Background(), r, data)
			if mode == "late" {
				if err == nil || deletes != 0 {
					t.Fatal("empty lookup abandoned an in-flight creation")
				}
				err = p.DestroyCleanup(context.Background(), r, data)
			}
			if mode == "found" || mode == "late" {
				if err != nil || deletes != 1 {
					t.Fatalf("discovered cleanup: deletes=%d %v", deletes, err)
				}
			} else if err == nil || deletes != 0 {
				t.Fatalf("foreign or ambiguous cleanup: deletes=%d %v", deletes, err)
			}
		})
	}
}

func TestE2BCleanupSnapshotCannotTargetReplacement(t *testing.T) {
	h, r := e2bTestSetup(t)
	r.ExternalID = "original"
	if err := h.deps.Gorm.Exec(`UPDATE computer_runtimes SET external_id=? WHERE id=?`, r.ExternalID, r.ID).Error; err != nil {
		t.Fatal(err)
	}
	p := e2bComputerProvider{h: h}
	data, err := p.CaptureCleanup(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*computers.Runtime){func(v *computers.Runtime) { v.ExternalID = "replacement" }, func(v *computers.Runtime) { v.Incarnation = "replacement" }, func(v *computers.Runtime) { v.SessionScope = "other-chat" }, func(v *computers.Runtime) { v.TenantID = "other" }} {
		replacement := r
		change(&replacement)
		if err = p.DestroyCleanup(context.Background(), replacement, data); err == nil {
			t.Fatal("snapshot retargeted")
		}
	}
	if err = p.DestroyCleanup(context.Background(), r, json.RawMessage(`{"apiKey":"forged"}`)); err == nil {
		t.Fatal("unsealed credentials accepted")
	}
	stale := r
	stale.ExternalID = "replacement"
	if _, err = p.CaptureCleanup(context.Background(), stale); !errors.Is(err, computers.ErrTransitionConflict) {
		t.Fatalf("stale capture=%v", err)
	}
}
