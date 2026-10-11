package projectknowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	_ "github.com/mattn/go-sqlite3"
)

func testStore(t *testing.T) (*Store, *projectexec.Store, mission.Project, mission.Scope) {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "knowledge.db")+"?_foreign_keys=on&_busy_timeout=10000&_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{`CREATE TABLE tenants(id TEXT PRIMARY KEY)`, `CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id))`, `INSERT INTO tenants VALUES('tenant-a'),('tenant-b')`, `INSERT INTO spaces VALUES('space-a','tenant-a'),('space-b','tenant-b')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"0006_project_execution.sql", "0007_project_merge_reviews.sql", "0009_project_knowledge.sql", "0010_project_portfolio.sql"} {
		raw, e := os.ReadFile("../platform/migrations/sql/" + name)
		if e != nil {
			t.Fatal(e)
		}
		for _, q := range strings.Split(string(raw), "-- statement-breakpoint") {
			if _, e = db.Exec(q); e != nil {
				t.Fatalf("migration %s: %v", name, e)
			}
		}
	}
	exec := projectexec.NewStore(db, "sqlite", nil)
	p, err := exec.CreateProject(context.Background(), mission.Project{ID: "project-a", TenantID: "tenant-a", SpaceID: "space-a", Name: "Reliable project", Goal: "Ship tested collaboration", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "a", Title: "Build", Prompt: "Build", AgentID: "agent-a", Writes: []string{"."}, MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "file", Kind: "path_exists", Path: "result.txt", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxTokens: 100000, MaxToolCalls: 100, MaxModelCalls: 100, MaxConcurrent: 1}, ExternalEffects: "deny", MaxTasks: 100}})
	if err != nil {
		t.Fatal(err)
	}
	scope := mission.Scope{TenantID: p.TenantID, SpaceID: p.SpaceID, ProjectID: p.ID}
	return NewStore(db, "sqlite", nil), exec, p, scope
}
func noteDraft(title, body string) knowledge.Draft {
	return knowledge.Draft{Kind: "note", Title: title, Body: body, Tags: []string{"缓存"}}
}

func TestRevisionReviewHistoryTombstoneAndTenantIsolation(t *testing.T) {
	s, _, _, scope := testStore(t)
	ctx := context.Background()
	draft := noteDraft("持久缓存", "采用事务维护索引")
	draft.Kind = "decision"
	entry, err := s.Create(ctx, scope, draft, "human-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Transition(ctx, scope, entry.ID, entry.Revision, "approve", "模型不能代替批准", "agent:a", false); !errors.Is(err, ErrInvalid) {
		t.Fatalf("machine review: %v", err)
	}
	approved, err := s.Transition(ctx, scope, entry.ID, entry.Revision, "approve", "验证通过", "human-a", true)
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != "approved" {
		t.Fatal(approved)
	}
	updated, err := s.Update(ctx, scope, entry.ID, approved.Revision, draft, "改变正文需重新审核", "human-a")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != "proposed" || updated.Revision != 3 {
		t.Fatal(updated)
	}
	old, err := s.Get(ctx, scope, entry.ID, 2)
	if err != nil || old.Status != "approved" {
		t.Fatalf("immutable approval: %+v %v", old, err)
	}
	if _, err = s.Update(ctx, scope, entry.ID, 2, draft, "", "human-a"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision: %v", err)
	}
	archived, err := s.Transition(ctx, scope, entry.ID, updated.Revision, "archive", "过期草案", "human-a", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Update(ctx, scope, entry.ID, archived.Revision, draft, "", "human-a"); !errors.Is(err, ErrInvalid) {
		t.Fatal("archived edit accepted")
	}
	restored, err := s.Transition(ctx, scope, entry.ID, archived.Revision, "restore", "继续讨论", "human-a", false)
	if err != nil || restored.Status != "proposed" {
		t.Fatalf("restore %+v %v", restored, err)
	}
	deleted, err := s.Transition(ctx, scope, entry.ID, restored.Revision, "delete", "保留审计后删除当前正文", "human-a", false)
	if err != nil || deleted.Body != "" || deleted.Status != "deleted" {
		t.Fatalf("delete %+v %v", deleted, err)
	}
	history, err := s.History(ctx, scope, entry.ID, 0, 100)
	if err != nil || len(history) != 6 || history[5].Entry.Body != draft.Body {
		t.Fatalf("history %+v %v", history, err)
	}
	for _, other := range []mission.Scope{{TenantID: "tenant-b", SpaceID: "space-b", ProjectID: scope.ProjectID}, {TenantID: scope.TenantID, SpaceID: "wrong-space", ProjectID: scope.ProjectID}} {
		if _, err = s.Get(ctx, other, entry.ID, 1); !errors.Is(err, ErrNotFound) {
			t.Fatalf("scope leaked: %v", err)
		}
	}
	result, err := s.Search(ctx, scope, knowledge.Query{Text: "缓存"})
	if err != nil || len(result.Items) != 0 {
		t.Fatalf("deleted indexed: %+v %v", result, err)
	}
}

func TestIndexedSearchFilteringBudgetAndRevisionCoherence(t *testing.T) {
	s, _, _, scope := testStore(t)
	ctx := context.Background()
	titles := []string{"缓存一致性", "索引维护", "旧版缓存"}
	entries := []knowledge.Entry{}
	for i, title := range titles {
		draft := noteDraft(title, "中文缓存支持 PostgreSQL 事务")
		if i == 1 {
			draft.Tags = []string{"数据库"}
		}
		entry, err := s.Create(ctx, scope, draft, "human")
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
	}
	result, err := s.Search(ctx, scope, knowledge.Query{Text: "缓存 PostgreSQL", Filter: knowledge.Filter{Tags: []string{"缓存"}}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.CorpusSize != 2 || len(result.Items[0].Snippet.Highlights) == 0 {
		t.Fatalf("search: %+v", result)
	}
	bounded, err := s.Search(ctx, scope, knowledge.Query{Text: "缓存", MaxCandidates: 1})
	if err != nil || !bounded.Truncated || bounded.Candidates != 1 {
		t.Fatalf("budget: %+v %v", bounded, err)
	}
	if _, err = s.Search(ctx, scope, knowledge.Query{Text: "缓存", MaxCandidates: 2001}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unbounded search accepted %v", err)
	}
	if _, err = s.Transition(ctx, scope, entries[2].ID, 1, "archive", "旧版", "human", false); err != nil {
		t.Fatal(err)
	}
	result, err = s.Search(ctx, scope, knowledge.Query{Text: "缓存", Filter: knowledge.Filter{Tags: []string{"缓存"}}})
	if err != nil || len(result.Items) != 1 {
		t.Fatalf("archive not hidden: %+v %v", result, err)
	}
	result, err = s.Search(ctx, scope, knowledge.Query{Text: "缓存", Filter: knowledge.Filter{Status: "archived"}})
	if err != nil || len(result.Items) != 1 {
		t.Fatalf("archive filter: %+v %v", result, err)
	}
	page, err := s.List(ctx, scope, knowledge.Filter{}, "", 1)
	if err != nil || len(page.Items) != 1 || page.NextCursor == "" {
		t.Fatalf("page %+v %v", page, err)
	}
	next, err := s.List(ctx, scope, knowledge.Filter{}, page.NextCursor, 1)
	if err != nil || len(next.Items) != 1 || next.Items[0].ID == page.Items[0].ID {
		t.Fatalf("pagination %+v %v", next, err)
	}
}

func TestCitationsAreScopedAndRemainBoundToImmutableRevision(t *testing.T) {
	s, exec, _, scope := testStore(t)
	ctx := context.Background()
	run, err := exec.CreateRun(ctx, scope.TenantID, scope.ProjectID, "snapshot-a")
	if err != nil {
		t.Fatal(err)
	}
	entry, err := s.Create(ctx, scope, noteDraft("源文档", "缓存协议"), "human")
	if err != nil {
		t.Fatal(err)
	}
	draft := noteDraft("引用", "文档引用")
	draft.RunID = run.ID
	draft.Sources = []knowledge.Source{{Kind: "snapshot", SnapshotID: "snapshot-a", Path: "src/cache.go"}, {Kind: "knowledge", EntryID: entry.ID, Revision: 1}, {Kind: "url", URL: "https://example.com/spec"}}
	linked, err := s.Create(ctx, scope, draft, "human")
	if err != nil {
		t.Fatal(err)
	}
	changed := noteDraft("源文档", "新的协议")
	if _, err = s.Update(ctx, scope, entry.ID, 1, changed, "协议更新", "human"); err != nil {
		t.Fatal(err)
	}
	old, err := s.Get(ctx, scope, linked.Sources[1].EntryID, linked.Sources[1].Revision)
	if err != nil || old.Body != "缓存协议" {
		t.Fatalf("citation drift: %+v %v", old, err)
	}
	for _, source := range []knowledge.Source{{Kind: "snapshot", SnapshotID: "unowned-snapshot", Path: "src/cache.go"}, {Kind: "snapshot", SnapshotID: "snapshot-a", Path: "../../secret"}, {Kind: "knowledge", EntryID: entry.ID, Revision: 99}, {Kind: "url", URL: "javascript:alert(1)"}} {
		draft.Sources = []knowledge.Source{source}
		if _, err = s.Create(ctx, scope, draft, "human"); err == nil {
			t.Fatalf("invalid source accepted: %+v", source)
		}
	}
	draft.RunID = "wrong-run"
	draft.Sources = nil
	if _, err = s.Create(ctx, scope, draft, "human"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign run accepted %v", err)
	}
}

func TestConcurrentEditHasSingleRevisionWinner(t *testing.T) {
	s, _, _, scope := testStore(t)
	ctx := context.Background()
	draft := noteDraft("文档", "一致性")
	entry, err := s.Create(ctx, scope, draft, "human")
	if err != nil {
		t.Fatal(err)
	}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.Update(ctx, scope, entry.ID, 1, draft, "并发编辑", "human")
			if e == nil {
				winners.Add(1)
			} else if !errors.Is(e, ErrConflict) {
				t.Errorf("unexpected error: %v", e)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("winners %d", winners.Load())
	}
	history, err := s.History(ctx, scope, entry.ID, 0, 100)
	if err != nil || len(history) != 2 {
		t.Fatalf("history: %d %v", len(history), err)
	}
}

func admittedNote(t *testing.T, s *Store, exec *projectexec.Store, scope mission.Scope) (mission.Assignment, mission.Operation) {
	t.Helper()
	ctx := context.Background()
	if _, err := exec.CreateRun(ctx, scope.TenantID, scope.ProjectID, "snapshot-a"); err != nil {
		t.Fatal(err)
	}
	a, err := exec.ClaimTask(ctx, "worker-a", time.Minute)
	if err != nil || a == nil {
		t.Fatalf("claim %v %v", a, err)
	}
	ref := projectexec.FenceRequest{Scope: a.Scope, RunID: a.Run.ID, TaskID: a.Task.ID, Owner: a.Task.LeaseOwner, Fence: a.Task.Fence}
	if err = exec.InitializeTaskBranch(ctx, ref, "branch-a", "snapshot-a"); err != nil {
		t.Fatal(err)
	}
	cp, err := exec.GetCheckpoint(ctx, a.Scope, a.Run.ID, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = exec.ReserveDecisionBudget(ctx, ref, 100); err != nil {
		t.Fatal(err)
	}
	call := mission.ToolCall{ID: "call-note", Name: "project_note", Effect: "workspace_write", Arguments: json.RawMessage(`{"title":"发现事务边界","body":"索引与文档必须在同一事务提交","tags":["数据库"]}`)}
	cp, err = exec.RecordModelDecision(ctx, ref, cp.Sequence, mission.Decision{Tools: []mission.ToolCall{call}, Tokens: 1})
	if err != nil {
		t.Fatal(err)
	}
	op, _, err := exec.BeginOperation(ctx, ref, cp.ID, call)
	if err != nil {
		t.Fatal(err)
	}
	op, err = exec.StartOperation(ctx, ref, op.ID, op.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a.Task, err = exec.GetTask(ctx, scope.TenantID, scope.ProjectID, a.Run.ID, a.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	return *a, op
}

func TestOperationReceiptAtomicRollbackRestartAndConcurrentReplay(t *testing.T) {
	s, exec, _, scope := testStore(t)
	ctx := context.Background()
	a, op := admittedNote(t, s, exec, scope)
	if _, err := s.db.Exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON execution_knowledge_receipts BEGIN SELECT RAISE(ABORT,'receipt failed'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.NoteOperation(ctx, a, op); err == nil {
		t.Fatal("receipt failure did not abort write")
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM execution_knowledge`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("half commit count %d %v", count, err)
	}
	if _, err := s.db.Exec(`DROP TRIGGER reject_receipt`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.NoteOperation(ctx, a, op); err != nil {
				t.Errorf("replay: %v", err)
			}
		}()
	}
	wg.Wait()
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM execution_knowledge`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate note count %d %v", count, err)
	}
	restarted := NewStore(s.db, "sqlite", nil)
	inspection, err := restarted.InspectNote(ctx, scope, op)
	if err != nil || !inspection.Known || len(inspection.Result.Content) == 0 {
		t.Fatalf("restart inspect %+v %v", inspection, err)
	}
	changed := op
	changed.ArgumentsHash = "changed"
	if _, err = restarted.InspectNote(ctx, scope, changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("receipt hash mismatch %v", err)
	}
	if _, err = s.db.Exec(`INSERT INTO execution_tenant_controls(tenant_id,draining,updated_at) VALUES('tenant-a',1,'now')`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, scope, noteDraft("停止", "新工作"), "human"); !errors.Is(err, projectexec.ErrTenantDraining) {
		t.Fatalf("draining write %v", err)
	}
}

func TestQuestionResolutionAndCommentRevision(t *testing.T) {
	s, _, _, scope := testStore(t)
	ctx := context.Background()
	draft := noteDraft("待定参数", "选择缓存TTL")
	draft.Kind = "question"
	entry, err := s.Create(ctx, scope, draft, "human")
	if err != nil {
		t.Fatal(err)
	}
	comment, err := s.AddComment(ctx, scope, entry.ID, 1, "建议60秒", "human-b")
	if err != nil || comment.Revision != 1 {
		t.Fatalf("comment %+v %v", comment, err)
	}
	resolved, err := s.Transition(ctx, scope, entry.ID, 1, "resolve", "确定60秒", "human", true)
	if err != nil || resolved.Status != "resolved" {
		t.Fatalf("resolve %+v %v", resolved, err)
	}
	if _, err = s.AddComment(ctx, scope, entry.ID, 1, "旧问题版本", "human"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale comment %v", err)
	}
	comments, err := s.Comments(ctx, scope, entry.ID, "", 100)
	if err != nil || len(comments) != 1 {
		t.Fatalf("comments %+v %v", comments, err)
	}
	if _, err = s.Transition(ctx, scope, entry.ID, resolved.Revision, "reopen", "新增限制", "human", true); err != nil {
		t.Fatal(err)
	}
}
