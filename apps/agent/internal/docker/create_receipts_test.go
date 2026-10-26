package docker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func receiptFixture() (RunSpec, CreateOperation) {
	op := CreateOperation{ID: "operation-1", TenantID: "tenant-1", SpaceID: "space-1", ComputerID: "computer-1"}
	return RunSpec{
		Name: "workspace-space-1", Image: "workspace:1",
		Env:     map[string]string{"TOKEN": "environment-secret"},
		Command: []string{"sh", "-c", "command-secret"},
		Labels: map[string]string{"zakura.tenant": op.TenantID, "zakura.space": op.SpaceID,
			"zakura.computer": op.ComputerID, "zakura.purpose": "workspace", "private": "label-secret"},
		Volumes: []Volume{{HostPath: "/storage/spaces/space-1/workspace", ContainerPath: "/workspace"}},
	}, op
}

func receiptStatusRequest(op CreateOperation) CreateStatusRequest {
	return CreateStatusRequest{OperationID: op.ID, TenantID: op.TenantID, SpaceID: op.SpaceID, ComputerID: op.ComputerID,
		InstanceID: op.InstanceID, Generation: op.Generation, DiskID: op.DiskID, LocatorVersion: op.LocatorVersion, NodeIncarnation: op.NodeIncarnation, Purpose: op.Purpose}
}

func receiptInfo(spec RunSpec) ContainerInfo {
	return ContainerInfo{DockerID: "docker-id-1", Name: spec.Name, Image: spec.Image,
		Status: "running", Ports: []Port{}, Labels: spec.Labels}
}

func TestCreateReceiptDurableReplayAndSecrets(t *testing.T) {
	root := t.TempDir()
	spec, op := receiptFixture()
	creates, inspections := 0, 0
	store := createReceipts{root: root,
		create: func(_ context.Context, labeled RunSpec) (ContainerInfo, error) {
			creates++
			// The complete intent must already be durable before Docker is invoked.
			job, _, err := openCreateJob(root, op.ID, false)
			if err != nil {
				t.Fatal(err)
			}
			defer job.Close()
			intent, err := readCreateIntent(job)
			if err != nil || !intent.matches(receiptInfo(labeled)) {
				t.Fatalf("intent before effect: %+v %v", intent, err)
			}
			return receiptInfo(labeled), nil
		},
		inspect: func(context.Context, string) (ContainerInfo, error) {
			inspections++
			return ContainerInfo{}, errors.New("Docker is offline")
		},
	}
	first, err := store.run(context.Background(), spec, op)
	if err != nil {
		t.Fatal(err)
	}
	// A new store/handler and an unavailable engine must still replay the receipt.
	restarted := createReceipts{root: root, create: store.create, inspect: store.inspect}
	second, err := restarted.run(context.Background(), spec, op)
	if err != nil || second.DockerID != first.DockerID {
		t.Fatalf("replay: %+v %v", second, err)
	}
	status, err := restarted.status(context.Background(), receiptStatusRequest(op))
	if err != nil || status.State != "committed" || status.Container.DockerID != first.DockerID {
		t.Fatalf("status: %+v %v", status, err)
	}
	if creates != 1 || inspections != 0 {
		t.Fatalf("effects: create=%d inspect=%d", creates, inspections)
	}
	if len(first.Labels) != 6 || first.Labels["private"] != "" {
		t.Fatalf("unsafe receipt labels: %+v", first.Labels)
	}
	if _, ok := spec.Labels[createOperationLabel]; ok {
		t.Fatal("caller map mutated")
	}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, secret := range []string{"environment-secret", "command-secret", "label-secret", "\"env\"", "\"command\""} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("secret/spec persisted in %s", path)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	wire, _ := json.Marshal(second)
	if strings.Contains(string(wire), "container\"") || !strings.Contains(string(wire), `"dockerId":"docker-id-1"`) {
		t.Fatalf("not legacy flat container: %s", wire)
	}
}

func TestCreateReceiptConcurrentCallsExecuteOnce(t *testing.T) {
	spec, op := receiptFixture()
	var creates atomic.Int32
	store := createReceipts{root: t.TempDir(),
		create: func(_ context.Context, spec RunSpec) (ContainerInfo, error) {
			creates.Add(1)
			return receiptInfo(spec), nil
		},
		inspect: func(context.Context, string) (ContainerInfo, error) {
			t.Error("unexpected inspect")
			return ContainerInfo{}, errors.New("no")
		},
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info, err := store.run(context.Background(), spec, op)
			if err != nil || info.DockerID != "docker-id-1" {
				t.Errorf("concurrent result: %+v %v", info, err)
			}
		}()
	}
	wg.Wait()
	if creates.Load() != 1 {
		t.Fatalf("Docker ran %d times", creates.Load())
	}
}

func TestCreateReceiptCanonicalDigestAndChanges(t *testing.T) {
	spec, op := receiptFixture()
	intent, _, err := prepareCreate(spec, op)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := receiptFixture()
	other.Labels = map[string]string{"private": "label-secret", "zakura.purpose": "workspace", "zakura.computer": op.ComputerID,
		"zakura.space": op.SpaceID, "zakura.tenant": op.TenantID}
	other.Ports = []Port{}
	again, _, _ := prepareCreate(other, op)
	if intent != again || len(intent.ConfigDigest) != 64 {
		t.Fatalf("noncanonical digest: %+v %+v", intent, again)
	}
	store := createReceipts{root: t.TempDir(),
		create: func(_ context.Context, spec RunSpec) (ContainerInfo, error) { return receiptInfo(spec), nil },
		inspect: func(context.Context, string) (ContainerInfo, error) {
			t.Fatal("unexpected inspect")
			return ContainerInfo{}, nil
		},
	}
	if _, err := store.run(context.Background(), spec, op); err != nil {
		t.Fatal(err)
	}
	changes := map[string]func(*RunSpec, *CreateOperation){
		"env":        func(s *RunSpec, _ *CreateOperation) { s.Env["TOKEN"] = "other" },
		"command":    func(s *RunSpec, _ *CreateOperation) { s.Command[0] = "other" },
		"image":      func(s *RunSpec, _ *CreateOperation) { s.Image = "workspace:2" },
		"name":       func(s *RunSpec, _ *CreateOperation) { s.Name = "other-name" },
		"labels":     func(s *RunSpec, _ *CreateOperation) { s.Labels["new"] = "value" },
		"volumes":    func(s *RunSpec, _ *CreateOperation) { s.Volumes[0].ReadOnly = true },
		"ports":      func(s *RunSpec, _ *CreateOperation) { s.Ports = []Port{{ContainerPort: 80}} },
		"network":    func(s *RunSpec, _ *CreateOperation) { s.Network = "private" },
		"restart":    func(s *RunSpec, _ *CreateOperation) { s.Restart = "no" },
		"privileged": func(s *RunSpec, _ *CreateOperation) { s.Privileged = true },
		"stdin":      func(s *RunSpec, _ *CreateOperation) { s.StdinOpen = true },
		"workdir":    func(s *RunSpec, _ *CreateOperation) { s.WorkingDir = "/other" },
		"tenant":     func(s *RunSpec, o *CreateOperation) { o.TenantID = "other"; s.Labels["zakura.tenant"] = "other" },
		"space":      func(s *RunSpec, o *CreateOperation) { o.SpaceID = "other"; s.Labels["zakura.space"] = "other" },
		"computer":   func(s *RunSpec, o *CreateOperation) { o.ComputerID = "other"; s.Labels["zakura.computer"] = "other" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			changed, operation := receiptFixture()
			change(&changed, &operation)
			if _, err := store.run(context.Background(), changed, operation); !errors.Is(err, ErrCreateConflict) {
				t.Fatalf("changed spec accepted: %v", err)
			}
		})
	}
	for _, field := range []string{"tenant", "space", "computer", "name"} {
		request := receiptStatusRequest(op)
		switch field {
		case "tenant":
			request.TenantID = "other"
		case "space":
			request.SpaceID = "other"
		case "computer":
			request.ComputerID = "other"
		case "name":
			request.Name = "other-name"
		}
		if _, err := store.status(context.Background(), request); !errors.Is(err, ErrCreateConflict) {
			t.Fatalf("changed status %s accepted: %v", field, err)
		}
	}
}

func TestCreateReceiptFailureStaysUnknownWithoutRetry(t *testing.T) {
	for _, effect := range []string{"error", "wrong-container", "cancel", "commit-failure"} {
		t.Run(effect, func(t *testing.T) {
			spec, op := receiptFixture()
			creates := 0
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store := createReceipts{root: t.TempDir()}
			store.create = func(_ context.Context, labeled RunSpec) (ContainerInfo, error) {
				creates++
				switch effect {
				case "error":
					return ContainerInfo{}, errors.New("environment-secret")
				case "wrong-container":
					labeled.Name = "wrong-name"
				case "cancel":
					cancel()
					return ContainerInfo{}, ctx.Err()
				case "commit-failure":
					job, _, err := openCreateJob(store.root, op.ID, false)
					if err != nil {
						t.Fatal(err)
					}
					defer job.Close()
					if err := job.WriteFile("committed.json", []byte("truncated"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				return receiptInfo(labeled), nil
			}
			store.inspect = func(context.Context, string) (ContainerInfo, error) {
				return ContainerInfo{}, errors.New("engine offline")
			}
			if _, err := store.run(ctx, spec, op); !errors.Is(err, ErrCreateUnknown) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe first failure: %v", err)
			}
			if _, err := store.run(context.Background(), spec, op); !errors.Is(err, ErrCreateUnknown) {
				t.Fatalf("replayed uncertain create: %v", err)
			}
			status, err := store.status(context.Background(), receiptStatusRequest(op))
			if status.State != "unknown" || status.Container != nil || (err != nil && !errors.Is(err, ErrCreateUnknown)) {
				t.Fatalf("unsafe status: %+v %v", status, err)
			}
			if creates != 1 {
				t.Fatalf("Docker ran %d times", creates)
			}
		})
	}
}

func TestCreateReceiptInspectionRequiresEveryIdentityLabel(t *testing.T) {
	for _, mismatch := range []string{"", "name", "id", "zakura.tenant", "zakura.space", "zakura.computer", "zakura.purpose", createOperationLabel, createDigestLabel} {
		t.Run("mismatch="+mismatch, func(t *testing.T) {
			spec, op := receiptFixture()
			intent, labeled, _ := prepareCreate(spec, op)
			store := createReceipts{root: t.TempDir()}
			job, claimed, err := openCreateJob(store.root, op.ID, true)
			if err != nil || !claimed {
				t.Fatalf("claim: %v %v", claimed, err)
			}
			if err := saveCreateRecord(job, "intent.json", intent); err != nil {
				t.Fatal(err)
			}
			job.Close()
			inspections := 0
			store.create = func(context.Context, RunSpec) (ContainerInfo, error) {
				t.Fatal("intent replay ran Docker")
				return ContainerInfo{}, nil
			}
			store.inspect = func(_ context.Context, name string) (ContainerInfo, error) {
				inspections++
				if name != spec.Name {
					t.Fatalf("not exact name: %s", name)
				}
				info := receiptInfo(labeled)
				switch mismatch {
				case "":
				case "name":
					info.Name += "-other"
				case "id":
					info.DockerID = ""
				default:
					delete(info.Labels, mismatch)
				}
				return info, nil
			}
			status, err := store.status(context.Background(), receiptStatusRequest(op))
			if err != nil {
				t.Fatal(err)
			}
			if mismatch == "" {
				if status.State != "committed" || status.Container == nil {
					t.Fatalf("exact inspection not reconciled: %+v", status)
				}
				if _, err := store.run(context.Background(), spec, op); err != nil {
					t.Fatal(err)
				}
				if inspections != 1 {
					t.Fatalf("did not persist inspection receipt: %d", inspections)
				}
			} else {
				if status.State != "unknown" || status.Container != nil {
					t.Fatalf("mismatch trusted: %+v", status)
				}
				if _, err := store.run(context.Background(), spec, op); !errors.Is(err, ErrCreateUnknown) {
					t.Fatalf("mismatch replay: %v", err)
				}
			}
		})
	}
}

func TestCreateReceiptAbsentAndPartialRecordsAreUnknown(t *testing.T) {
	for _, phase := range []string{"absent", "claimed", "truncated-intent", "truncated-commit", "wrong-commit"} {
		t.Run(phase, func(t *testing.T) {
			spec, op := receiptFixture()
			store := createReceipts{root: t.TempDir(),
				create: func(context.Context, RunSpec) (ContainerInfo, error) {
					t.Fatal("unsafe create")
					return ContainerInfo{}, nil
				},
				inspect: func(context.Context, string) (ContainerInfo, error) {
					t.Fatal("unsafe inspect without valid intent/receipt")
					return ContainerInfo{}, nil
				},
			}
			if phase != "absent" {
				job, _, err := openCreateJob(store.root, op.ID, true)
				if err != nil {
					t.Fatal(err)
				}
				defer job.Close()
				if phase == "truncated-intent" {
					if err := job.WriteFile("intent.json", []byte(`{"version":`), 0600); err != nil {
						t.Fatal(err)
					}
				} else if phase != "claimed" {
					intent, labeled, _ := prepareCreate(spec, op)
					if err := saveCreateRecord(job, "intent.json", intent); err != nil {
						t.Fatal(err)
					}
					if phase == "wrong-commit" {
						info := receiptInfo(labeled)
						info.Name = "other-name"
						if err := saveCreateRecord(job, "committed.json", createCommit{intent, info}); err != nil {
							t.Fatal(err)
						}
					} else if err := job.WriteFile("committed.json", []byte(`{`), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			request := receiptStatusRequest(op)
			request.Name = spec.Name
			status, err := store.status(context.Background(), request)
			if status.State != "unknown" || status.Container != nil || (err != nil && !errors.Is(err, ErrCreateUnknown)) {
				t.Fatalf("unsafe status: %+v %v", status, err)
			}
			if phase != "absent" {
				if _, err := store.run(context.Background(), spec, op); !errors.Is(err, ErrCreateUnknown) {
					t.Fatalf("partial receipt authorized replay: %v", err)
				}
			}
		})
	}
}

func TestCreateReceiptRejectsInvalidIdentityAndReservedLabels(t *testing.T) {
	for _, invalid := range []string{"purpose", "tenant", "space", "computer", "operation", "name", "image", "reserved-operation", "reserved-digest"} {
		t.Run(invalid, func(t *testing.T) {
			spec, op := receiptFixture()
			switch invalid {
			case "purpose":
				spec.Labels["zakura.purpose"] = "mcp"
			case "tenant":
				spec.Labels["zakura.tenant"] = "other"
			case "space":
				spec.Labels["zakura.space"] = "other"
			case "computer":
				spec.Labels["zakura.computer"] = "other"
			case "operation":
				op.ID = "../escape"
			case "name":
				spec.Name = "/workspace-space-1"
			case "image":
				spec.Image = ""
			case "reserved-operation":
				spec.Labels[createOperationLabel] = op.ID
			case "reserved-digest":
				spec.Labels[createDigestLabel] = ""
			}
			store := createReceipts{root: filepath.Join(t.TempDir(), "must-not-be-created")}
			if _, err := store.run(context.Background(), spec, op); err == nil || errors.Is(err, ErrCreateUnknown) {
				t.Fatalf("invalid request not rejected before disk/Docker: %v", err)
			}
			if _, err := os.Stat(store.root); !os.IsNotExist(err) {
				t.Fatalf("invalid request created storage: %v", err)
			}
		})
	}
}
