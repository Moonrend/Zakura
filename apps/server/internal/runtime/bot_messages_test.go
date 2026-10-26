// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func seedBotUser(t *testing.T, store *Store) {
	t.Helper()
	now := runtimeTimeString(store.now())
	if err := store.deps.Gorm.Exec(`INSERT INTO users(id,email,password_hash,name,status,created_at,updated_at) VALUES('user','bot-user@example.test','unused','User','active',?,?)`, now, now).Error; err != nil {
		t.Fatal(err)
	}
}

func TestBotMessageDeliveryPersistsWithoutSocket(t *testing.T) {
	s, agent, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, textCompletion("Hello from bot"))
	})
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	ctx := context.Background()
	seedBotUser(t, s.store)
	actor := httpx.Principal{TenantID: "tenant", UserID: "user"}
	_, bindings, err := h.zakuraBotRoster(ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := h.zakuraBotSession(ctx, actor, agent.ID, bindings[agent.ID])
	if err != nil {
		t.Fatal(err)
	}
	run, _, err := s.Start(ctx, TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: sid, Content: "hello", MessageID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, s.store, agent.ID, sid, run.ID)
	var frames []struct {
		Frame string `gorm:"column:frame_json"`
	}
	if err := s.store.deps.Gorm.Table("zakurabot_messages").Select("frame_json").Where("agent_id=?", agent.ID).Order("seq").Find(&frames).Error; err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 {
		t.Fatalf("expected user and bot deliveries: %#v", frames)
	}
	var user, reply map[string]any
	_ = json.Unmarshal([]byte(frames[0].Frame), &user)
	_ = json.Unmarshal([]byte(frames[1].Frame), &reply)
	if user["type"] != "message" || reply["type"] != "chat_reply" {
		t.Fatalf("wrong order: %#v %#v", user, reply)
	}
	events, _ := s.store.ListEvents(ctx, "tenant", agent.ID, sid, 0, 100)
	found := false
	for _, ev := range events {
		if ev.Type == "bot_message" {
			found = true
			var p map[string]any
			_ = json.Unmarshal(ev.Payload, &p)
			if p["sourceMessageId"] == "" || p["content"] != "Hello from bot" {
				t.Fatal(p)
			}
		}
	}
	if !found {
		t.Fatal("missing bot timeline event")
	}
	var output bytes.Buffer
	socket := &zakuraBotSocket{rw: bufio.NewReadWriter(bufio.NewReader(bytes.NewReader(nil)), bufio.NewWriter(&output))}
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, bindings[agent.ID], "u1", "hello"); err != nil {
		t.Fatalf("retry did not replay: %v", err)
	}
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, bindings[agent.ID], "u1", "changed"); err == nil {
		t.Fatal("conflicting retry accepted")
	}
	var count int64
	s.store.deps.Gorm.Table("cloud_agent_runs").Where("session_id=?", sid).Count(&count)
	if count != 1 {
		t.Fatalf("duplicate run: %d", count)
	}
	if err := s.store.publishBotMessage(ctx, "tenant", agent.ID, sid, run.ID, "bot:"+run.ID, "Hello from bot", "", ""); err != nil {
		t.Fatal(err)
	}
	s.store.deps.Gorm.Table("zakurabot_messages").Where("agent_id=?", agent.ID).Count(&count)
	if count != 2 {
		t.Fatalf("duplicate delivery: %d", count)
	}
}

func TestBotMessageAttachmentsStayScopedAndReplayable(t *testing.T) {
	requests := make(chan string, 2)
	s, agent, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- string(body)
		_, _ = io.WriteString(w, textCompletion("read the file"))
	})
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	seedBotUser(t, s.store)
	ctx := context.Background()
	actor := httpx.Principal{TenantID: "tenant", UserID: "user"}
	_, bindings, _ := h.zakuraBotRoster(ctx, actor)
	binding := bindings[agent.ID]
	if err := h.deps.Gorm.Table("zakurabot_files").Create(map[string]any{"id": "file1", "tenant_id": "tenant", "device_id": "user", "binding_id": binding, "agent_id": agent.ID, "path": ".zakura/zakurabot/uploads/file1/note.txt", "name": "note.txt", "mime": "text/plain", "size": 5, "created_at": runtimeTimeString(s.store.now())}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := h.botAttachments(ctx, httpx.Principal{TenantID: "tenant", UserID: "other"}, agent.ID, binding, []botFileRef{{FileID: "file1"}}); err == nil {
		t.Fatal("another user's attachment accepted")
	}
	var output bytes.Buffer
	socket := &zakuraBotSocket{rw: bufio.NewReadWriter(bufio.NewReader(bytes.NewReader(nil)), bufio.NewWriter(&output))}
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, binding, "with-file", "read this", botFileRef{FileID: "file1"}); err != nil {
		t.Fatal(err)
	}
	sid, _ := h.zakuraBotSession(ctx, actor, agent.ID, binding)
	var run struct {
		ID string `gorm:"column:id"`
	}
	if err := h.deps.Gorm.Table("cloud_agent_runs").Select("id").Where("session_id=?", sid).Take(&run).Error; err != nil {
		t.Fatal(err)
	}
	waitForAgentRun(t, s.store, agent.ID, sid, run.ID)
	body := <-requests
	if !strings.Contains(body, "note.txt") || !strings.Contains(body, "Sender:") {
		t.Fatalf("upstream missed attachment or sender: %s", body)
	}
	var receipt struct {
		Frame string `gorm:"column:frame_json"`
	}
	h.deps.Gorm.Table("zakurabot_messages").Select("frame_json").Where("client_message_id=?", "with-file").Take(&receipt)
	if !strings.Contains(receipt.Frame, "/files/file1") || strings.Contains(receipt.Frame, ".zakura/zakurabot/uploads") {
		t.Fatalf("wrong public attachment: %s", receipt.Frame)
	}
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, binding, "with-file", "read this", botFileRef{FileID: "file1"}); err != nil {
		t.Fatal(err)
	}
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, binding, "with-file", "read this"); err == nil {
		t.Fatal("retry silently removed attachment")
	}
	if err := h.deps.Gorm.Exec("DELETE FROM zakurabot_files WHERE id=?", "file1").Error; err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, binding, "with-file", "read this", botFileRef{FileID: "file1"}); err != nil {
		t.Fatalf("accepted receipt depends on a deleted file: %v", err)
	}
	if got := readServerText(t, bufio.NewReader(&output)); got != receipt.Frame {
		t.Fatalf("receipt changed after file cleanup: %s", got)
	}
	if err := h.zakuraBotSend(ctx, socket, actor, agent.ID, binding, "new-file-message", "read this", botFileRef{FileID: "file1"}); err == nil {
		t.Fatal("new message accepted a deleted attachment")
	}
}

func TestBotMessageFailureCorrelatesWithOriginalUser(t *testing.T) {
	s, agent, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, textCompletion("ok")) })
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	seedBotUser(t, s.store)
	ctx := context.Background()
	actor := httpx.Principal{TenantID: "tenant", UserID: "user"}
	_, bindings, _ := h.zakuraBotRoster(ctx, actor)
	sid, err := h.zakuraBotSession(ctx, actor, agent.ID, bindings[agent.ID])
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.store.StartRunWith(ctx, "tenant", agent.ID, sid, runStartSpec{MessageID: "original", Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.Enqueue(ctx, "tenant", agent.ID, sid, QueueMessage{ID: "next", Content: "next task"}); err != nil {
		t.Fatal(err)
	}
	failure := "private provider diagnostic"
	if err := s.store.FinishRun(ctx, "tenant", agent.ID, sid, run.ID, "failed", &failure, nil); err != nil {
		t.Fatal(err)
	}
	// Regeneration must correlate to the original user, too.
	retry, err := s.store.StartRunWith(ctx, "tenant", agent.ID, sid, runStartSpec{SkipUserMessage: true, ReplyTo: "original"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.FinishRun(ctx, "tenant", agent.ID, sid, retry.ID, "failed", &failure, nil); err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Frame string `gorm:"column:frame_json"`
	}
	if err := h.deps.Gorm.Table("zakurabot_messages").Select("frame_json").Where("agent_id=?", agent.ID).Order("seq").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	failures := 0
	for _, row := range rows {
		var frame map[string]any
		_ = json.Unmarshal([]byte(row.Frame), &frame)
		if frame["type"] != "error" {
			continue
		}
		failures++
		if frame["clientMessageId"] != "original" || frame["turnEnded"] != true || strings.Contains(row.Frame, failure) {
			t.Fatalf("incorrect failure correlation: %s", row.Frame)
		}
	}
	if failures != 2 {
		t.Fatalf("expected two correlated failures, got %d", failures)
	}
}

func TestBotMessageInterruptContinuesQueuedTurn(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	s, agent, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		select {
		case <-release:
			_, _ = io.WriteString(w, textCompletion("next reply"))
		case <-r.Context().Done():
		}
	})
	defer close(release)
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	seedBotUser(t, s.store)
	ctx := context.Background()
	actor := httpx.Principal{TenantID: "tenant", UserID: "user"}
	_, bindings, _ := h.zakuraBotRoster(ctx, actor)
	binding := bindings[agent.ID]
	sid, err := h.zakuraBotSession(ctx, actor, agent.ID, binding)
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.store.StartRunWith(ctx, "tenant", agent.ID, sid, runStartSpec{MessageID: "first", Content: "first task"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.Enqueue(ctx, "tenant", agent.ID, sid, QueueMessage{ID: "next", Content: "next task"}); err != nil {
		t.Fatal(err)
	}
	if err := h.interruptZakuraBot(ctx, actor, agent.ID, binding); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("queued turn did not start after Stop")
	}
	cancelled, err := s.store.GetRun(ctx, "tenant", agent.ID, sid, run.ID)
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("original run did not stop: %#v %v", cancelled, err)
	}
	state, err := h.zakuraSessionStatus(ctx, actor, agent.ID, binding)
	if err != nil || state["status"] != "running" {
		t.Fatalf("queued turn lost its active state: %#v %v", state, err)
	}
	active := state["activeRunId"].(*string)
	if active == nil || *active == run.ID {
		t.Fatalf("expected the next active run: %#v", state)
	}
	if _, err := s.Cancel(ctx, "tenant", agent.ID, sid); err != nil {
		t.Fatal(err)
	}
}

func TestChatReplyToolSuppressesFallback(t *testing.T) {
	s, agent, _ := loopHarness(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, textCompletion("ok")) })
	h := &handler{store: s.store, service: s, deps: s.store.deps}
	seedBotUser(t, s.store)
	actor := httpx.Principal{TenantID: "tenant", UserID: "user"}
	_, bindings, _ := h.zakuraBotRoster(context.Background(), actor)
	sid, err := h.zakuraBotSession(context.Background(), actor, agent.ID, bindings[agent.ID])
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.store.StartRun(context.Background(), "tenant", agent.ID, sid, "hello", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), computerRunKey{}, run.ID)
	for i := 0; i < 2; i++ {
		if _, err := h.runChatReply(ctx, "tenant", agent.ID, sid, "call", raw(map[string]any{"text": "Sent separately"})); err != nil {
			t.Fatal(err)
		}
	}
	session, _ := s.store.GetSession(ctx, "tenant", agent.ID, sid)
	if err := s.publishBotFallback(ctx, TurnRequest{Tenant: "tenant", Agent: agent.ID, Session: sid}, session, run.ID, "Sent separately"); err != nil {
		t.Fatal(err)
	}
	var count int64
	s.store.deps.Gorm.Table("cloud_agent_events").Where("session_id=? AND type='bot_message'", sid).Count(&count)
	if count != 1 {
		t.Fatalf("expected one bot message: %d", count)
	}
}
