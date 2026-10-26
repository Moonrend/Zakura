package computers

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type creationStub struct {
	creates atomic.Int32
	finds   atomic.Int32
	create  func(context.Context, Runtime) (CreationResult, error)
	find    func(context.Context, Runtime) (CreationResult, error)
}

func (s *creationStub) Create(ctx context.Context, r Runtime) (CreationResult, error) {
	s.creates.Add(1)
	return s.create(ctx, r)
}
func (s *creationStub) Find(ctx context.Context, r Runtime) (CreationResult, error) {
	s.finds.Add(1)
	return s.find(ctx, r)
}
func provisionFixture(t *testing.T, stub *creationStub) (Provisioner, Runtime, Target) {
	t.Helper()
	store := testStore(t)
	now := time.Now().UTC()
	r, err := store.ReserveRuntime(context.Background(), "tenant", "space", "computer-space", "chat-space", now)
	if err != nil {
		t.Fatal(err)
	}
	target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
	return Provisioner{Store: store, Providers: map[Provider]CreationProvider{E2B: stub}, Now: func() time.Time { return now }}, r, target
}

func TestProvisionerApprovalAndSingleCreate(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	stub := &creationStub{create: func(ctx context.Context, r Runtime) (CreationResult, error) {
		if r.State != Creating || r.CreateOperationID == "" || r.TenantID != "tenant" {
			return CreationResult{}, errors.New("identity missing")
		}
		close(entered)
		<-release
		return CreationResult{ExternalID: "vm1"}, nil
	}}
	p, r, target := provisionFixture(t, stub)
	ctx := context.Background()
	if _, err := p.ReconcileCreation(ctx, target); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("unapproved reconciliation: %v", err)
	}
	if _, err := p.ApproveAndCreate(ctx, target, r.CreateOperationID, ""); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("empty actor: %v", err)
	}
	if _, err := p.ApproveAndCreate(ctx, target, "wrong", "admin"); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("wrong operation: %v", err)
	}
	wrong := target
	wrong.TenantID = "other"
	if _, err := p.ApproveAndCreate(ctx, wrong, r.CreateOperationID, "admin"); err == nil {
		t.Fatal("cross tenant create")
	}
	if stub.creates.Load() != 0 || stub.finds.Load() != 0 {
		t.Fatal("provider called before approval")
	}
	done := make(chan error, 1)
	go func() { _, err := p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin"); done <- err }()
	<-entered
	_, duplicateErr := p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin")
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if duplicateErr == nil || stub.creates.Load() != 1 {
		t.Fatal("duplicate provider creation")
	}
	current, err := p.ReconcileCreation(ctx, target)
	if err != nil || current.ExternalID != "vm1" || stub.finds.Load() != 0 {
		t.Fatalf("ready reconciliation: %+v %v", current, err)
	}
}

func TestProvisionerUncertainCreationNeverRetries(t *testing.T) {
	for _, emptyResult := range []bool{false, true} {
		t.Run(map[bool]string{false: "network-error", true: "empty-instance"}[emptyResult], func(t *testing.T) {
			stub := &creationStub{create: func(context.Context, Runtime) (CreationResult, error) {
				if emptyResult {
					return CreationResult{}, nil
				}
				return CreationResult{}, errors.New("secret-api-key-in-provider-response")
			}, find: func(context.Context, Runtime) (CreationResult, error) { return CreationResult{}, nil }}
			p, r, target := provisionFixture(t, stub)
			ctx := context.Background()
			current, err := p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin")
			if !errors.Is(err, ErrCreationUncertain) || strings.Contains(err.Error(), "secret-api-key") || current.State != Unknown {
				t.Fatalf("uncertain: %+v %v", current, err)
			}
			if _, err = p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin"); err == nil {
				t.Fatal("retry created")
			}
			if _, err = p.ReconcileCreation(ctx, target); !errors.Is(err, ErrCreationUncertain) {
				t.Fatalf("not found: %v", err)
			}
			stub.find = func(_ context.Context, observed Runtime) (CreationResult, error) {
				if observed.CreateOperationID != r.CreateOperationID || observed.Incarnation != r.Incarnation {
					t.Fatal("reconciliation identity changed")
				}
				return CreationResult{ExternalID: "recovered-vm"}, nil
			}
			current, err = p.ReconcileCreation(ctx, target)
			if err != nil || current.State != Ready || current.ExternalID != "recovered-vm" || stub.creates.Load() != 1 {
				t.Fatalf("recovery: %+v %v", current, err)
			}
		})
	}
}

func TestProvisionerPersistsAfterClientCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stub := &creationStub{create: func(context.Context, Runtime) (CreationResult, error) {
		cancel()
		return CreationResult{ExternalID: "vm-after-disconnect"}, nil
	}}
	p, r, target := provisionFixture(t, stub)
	current, err := p.ApproveAndCreate(ctx, target, r.CreateOperationID, "admin")
	if err != nil || current.ExternalID != "vm-after-disconnect" || current.State != Ready {
		t.Fatalf("lost instance: %+v %v", current, err)
	}
}

func TestProvisionerUnavailableDoesNotConsumeApproval(t *testing.T) {
	p, r, target := provisionFixture(t, &creationStub{})
	p.Providers = nil
	if _, err := p.ApproveAndCreate(context.Background(), target, r.CreateOperationID, "admin"); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatal(err)
	}
	current, err := p.Store.GetRuntime(context.Background(), target)
	if err != nil || current.State != PendingApproval {
		t.Fatalf("approval consumed: %+v %v", current, err)
	}
}

func TestProvisionerReconcilesCrashAfterApproval(t *testing.T) {
	stub := &creationStub{find: func(context.Context, Runtime) (CreationResult, error) {
		return CreationResult{ExternalID: "observed-vm"}, nil
	}}
	p, r, target := provisionFixture(t, stub)
	ctx := context.Background()
	if err := p.Store.ApproveCreation(ctx, target, r.CreateOperationID, "admin", p.now()); err != nil {
		t.Fatal(err)
	}
	current, err := p.ReconcileCreation(ctx, target)
	if err != nil || current.ExternalID != "observed-vm" || stub.creates.Load() != 0 {
		t.Fatalf("restart: %+v %v", current, err)
	}
}

func replacementFixture(t *testing.T, provider Provider, stub *creationStub, state State) (Provisioner, Store, Runtime, Target) {
	t.Helper()
	store := testStore(t)
	now := time.Now().UTC()
	scope := ""
	if (Computer{Provider: provider}).SessionScoped() {
		scope = "chat-space"
	}
	execTest(t, store, `INSERT INTO computers(id,tenant_id,space_id,name,provider,runtime_node_id,idle_seconds,max_lifetime_seconds,created_at,updated_at) VALUES('rc','tenant','space','RC',?,'node',900,3600,'now','now')`, string(provider))
	execTest(t, store, `INSERT INTO computer_runtimes(id,tenant_id,space_id,computer_id,session_scope,incarnation,create_operation_id,state,created_at,updated_at) VALUES('rt','tenant','space','rc',?,'inc','op',?,'now','now')`, scope, string(state))
	execTest(t, store, `INSERT INTO computer_creation_approvals(runtime_id,create_operation_id,approved_by,approved_at) VALUES('rt','op','admin',?)`, now.Format(time.RFC3339Nano))
	r := Runtime{ID: "rt", TenantID: "tenant", SpaceID: "space", ComputerID: "rc", SessionScope: scope, Incarnation: "inc", CreateOperationID: "op", State: state}
	target := Target{TenantID: "tenant", SpaceID: "space", ComputerID: "rc", RuntimeID: "rt", Incarnation: "inc"}
	p := Provisioner{Store: store, Providers: map[Provider]CreationProvider{provider: stub}, Now: func() time.Time { return now }}
	return p, store, r, target
}

func TestPrepareReplacementRejectsActiveRuntime(t *testing.T) {
	stub := &creationStub{}
	p, _, _, target := replacementFixture(t, Server, stub, Ready)
	if _, err := p.PrepareReplacement(context.Background(), target, "admin"); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("ready replacement: %v", err)
	}
	if stub.finds.Load() != 0 || stub.creates.Load() != 0 {
		t.Fatal("provider was called for a non-terminal runtime")
	}
}

func TestPrepareReplacementCompletesExistingInstance(t *testing.T) {
	stub := &creationStub{find: func(context.Context, Runtime) (CreationResult, error) {
		return CreationResult{ExternalID: "live-vm"}, nil
	}}
	p, store, r, target := replacementFixture(t, Server, stub, Unknown)
	current, err := p.PrepareReplacement(context.Background(), target, "admin")
	if err != nil || current.State != Ready || current.ExternalID != "live-vm" || stub.creates.Load() != 0 || current.ID != r.ID {
		t.Fatalf("existing instance: %+v %v", current, err)
	}
	var count int
	if err := store.DB.QueryRow(`SELECT COUNT(*) FROM computer_runtimes WHERE computer_id='rc'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("existing instance was replaced: %d %v", count, err)
	}
}

func TestPrepareReplacementReservesWhenAbsent(t *testing.T) {
	stub := &creationStub{find: func(context.Context, Runtime) (CreationResult, error) {
		return CreationResult{}, nil
	}}
	p, store, r, target := replacementFixture(t, Temporary, stub, Unknown)
	current, err := p.PrepareReplacement(context.Background(), target, "admin")
	if err != nil || current.State != PendingApproval || current.ID == r.ID || stub.creates.Load() != 0 {
		t.Fatalf("absent replacement: %+v %v", current, err)
	}
	var prior string
	if err := store.DB.QueryRow(`SELECT state FROM computer_runtimes WHERE id='rt'`).Scan(&prior); err != nil || prior != string(Failed) {
		t.Fatalf("old runtime not failed: %q %v", prior, err)
	}
}

func TestPrepareReplacementCloudIsManual(t *testing.T) {
	stub := &creationStub{find: func(context.Context, Runtime) (CreationResult, error) {
		return CreationResult{ExternalID: "never-dialed"}, nil
	}}
	p, store, _, target := replacementFixture(t, E2B, stub, Unknown)
	if _, err := p.PrepareReplacement(context.Background(), target, "admin"); !errors.Is(err, ErrReplaceUnavailable) {
		t.Fatalf("cloud replacement: %v", err)
	}
	if stub.finds.Load() != 0 {
		t.Fatal("cloud Find was dialed")
	}
	var state string
	if err := store.DB.QueryRow(`SELECT state FROM computer_runtimes WHERE id='rt'`).Scan(&state); err != nil || state != string(Unknown) {
		t.Fatalf("cloud runtime was touched: %q %v", state, err)
	}
}
