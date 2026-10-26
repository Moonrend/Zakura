package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func receiptV2Fixture() (RunSpec, CreateOperation) {
	spec, op := receiptFixture()
	op.InstanceID, op.Generation = "instance-1", 3
	op.DiskID, op.LocatorVersion, op.NodeIncarnation = "disk-1", 2, "incarnation-1"
	for key, value := range op.labels("") {
		if key != createOperationLabel && key != createDigestLabel {
			spec.Labels[key] = value
		}
	}
	return spec, op
}

func TestCreateReceiptV1WireCompatibility(t *testing.T) {
	// The pre-v2 wire shape is also the durable digest input. Adding optional
	// identity or mount fields must not invalidate existing creation evidence.
	const legacy = `{"name":"workspace-space-1","image":"workspace:1","command":["sh","-c","command-secret"],"env":{"TOKEN":"environment-secret"},"labels":{"private":"label-secret","zakura.computer":"computer-1","zakura.purpose":"workspace","zakura.space":"space-1","zakura.tenant":"tenant-1"},"ports":null,"volumes":[{"hostPath":"/storage/spaces/space-1/workspace","containerPath":"/workspace"}],"network":"","workingDir":"","restart":"","privileged":false,"stdinOpen":false}`
	spec, op := receiptFixture()
	raw, err := json.Marshal(spec)
	if err != nil || string(raw) != legacy {
		t.Fatalf("legacy spec wire changed: %s %v", raw, err)
	}
	intent, _, err := prepareCreate(spec, op)
	digest := sha256.Sum256([]byte(legacy))
	if err != nil || intent.Version != 1 || intent.ConfigDigest != hex.EncodeToString(digest[:]) {
		t.Fatalf("legacy digest changed: %+v %v", intent, err)
	}
	raw, err = json.Marshal(op)
	if err != nil || string(raw) != `{"id":"operation-1","tenantId":"tenant-1","spaceId":"space-1","computerId":"computer-1"}` {
		t.Fatalf("legacy operation wire changed: %s %v", raw, err)
	}
}

func TestCreateReceiptV2DurableReplay(t *testing.T) {
	spec, op := receiptV2Fixture()
	creates := 0
	store := createReceipts{root: t.TempDir(),
		create: func(_ context.Context, spec RunSpec) (ContainerInfo, error) {
			creates++
			return receiptInfo(spec), nil
		},
		inspect: func(context.Context, string) (ContainerInfo, error) {
			t.Fatal("committed receipt queried Docker")
			return ContainerInfo{}, nil
		},
	}
	first, err := store.run(context.Background(), spec, op)
	if err != nil {
		t.Fatal(err)
	}
	restarted := createReceipts{store.root, store.create, store.inspect}
	second, err := restarted.run(context.Background(), spec, op)
	if err != nil || second.DockerID != first.DockerID || creates != 1 {
		t.Fatalf("v2 replay: %+v %v creates=%d", second, err, creates)
	}
	status, err := restarted.status(context.Background(), receiptStatusRequest(op))
	if err != nil || status.State != "committed" || status.Container == nil || status.Container.DockerID != first.DockerID {
		t.Fatalf("v2 status: %+v %v", status, err)
	}
	if len(second.Labels) != 11 || second.Labels["private"] != "" {
		t.Fatalf("v2 label whitelist: %+v", second.Labels)
	}
	job, _, err := openCreateJob(store.root, op.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	intent, err := readCreateIntent(job)
	if err != nil || intent.Version != 2 || intent.Operation != op {
		t.Fatalf("v2 persisted identity: %+v %v", intent, err)
	}
	var raw json.RawMessage
	if err := readCreateRecord(job, "committed.json", &raw); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"environment-secret", "command-secret", "label-secret"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("v2 receipt persisted a secret")
		}
	}
}

func TestCreateReceiptV2IdentityCannotChange(t *testing.T) {
	spec, op := receiptV2Fixture()
	store := createReceipts{root: t.TempDir(),
		create: func(_ context.Context, s RunSpec) (ContainerInfo, error) { return receiptInfo(s), nil },
		inspect: func(context.Context, string) (ContainerInfo, error) {
			t.Fatal("identity mismatch queried Docker")
			return ContainerInfo{}, nil
		},
	}
	if _, err := store.run(context.Background(), spec, op); err != nil {
		t.Fatal(err)
	}
	changes := map[string]func(*CreateOperation){
		"instance":   func(o *CreateOperation) { o.InstanceID = "other" },
		"generation": func(o *CreateOperation) { o.Generation++ },
		"disk":       func(o *CreateOperation) { o.DiskID = "other" },
		"locator":    func(o *CreateOperation) { o.LocatorVersion++ },
		"node":       func(o *CreateOperation) { o.NodeIncarnation = "other" },
		"downgrade":  func(o *CreateOperation) { _, *o = receiptFixture() },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			changedSpec, changedOp := receiptV2Fixture()
			change(&changedOp)
			changedSpec.Labels = changedOp.labels("")
			delete(changedSpec.Labels, createOperationLabel)
			delete(changedSpec.Labels, createDigestLabel)
			if _, err := store.run(context.Background(), changedSpec, changedOp); !errors.Is(err, ErrCreateConflict) {
				t.Fatalf("changed v2 identity accepted: %v", err)
			}
			if _, err := store.status(context.Background(), receiptStatusRequest(changedOp)); !errors.Is(err, ErrCreateConflict) {
				t.Fatalf("changed v2 status identity accepted: %v", err)
			}
		})
	}
}

func TestCreateReceiptV2InspectionRequiresIdentityLabels(t *testing.T) {
	_, op := receiptV2Fixture()
	for key := range op.labels("") {
		t.Run(key, func(t *testing.T) {
			spec, op := receiptV2Fixture()
			intent, labeled, err := prepareCreate(spec, op)
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			job, _, err := openCreateJob(root, op.ID, true)
			if err != nil {
				t.Fatal(err)
			}
			defer job.Close()
			if err := saveCreateRecord(job, "intent.json", intent); err != nil {
				t.Fatal(err)
			}
			delete(labeled.Labels, key)
			store := createReceipts{root: root, inspect: func(context.Context, string) (ContainerInfo, error) {
				return receiptInfo(labeled), nil
			}}
			status, err := store.status(context.Background(), receiptStatusRequest(op))
			if err != nil || status.State != "unknown" || status.Container != nil {
				t.Fatalf("missing %s accepted: %+v %v", key, status, err)
			}
		})
	}
}

func TestCreateReceiptRejectsPartialV2Identity(t *testing.T) {
	for _, field := range []string{"instance", "generation", "disk", "locator", "node"} {
		t.Run(field, func(t *testing.T) {
			spec, op := receiptV2Fixture()
			switch field {
			case "instance":
				op.InstanceID = ""
			case "generation":
				op.Generation = 0
			case "disk":
				op.DiskID = ""
			case "locator":
				op.LocatorVersion = -1
			case "node":
				op.NodeIncarnation = "../other"
			}
			if _, _, err := prepareCreate(spec, op); err == nil {
				t.Fatal("partial v2 identity accepted")
			}
			if _, err := (createReceipts{}).status(context.Background(), receiptStatusRequest(op)); err == nil {
				t.Fatal("partial v2 status identity accepted")
			}
		})
	}
}

func TestCreateReceiptSidecarPurposeIsDurableIdentity(t *testing.T) {
	for _, purpose := range []string{"acp-adapter", "acp-login", "component"} {
		t.Run(purpose, func(t *testing.T) {
			spec, op := receiptV2Fixture()
			op.Purpose, spec.Labels["zakura.purpose"] = purpose, purpose
			store := createReceipts{root: t.TempDir(), create: func(_ context.Context, s RunSpec) (ContainerInfo, error) { return receiptInfo(s), nil }}
			if _, err := store.run(context.Background(), spec, op); err != nil {
				t.Fatal(err)
			}
			status, err := store.status(context.Background(), receiptStatusRequest(op))
			if err != nil || status.Container == nil || status.Container.Labels["zakura.purpose"] != purpose {
				t.Fatalf("sidecar receipt lost purpose: %+v %v", status, err)
			}
			changed := op
			changed.Purpose = ""
			if _, err := store.status(context.Background(), receiptStatusRequest(changed)); !errors.Is(err, ErrCreateConflict) {
				t.Fatalf("sidecar was accepted as workspace: %v", err)
			}
			spec.Labels["zakura.purpose"] = "workspace"
			if err := ValidateCreate(spec, op); err == nil {
				t.Fatal("mismatched purpose label accepted")
			}
		})
	}
	for _, fixture := range []func() (RunSpec, CreateOperation){receiptFixture, receiptV2Fixture} {
		spec, op := fixture()
		op.Purpose = "arbitrary"
		spec.Labels["zakura.purpose"] = op.Purpose
		if err := ValidateCreate(spec, op); err == nil {
			t.Fatal("unrecognized purpose accepted")
		}
	}
	spec, op := receiptFixture()
	op.Purpose, spec.Labels["zakura.purpose"] = "acp-adapter", "acp-adapter"
	if err := ValidateCreate(spec, op); err == nil {
		t.Fatal("legacy operation accepted a sidecar")
	}
}

func TestCreateReceiptRejectsWrongStoredVersion(t *testing.T) {
	for _, fixture := range []func() (RunSpec, CreateOperation){receiptFixture, receiptV2Fixture} {
		for _, version := range []int{0, 1, 2, 3} {
			spec, op := fixture()
			intent, _, err := prepareCreate(spec, op)
			if err != nil {
				t.Fatal(err)
			}
			intent.Version = version
			job, _, err := openCreateJob(t.TempDir(), op.ID, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := saveCreateRecord(job, "intent.json", intent); err != nil {
				job.Close()
				t.Fatal(err)
			}
			_, err = readCreateIntent(job)
			job.Close()
			if (err == nil) != (version == op.version()) {
				t.Fatalf("operation v%d stored as v%d: %v", op.version(), version, err)
			}
		}
	}
}
