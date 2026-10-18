// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func requireSkillWriteLeases(t *testing.T, h *handler, space string, want int64) {
	t.Helper()
	var count int64
	if err := h.deps.Gorm.Table("computer_workspace_leases").Where("tenant_id=? AND space_id=?", "tenant", space).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("writer leases=%d want %d", count, want)
	}
}

func TestSkillsStageHoldsLocalWriterUntilCommitOrRollback(t *testing.T) {
	for _, commit := range []bool{true, false} {
		t.Run(map[bool]string{true: "commit", false: "rollback"}[commit], func(t *testing.T) {
			h, s := skillTestHandler(t)
			ctx := context.Background()
			finish, err := h.stageSkill(ctx, "tenant", s.ID, "review", []skillFile{{Path: "SKILL.md", Content: "new"}}, false, false)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = finish(false) })
			requireSkillWriteLeases(t, h, s.ID, 1)
			if _, _, err = h.claimSharedWorkspaceWrite(ctx, "tenant", s.ID); err == nil {
				t.Fatal("second local writer bypassed held claim")
			}
			if _, err = h.acquireSpaceWorkspace(ctx, "tenant", s.ID, "migrating", false, nil); err == nil {
				t.Fatal("migration bypassed staged writer")
			}
			if err = finish(commit); err != nil {
				t.Fatal(err)
			}
			if err = finish(!commit); err != nil {
				t.Fatal(err)
			}
			requireSkillWriteLeases(t, h, s.ID, 0)
			_, statErr := os.Stat(filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "review", "SKILL.md"))
			if commit && statErr != nil {
				t.Fatal(statErr)
			}
			if !commit && !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("rollback retained new directory: %v", statErr)
			}
			_, release, err := h.claimSharedWorkspaceWrite(ctx, "tenant", s.ID)
			if err != nil {
				t.Fatal(err)
			}
			release(nil)
		})
	}
}

func TestSkillsSnapshotLeasePrecedesTransactionAndBlocksLifecycle(t *testing.T) {
	h, s := skillTestHandler(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: "review", Files: []skillFile{{Path: "SKILL.md", Content: "one"}}}, json.RawMessage(`{"kind":"upload"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := h.acquireSpaceWorkspace(ctx, "tenant", s.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.installSpaceSnapshot(ctx, "tenant", s.ID, skill); err == nil {
		t.Fatal("install bypassed migration claim")
	}
	lease.release()
	row, err := h.installSpaceSnapshot(ctx, "tenant", s.ID, skill)
	if err != nil {
		t.Fatal(err)
	}
	requireSkillWriteLeases(t, h, s.ID, 0)
	lease, err = h.acquireSpaceWorkspace(ctx, "tenant", s.ID, "migrating", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.replaceSpaceSnapshot(ctx, row, nil, nil, true); err == nil {
		t.Fatal("uninstall bypassed migration claim")
	}
	lease.release()
	if err = h.replaceSpaceSnapshot(ctx, row, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	requireSkillWriteLeases(t, h, s.ID, 0)
}

func TestSkillsStageRemoteMutationErrorRetainsOuterLease(t *testing.T) {
	h, s := skillTestHandler(t)
	insertRuntimeNode(t, h.deps, "node", "tenant", "offline")
	if err := h.deps.Gorm.Table("spaces").Where("id=?", s.ID).Update("runtime_node_id", "node").Error; err != nil {
		t.Fatal(err)
	}
	ctx, finishWrite, err := h.claimSharedWorkspaceWrite(context.Background(), "tenant", s.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A failed runner response is deliberately conservative: no transport error
	// proves whether a previously transmitted mutation reached the remote node.
	done := make(chan struct{})
	close(done)
	runner := &runnerSession{hub: &runnerHub{}, done: done}
	ctx = context.WithValue(ctx, skillWorkspaceKey{}, &skillWorkspace{remote: &remoteWorkspace{runner: runner, spaceID: s.ID}})
	if _, err = h.stageSkill(ctx, "tenant", s.ID, "review", nil, false, false); err == nil {
		t.Fatal("offline mutation unexpectedly succeeded")
	}
	// Nested completion only memoizes uncertainty. The owner persists it after
	// any snapshot transaction has released its Space row lock.
	requireSkillWriteLeases(t, h, s.ID, 1)
	finishWrite(nil)
	requireSkillWriteLeases(t, h, s.ID, 1)
	var raw string
	if err = h.deps.Gorm.Table("computer_workspace_leases").Select("intent_json").Where("space_id=?", s.ID).Scan(&raw).Error; err != nil {
		t.Fatal(err)
	}
	var intent workspaceIntent
	if err = json.Unmarshal([]byte(raw), &intent); err != nil || !intent.Uncertain {
		t.Fatalf("uncertain effect not retained: %q %v", raw, err)
	}
	if _, _, err = h.claimSharedWorkspaceWrite(context.Background(), "tenant", s.ID); err == nil {
		t.Fatal("writer bypassed retained remote effect")
	}
}
