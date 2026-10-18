package computers

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestOwnerDeletionBlocksReservationReplacementAndApproval(t *testing.T) {
	for _, owner := range []string{"space", "computer"} {
		t.Run(owner, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			now := time.Now()
			r, err := s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now)
			if err != nil {
				t.Fatal(err)
			}
			target := Target{TenantID: r.TenantID, SpaceID: r.SpaceID, ComputerID: r.ComputerID, RuntimeID: r.ID, Incarnation: r.Incarnation}
			if owner == "space" {
				execTest(t, s, `UPDATE spaces SET deletion_pending=TRUE WHERE id='space'`)
			} else {
				execTest(t, s, `UPDATE computers SET deletion_pending=TRUE WHERE id='computer-space'`)
			}
			if _, err = s.ReserveRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now); !errors.Is(err, ErrOwnerDeleting) {
				t.Fatalf("reserve during deletion: %v", err)
			}
			if _, err = s.ReserveReplacementRuntime(ctx, "tenant", "space", "computer-space", "chat-space", now); !errors.Is(err, ErrOwnerDeleting) {
				t.Fatalf("replacement during deletion: %v", err)
			}
			if err = s.ApproveCreation(ctx, target, r.CreateOperationID, "owner", now); !errors.Is(err, ErrOwnerDeleting) {
				t.Fatalf("approve during deletion: %v", err)
			}
			if err = s.CompleteCreation(ctx, target, r.CreateOperationID, CreationResult{ExternalID: "late-sandbox"}, now); !errors.Is(err, ErrOwnerDeleting) {
				t.Fatalf("late creation completion bypassed deletion fence: %v", err)
			}
			got, err := s.GetRuntime(ctx, target)
			if err != nil || got.State != PendingApproval {
				t.Fatalf("approval mutated runtime: %+v %v", got, err)
			}
			var count int
			if err = s.DB.QueryRow(`SELECT COUNT(*) FROM computer_creation_approvals WHERE runtime_id=?`, r.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("approval count=%d %v", count, err)
			}
		})
	}
}
