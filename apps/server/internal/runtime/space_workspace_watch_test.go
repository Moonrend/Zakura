// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestSpaceWorkspaceOpenConnectionRevalidation(t *testing.T) {
	for _, kind := range []string{"desktop", "terminal"} {
		for _, scenario := range []string{"valid", "redemption-expired", "revoked-key", "revoked-session", "removed-member", "oauth-expired", "changed-container", "changed-node", "migrating", "deleted-space", "offline-node"} {
			t.Run(kind+"/"+scenario, func(t *testing.T) {
				rig := newWorkspaceProxyRig(t)
				actor := acpLoginPrincipal()
				if scenario == "revoked-session" || scenario == "removed-member" || scenario == "oauth-expired" {
					actor = connectionTicketUser(t, rig.h)
					if scenario == "oauth-expired" {
						actor.OAuth, actor.OAuthScope, actor.OAuthExpiresAt = true, "api", rig.h.store.now().Add(time.Minute)
					}
				}
				token := rig.issueAs(t, kind, actor)
				target, lease, ctx, err := rig.h.consumeSpaceWorkspaceTicket(context.Background(), token, rig.space.ID, kind)
				if err != nil {
					t.Fatal(err)
				}
				lease.release()
				switch scenario {
				case "redemption-expired", "oauth-expired":
					clock := rig.h.deps.Clock
					rig.h.deps.Clock = func() time.Time { return clock().Add(2 * time.Minute) }
				case "revoked-key":
					err = rig.h.deps.Gorm.Table("api_keys").Where("id=?", actor.APIKeyID).Update("revoked_at", runtimeTimeString(rig.h.store.now())).Error
				case "revoked-session":
					err = rig.h.deps.Gorm.Table("user_sessions").Where("id=?", actor.SessionID).Update("revoked_at", runtimeTimeString(rig.h.store.now())).Error
				case "removed-member":
					err = rig.h.deps.Gorm.Table("tenant_memberships").Where("user_id=?", actor.UserID).Update("status", "removed").Error
				case "changed-container":
					rig.mu.Lock()
					rig.container.DockerID = "replacement"
					rig.mu.Unlock()
				case "changed-node":
					err = rig.h.deps.Gorm.Table("spaces").Where("id=?", rig.space.ID).Update("runtime_node_id", "replacement").Error
				case "migrating":
					migration, e := rig.h.acquireSpaceWorkspace(ctx, "tenant", rig.space.ID, "migrating", false, nil)
					err = e
					if migration != nil {
						defer migration.release()
					}
				case "deleted-space":
					err = rig.h.deps.Gorm.Table("spaces").Where("id=?", rig.space.ID).Delete(nil).Error
				case "offline-node":
					target.runner.ready.Store(false)
				}
				if err != nil {
					t.Fatal(err)
				}
				valid := scenario == "valid" || scenario == "redemption-expired"
				if err := rig.h.recheckSpaceWorkspaceConnection(ctx, target, kind); (err == nil) != valid {
					t.Fatalf("connection recheck=%v valid=%v", err, valid)
				}
				if !valid {
					server, client := net.Pipe()
					defer server.Close()
					defer client.Close()
					bridge := &workspaceBridge{conn: server, rw: bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), done: make(chan struct{})}
					ticks := make(chan time.Time, 1)
					ticks <- time.Now()
					finished := make(chan struct{})
					go func() {
						defer close(finished)
						rig.h.watchSpaceWorkspaceConnection(ctx, bridge, target, kind, ticks)
					}()
					select {
					case <-finished:
					case <-time.After(time.Second):
						t.Fatal("revocation did not close the connection")
					}
					_ = client.SetReadDeadline(time.Now().Add(time.Second))
					if _, err := client.Read(make([]byte, 1)); err != io.EOF {
						t.Fatalf("revoked socket is still open: %v", err)
					}
				}
				rig.mu.Lock()
				defer rig.mu.Unlock()
				for _, call := range rig.calls {
					if call.method == "docker.exec.start" || call.method == "host.pty.start" || call.method == "docker.create" {
						t.Fatalf("revalidation allocated a resource: %s", call.method)
					}
				}
			})
		}
	}
}
