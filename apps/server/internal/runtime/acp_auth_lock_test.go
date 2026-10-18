// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestACPAuthLockFencesProfileWriters(t *testing.T) {
	d := testDeps(t)
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()
	if err := h.acquireACPAuthLock(ctx, "tenant", "space", "codex", "terminal-pending", "first", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := h.acquireACPAuthLock(ctx, "tenant", "space", "codex", "device", "second", time.Minute); !errors.Is(err, errACPAuthBusy) {
		t.Fatalf("overlapping login accepted: %v", err)
	}
	if err := h.renewACPAuthLock(ctx, "tenant", "space", "codex", "second", time.Minute); !errors.Is(err, errACPAuthLockLost) {
		t.Fatalf("foreign renewal accepted: %v", err)
	}
	if err := h.releaseACPAuthLock(ctx, "tenant", "space", "codex", "second"); err != nil {
		t.Fatal(err)
	}
	if err := h.renewACPAuthLock(ctx, "tenant", "space", "codex", "first", time.Minute); err != nil {
		t.Fatalf("foreign release removed owner: %v", err)
	}
	if _, err := d.DB.ExecContext(ctx, `UPDATE acp_profile_auth_locks SET expires_at=0`); err != nil {
		t.Fatal(err)
	}
	if err := h.renewACPAuthLock(ctx, "tenant", "space", "codex", "first", time.Minute); !errors.Is(err, errACPAuthLockLost) {
		t.Fatalf("expired owner resurrected: %v", err)
	}
	if err := h.acquireACPAuthLock(ctx, "tenant", "space", "codex", "device", "second", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := h.releaseACPAuthLock(ctx, "tenant", "space", "codex", "first"); err != nil {
		t.Fatal(err)
	}
	if err := h.renewACPAuthLock(ctx, "tenant", "space", "codex", "second", time.Minute); err != nil {
		t.Fatalf("stale owner removed replacement: %v", err)
	}
	if err := h.acquireACPAuthLock(ctx, "tenant", "other", "codex", "terminal", "third", time.Minute); err != nil {
		t.Fatalf("unrelated Space blocked: %v", err)
	}
}
