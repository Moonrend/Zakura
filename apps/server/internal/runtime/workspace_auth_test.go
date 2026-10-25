package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/workspaces"
)

func TestWorkspaceAuthRetirementTransfersWriters(t *testing.T) {
	for _, state := range []string{"terminal-pending", "terminal", "protocol", "pending", "persisting", "unknown"} {
		t.Run(state, func(t *testing.T) {
			rig := newDeviceTestRig(t)
			h, ctx := rig.h, context.Background()
			old := attachTestWorkspace(t, h, rig.space.ID, "auth-old-disk", "auth-old")
			exec, err := h.resolveServerComputer(ctx, "tenant", rig.space.ID)
			if err != nil {
				t.Fatal(err)
			}
			token := "old-terminal-owner"
			var attempt *acpDeviceAttempt
			if state == "pending" || state == "persisting" || state == "unknown" {
				started := rig.start(t)
				a, err := h.acpDeviceLoad(ctx, "user", "tenant", rig.space.ID, "codex", started.AttemptID)
				if err != nil {
					t.Fatal(err)
				}
				if a.WorkspaceInstanceID != old.InstanceID || a.WorkspaceGeneration != old.Generation {
					t.Fatal("device attempt did not retain its original instance")
				}
				if state != "pending" {
					if err := h.acpDeviceCAS(ctx, &a, map[string]any{"status": state}); err != nil {
						t.Fatal(err)
					}
				}
				attempt, token = &a, a.ID
			} else if err := h.acquireACPAuthLock(ctx, "tenant", rig.space.ID, "codex", state, token, time.Minute, exec); err != nil {
				t.Fatal(err)
			}
			lease, err := h.acquireSpaceInfrastructure(ctx, "tenant", rig.space.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err := lease.bindSharedProfile(ctx, "codex"); err != nil {
				t.Fatal(err)
			}
			if _, err := h.deps.DB.Exec(`UPDATE acp_profile_auth_locks SET expires_at=0 WHERE space_id=?`, rig.space.ID); err != nil {
				t.Fatal(err)
			}
			recovery, err := h.loadACPAuthRecovery(ctx, "tenant", rig.space.ID, "codex")
			if err != nil || recovery.WorkspaceInstanceID != old.InstanceID || recovery.WorkspaceGeneration != old.Generation {
				t.Fatalf("recovery lost original identity: %v", err)
			}
			if err := h.reconcileACPAuthentication(ctx, "tenant", rig.space.ID, "codex", recovery.recoveryToken()); err == nil || !strings.Contains(err.Error(), "retaining its disk") {
				t.Fatalf("unconfirmed writer was released using inventory: %v", err)
			}
			// A handler with no connected node must still commit logical retirement.
			offline := &handler{deps: h.deps, store: h.store}
			cleanup, err := offline.workspaceStore().Retire(ctx, old.Target, "auth-retire", "auth-cleanup", false, h.store.now())
			if err != nil {
				t.Fatal(err)
			}
			if !cleanup.Pending || len(cleanup.Snapshot.Authentication) != 1 || len(cleanup.Snapshot.Lease) == 0 {
				t.Fatal("authentication evidence was not transferred")
			}
			raw, err := json.Marshal(cleanup.Snapshot)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"old-terminal-owner", "encrypted_payload", "user_code", "verification_uri", "server-device-secret", "ABCD-EFGH"} {
				if strings.Contains(string(raw), secret) {
					t.Fatal("cleanup snapshot retained authentication secrets")
				}
			}
			if attempt != nil {
				if len(cleanup.Snapshot.DeviceAttempts) != 1 {
					t.Fatal("device writer evidence missing")
				}
				stored, err := h.acpDeviceLoad(ctx, "user", "tenant", rig.space.ID, "codex", attempt.ID)
				if err != nil || stored.Status != "cancelled" || stored.Version != attempt.Version+1 || stored.EncryptedPayload != "" || stored.UserCode != "" || stored.VerificationURI != "" {
					t.Fatalf("retirement did not cancel and clear device attempt: %v", err)
				}
			}
			disk, err := h.workspaceStore().Disk(ctx, "tenant", rig.space.ID, old.DiskID)
			if err != nil || disk.State != "release_pending" || disk.AttachedInstanceID == nil || *disk.AttachedInstanceID != old.InstanceID {
				t.Fatalf("logical retirement released disk: %v", err)
			}
			next := attachTestWorkspace(t, h, rig.space.ID, "auth-new-disk", "auth-new")
			fresh := rig.start(t)
			if err := h.renewACPAuthLock(ctx, "tenant", rig.space.ID, "codex", token, time.Minute); !errors.Is(err, errACPAuthLockLost) {
				t.Fatalf("old lock renewed: %v", err)
			}
			if err := h.activateACPTerminalAuthLock(ctx, "tenant", rig.space.ID, "codex", token); !errors.Is(err, errACPAuthLockLost) {
				t.Fatalf("old terminal activated: %v", err)
			}
			if err := h.acquireACPAuthLock(ctx, "tenant", rig.space.ID, "codex", "protocol", "late-owner", time.Minute, exec); !errors.Is(err, workspaces.ErrTargetRevoked) {
				t.Fatalf("old target acquired replacement lock: %v", err)
			}
			if err := h.acquireACPAuthLock(ctx, "tenant", rig.space.ID, "other", "protocol", "unbound", time.Minute); !errors.Is(err, workspaces.ErrTargetRevoked) {
				t.Fatalf("managed authentication accepted no target: %v", err)
			}
			if _, err := h.claimACPAuthRecovery(ctx, "tenant", rig.space.ID, "codex", recovery); !errors.Is(err, errACPAuthLockLost) {
				t.Fatalf("old recovery claimed replacement: %v", err)
			}
			accepted := context.WithValue(ctx, workspaceRequestTargetKey{}, lease.Space)
			if _, err := h.acquireSpaceInfrastructure(accepted, "tenant", rig.space.ID); !errors.Is(err, errWorkspaceLeaseLost) {
				t.Fatalf("old request claimed replacement infrastructure: %v", err)
			}
			if err := lease.bindSharedProfile(ctx, "late-profile"); !errors.Is(err, errWorkspaceLeaseLost) {
				t.Fatalf("old profile callback changed current lease: %v", err)
			}
			lease.release()
			if attempt != nil {
				if err := h.acpDeviceFinish(ctx, attempt, "succeeded", ""); !errors.Is(err, errACPDeviceConflict) {
					t.Fatalf("old device callback committed: %v", err)
				}
				if _, err := h.validateACPDeviceTarget(ctx, *attempt); err == nil {
					t.Fatal("old attempt followed replacement")
				}
			}
			if err := h.releaseACPAuthLock(ctx, "tenant", rig.space.ID, "codex", token); err != nil {
				t.Fatal(err)
			}
			current, err := h.loadACPAuthRecovery(ctx, "tenant", rig.space.ID, "codex")
			if err != nil || current.Token != fresh.AttemptID || current.WorkspaceInstanceID != next.InstanceID || current.WorkspaceToken != "" {
				t.Fatalf("late callbacks altered replacement authentication: %v", err)
			}
			claimed, err := h.workspaceStore().ClaimCleanup(ctx, "tenant", rig.space.ID, cleanup.ID, "release-owner", h.store.now())
			if err != nil {
				t.Fatal(err)
			}
			if err := h.workspaceStore().CompleteRelease(ctx, claimed, old.Target, h.store.now()); err != nil {
				t.Fatal(err)
			}
			disk, err = h.workspaceStore().Disk(ctx, "tenant", rig.space.ID, old.DiskID)
			if err != nil || disk.State != "available" || disk.AttachedInstanceID != nil {
				t.Fatalf("acknowledged disk did not become available: %v", err)
			}
			if err := h.renewACPAuthLock(ctx, "tenant", rig.space.ID, "codex", fresh.AttemptID, time.Minute); err != nil {
				t.Fatal("old cleanup removed new authentication", err)
			}
		})
	}
}

func TestWorkspaceAuthRetirementRejectsUnboundEvidence(t *testing.T) {
	for _, change := range []string{"workspace_instance_id=''", "workspace_generation=999", "node_id='another'", "computer_id='another'"} {
		t.Run(change, func(t *testing.T) {
			rig := newDeviceTestRig(t)
			h, ctx := rig.h, context.Background()
			old := attachTestWorkspace(t, h, rig.space.ID, "unbound-disk", "unbound-instance")
			a := rig.start(t)
			if _, err := h.deps.DB.Exec(`UPDATE acp_profile_auth_locks SET `+change+` WHERE space_id=?`, rig.space.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := h.workspaceStore().Retire(ctx, old.Target, "unbound-retire", "unbound-cleanup", false, h.store.now()); !errors.Is(err, workspaces.ErrConflict) {
				t.Fatalf("unbound authentication was discarded: %v", err)
			}
			current, err := h.workspaceStore().Current(ctx, "tenant", rig.space.ID)
			if err != nil || current.Target != old.Target {
				t.Fatalf("rejected retirement changed current instance: %v", err)
			}
			stored, err := h.acpDeviceLoad(ctx, "user", "tenant", rig.space.ID, "codex", a.AttemptID)
			if err != nil || stored.Status != "pending" || stored.EncryptedPayload == "" {
				t.Fatalf("rejected retirement partially cancelled device: %v", err)
			}
		})
	}
}

func TestWorkspaceAuthRetirementFencesInFlightDevicePoll(t *testing.T) {
	rig := newDeviceTestRig(t)
	h, ctx := rig.h, context.Background()
	old := attachTestWorkspace(t, h, rig.space.ID, "poll-old-disk", "poll-old")
	entered, release := make(chan struct{}), make(chan struct{})
	rig.poll = func(*http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return deviceResponse(200, `{"authorization_code":"authorization-secret","code_verifier":"verifier-secret"}`), nil
	}
	a := rig.start(t)
	rig.advance(6 * time.Second)
	finished := make(chan error, 1)
	go func() {
		_, err := h.pollACPDeviceAttempt(ctx, "user", "tenant", rig.space.ID, "codex", a.AttemptID)
		finished <- err
	}()
	defer func() {
		close(release)
		select {
		case err := <-finished:
			if !errors.Is(err, errACPDeviceConflict) {
				t.Errorf("late polling response was accepted: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("device poll did not complete")
		}
		if rig.writes.Load() != 0 || rig.exchanges.Load() != 0 {
			t.Error("retired poll redeemed or wrote credentials")
		}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("device poll did not start")
	}
	if _, err := h.workspaceStore().Retire(ctx, old.Target, "poll-retire", "poll-cleanup", false, h.store.now()); err != nil {
		t.Fatal(err)
	}
	attachTestWorkspace(t, h, rig.space.ID, "poll-new-disk", "poll-new")
	fresh := rig.start(t)
	if fresh.AttemptID == a.AttemptID {
		t.Fatal("replacement reused old attempt")
	}
}
