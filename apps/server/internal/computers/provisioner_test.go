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
	create  func(context.Context, Runtime) (string, error)
	find    func(context.Context, Runtime) (string, error)
}

func (s *creationStub) Create(ctx context.Context, r Runtime) (string, error) {
	s.creates.Add(1)
	return s.create(ctx, r)
}
func (s *creationStub) Find(ctx context.Context, r Runtime) (string, error) {
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
	stub := &creationStub{create: func(ctx context.Context, r Runtime) (string, error) {
		if r.State != Creating || r.CreateOperationID == "" || r.TenantID != "tenant" {
			return "", errors.New("identity missing")
		}
		close(entered)
		<-release
		return "vm1", nil
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
			stub := &creationStub{create: func(context.Context, Runtime) (string, error) {
				if emptyResult {
					return "", nil
				}
				return "", errors.New("secret-api-key-in-provider-response")
			}, find: func(context.Context, Runtime) (string, error) { return "", nil }}
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
			stub.find = func(_ context.Context, observed Runtime) (string, error) {
				if observed.CreateOperationID != r.CreateOperationID || observed.Incarnation != r.Incarnation {
					t.Fatal("reconciliation identity changed")
				}
				return "recovered-vm", nil
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
	stub := &creationStub{create: func(context.Context, Runtime) (string, error) { cancel(); return "vm-after-disconnect", nil }}
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
	stub := &creationStub{find: func(context.Context, Runtime) (string, error) { return "observed-vm", nil }}
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
