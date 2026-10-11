// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectexec"
	"github.com/go-chi/chi/v5"
)

type reviewFixtureProject struct{ tenant, id, space, run, task string }
type reviewFixture struct {
	t       *testing.T
	d       *appdeps.Dependencies
	h       *handler
	router  chi.Router
	now     time.Time
	tenants map[string]bool
}

func newReviewFixture(t *testing.T, d *appdeps.Dependencies) *reviewFixture {
	t.Helper()
	f := &reviewFixture{t: t, d: d, now: time.Date(2026, 10, 11, 12, 0, 0, 123456789, time.UTC), tenants: map[string]bool{}}
	d.Clock = func() time.Time { return f.now }
	f.h = &handler{deps: d, store: NewStore(d), projects: projectexec.NewStore(d.DB, d.Dialect, d.Rebind)}
	f.h.projectEngine = projectexec.NewEngine(f.h.projects, nil, nil, projectexec.DefaultEngineConfig())
	f.router = chi.NewRouter()
	f.router.Route("/api", f.h.registerProjectReviewInbox)
	return f
}
func (f *reviewFixture) exec(statement string, args ...any) {
	f.t.Helper()
	if _, err := f.d.DB.Exec(f.d.Rebind(statement), args...); err != nil {
		f.t.Fatal(err)
	}
}
func (f *reviewFixture) project(tenant, id, name string) reviewFixtureProject {
	f.t.Helper()
	stamp := reviewStamp(f.now.Add(-24 * time.Hour))
	if !f.tenants[tenant] {
		f.exec(`INSERT INTO tenants(id,slug,name,created_at,updated_at) VALUES(?,?,?,?,?)`, tenant, tenant, tenant, stamp, stamp)
		f.tenants[tenant] = true
	}
	p := reviewFixtureProject{tenant: tenant, id: id, space: id + "-space", run: id + "-run", task: id + "-task"}
	f.exec(`INSERT INTO spaces(id,tenant_id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)`, p.space, tenant, name, p.space, stamp, stamp)
	raw, _ := json.Marshal(map[string]any{"name": name})
	f.exec(`INSERT INTO execution_projects(id,tenant_id,space_id,revision,project_json,created_at,updated_at) VALUES(?,?,?,1,?,?,?)`, id, tenant, p.space, string(raw), stamp, stamp)
	f.exec(`INSERT INTO execution_runs(id,tenant_id,project_id,status,revision,run_json,project_json,created_at,updated_at) VALUES(?,?,?,'running',1,'{}',?,?,?)`, p.run, tenant, id, string(raw), stamp, stamp)
	f.exec(`INSERT INTO execution_tasks(id,tenant_id,project_id,run_id,status,revision,task_json,created_at,updated_at) VALUES(?,?,?,?,'pending',1,'{}',?,?)`, p.task, tenant, id, p.run, stamp, stamp)
	return p
}
func (f *reviewFixture) add(p reviewFixtureProject, kind, id, status, created string) {
	f.t.Helper()
	payload := `{"title":"Review evidence","error":"","spec":{"title":"Verify artifact"},"snapshotId":"frozen-task-snapshot","call":{"name":"publish_artifact","effect":"external_write","arguments":{"destination":"secret-destination","token":"TOP_SECRET_ARGUMENT"}},"plan":{"result":{"id":"merge-snapshot"}}}`
	switch kind {
	case "operation":
		f.exec(`INSERT INTO execution_operations(id,tenant_id,project_id,run_id,task_id,checkpoint_id,call_id,status,revision,operation_json,created_at,updated_at) VALUES(?,?,?,?,?,'checkpoint',?,?,2,?,?,?)`, id, p.tenant, p.id, p.run, p.task, id, status, payload, created, created)
	case "merge":
		f.exec(`INSERT INTO execution_merge_previews(id,tenant_id,project_id,run_id,revision,status,preview_json,created_at,updated_at) VALUES(?,?,?,?,3,?,?,?,?)`, id, p.tenant, p.id, p.run, status, payload, created, created)
	case "source":
		f.exec(`INSERT INTO execution_source_attestations(id,tenant_id,project_id,author_id,activity_ids_json,comment,status,error,created_at,updated_at) VALUES(?,?,?,'owner','["secret-process-id"]','TOP_SECRET_COMMENT',?,'timeout TOP_SECRET_ERROR',?,?)`, id, p.tenant, p.id, status, created, created)
	case "baseline":
		f.exec(`INSERT INTO execution_requirement_baselines(id,tenant_id,project_id,revision,status,baseline_json,created_at,updated_at) VALUES(?,?,?,4,?,?,?,?)`, id, p.tenant, p.id, status, payload, created, created)
	case "task_review":
		f.exec(`UPDATE execution_tasks SET status=?,revision=5,task_json=?,created_at=?,updated_at=? WHERE tenant_id=? AND project_id=? AND run_id=? AND id=?`, status, payload, created, created, p.tenant, p.id, p.run, p.task)
	case "decision", "question":
		f.exec(`INSERT INTO execution_knowledge(id,tenant_id,project_id,kind,status,run_id,task_id,revision,token_length,entry_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,6,10,?,?,?)`, id, p.tenant, p.id, kind, status, p.run, p.task, payload, created, created)
	default:
		f.t.Fatal("invalid fixture kind")
	}
}
func reviewPrincipal(tenant, role string) httpx.Principal {
	return httpx.Principal{TenantID: tenant, Role: role, UserID: "human", SessionID: "session"}
}
func (f *reviewFixture) request(path string, p httpx.Principal) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req = req.WithContext(httpx.WithPrincipal(req.Context(), p))
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, req)
	return w
}
func (f *reviewFixture) list(query string, p httpx.Principal) projectReviewList {
	f.t.Helper()
	w := f.request("/api/project-reviews/?"+query, p)
	if w.Code != 200 {
		f.t.Fatalf("review list: %d %s", w.Code, w.Body.String())
	}
	var out projectReviewList
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		f.t.Fatal(err)
	}
	return out
}
func (f *reviewFixture) summary(query string, p httpx.Principal) projectReviewSummary {
	f.t.Helper()
	w := f.request("/api/project-reviews/summary?"+query, p)
	if w.Code != 200 {
		f.t.Fatalf("review summary: %d %s", w.Code, w.Body.String())
	}
	var out projectReviewSummary
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		f.t.Fatal(err)
	}
	return out
}
func TestProjectReviewInboxPersistedStatesRolePrivacyAndLinks(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-a", "project-a", "Useful artifacts")
	foreign := f.project("review-b", "project-b", "Foreign secret")
	old := reviewStamp(f.now.Add(-2 * time.Hour))
	states := map[string]string{"operation": "unknown", "source": "pending", "merge": "approved", "baseline": "draft", "task_review": "waiting_review", "decision": "proposed", "question": "open"}
	for kind, status := range states {
		f.add(p, kind, kind+"-a", status, old)
		f.add(foreign, kind, kind+"-foreign", status, old)
	}
	f.add(p, "question", "resolved-question", "resolved", old)
	member := reviewPrincipal(p.tenant, "member")
	list := f.list("", member)
	if list.Total != 6 || len(list.Items) != 6 || list.Items[0].Kind != "operation" {
		t.Fatalf("actionable read model: %+v", list)
	}
	owner := reviewPrincipal(p.tenant, "owner")
	ownerList := f.list("", owner)
	if ownerList.Total != 7 || ownerList.Items[1].Kind != "source" {
		t.Fatalf("source owner visibility: %+v", ownerList)
	}
	for _, item := range ownerList.Items {
		if !item.CanAct || item.ProjectID != p.id || item.WaitingSeconds != 7200 {
			t.Fatalf("scope/identity/age: %+v", item)
		}
		link, err := url.Parse(item.Href)
		if err != nil {
			t.Fatal(err)
		}
		q := link.Query()
		if q.Get("reviewId") != item.ID || q.Get("reviewKind") != item.Kind || !strings.HasPrefix(link.Path, "/dashboard/project-executions/"+p.id) {
			t.Fatalf("review link: %+v", item)
		}
		if item.RunID != "" && q.Get("runId") != p.run {
			t.Fatalf("run target: %+v", item)
		}
		switch item.Kind {
		case "operation", "task_review":
			if q.Get("taskId") != p.task || q.Get("tab") != "execution" {
				t.Fatalf("task target: %+v", item)
			}
		case "decision", "question":
			if q.Get("tab") != "knowledge" {
				t.Fatal("knowledge target")
			}
		case "baseline":
			if q.Get("tab") != "requirements" {
				t.Fatal("baseline target")
			}
		case "merge":
			if q.Get("tab") != "merge" || item.SnapshotID != "merge-snapshot" {
				t.Fatal("merge target")
			}
		case "source":
			if item.RequiredRole != "owner_admin" || item.ErrorCategory != "timeout" {
				t.Fatalf("source recovery: %+v", item)
			}
		}
	}
	for _, identity := range []httpx.Principal{member, reviewPrincipal(p.tenant, "viewer"), {TenantID: p.tenant, Role: "owner", UserID: "key", APIKey: true}, {TenantID: p.tenant, Role: "owner", UserID: "human", SessionID: "oauth", OAuth: true}} {
		w := f.request("/api/project-reviews/?limit=200", identity)
		if w.Code != 200 || strings.Contains(w.Body.String(), "source-a") || strings.Contains(w.Body.String(), "foreign") || strings.Contains(w.Body.String(), "TOP_SECRET") || strings.Contains(w.Body.String(), "secret-destination") {
			t.Fatalf("private payload escaped: %d %s", w.Code, w.Body.String())
		}
		summary := f.summary("", identity)
		if summary.Total != 6 {
			t.Fatalf("private counts: %+v", summary)
		}
		for _, group := range summary.Groups {
			if group.Kind == "source" {
				t.Fatal("source counts leaked")
			}
		}
		if identity.Role == "viewer" || identity.APIKey || identity.OAuth {
			var out projectReviewList
			_ = json.Unmarshal(w.Body.Bytes(), &out)
			for _, item := range out.Items {
				if item.CanAct {
					t.Fatalf("non-human reviewer: %+v", identity)
				}
			}
		}
	}
	bound := member
	bound.SpaceID = p.space
	if w := f.request("/api/project-reviews/summary", bound); w.Code != 403 {
		t.Fatalf("bound key read: %d", w.Code)
	}
	if out := f.list("projectId="+foreign.id, member); out.Total != 0 {
		t.Fatal("foreign project filter escaped scope")
	}
}
func TestProjectReviewInboxSummaryCountsBeyondDisplayAndCompactPayload(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-count", "project-count", "100%_ useful")
	old := reviewStamp(f.now.Add(-24 * time.Hour))
	for i := 0; i < 237; i++ {
		f.add(p, "question", fmt.Sprintf("q-%03d", i), "open", old)
	}
	f.add(p, "operation", "op-compact", "unknown", old)
	arguments := map[string]any{}
	for i := 0; i < 40; i++ {
		arguments[fmt.Sprintf("field%d", i)] = strings.Repeat("TOP_SECRET_ARGUMENT", 100)
	}
	arguments["https://secret.example/token=TOP_SECRET_KEY"] = "never expose"
	raw, _ := json.Marshal(map[string]any{"error": "HTTP status 403 token=TOP_SECRET_ERROR", "call": map[string]any{"name": "publish", "effect": "external_write", "arguments": arguments}})
	f.exec(`UPDATE execution_operations SET operation_json=? WHERE id='op-compact'`, string(raw))
	member := reviewPrincipal(p.tenant, "member")
	list := f.list("limit=1", member)
	if list.Total != 238 || len(list.Items) != 1 || list.NextCursor == "" || !list.Items[0].HasError || list.Items[0].ErrorCategory != "http_403" || len(list.Items[0].ArgumentFields) > 12 {
		t.Fatalf("compact item/whole counts: %+v", list)
	}
	encoded, _ := json.Marshal(list)
	if strings.Contains(string(encoded), "TOP_SECRET") || strings.Contains(string(encoded), "secret.example") || len(encoded) > 8000 {
		t.Fatalf("bounded private detail: %s", encoded)
	}
	summary := f.summary("", member)
	if summary.Total != 238 || len(summary.Groups) != 2 {
		t.Fatalf("truncated aggregation: %+v", summary)
	}
	for _, group := range summary.Groups {
		if group.Kind == "question" && group.Count != 237 {
			t.Fatalf("question aggregate: %+v", group)
		}
	}
	if got := f.list("limit=99999", member); len(got.Items) != 200 || got.NextCursor == "" {
		t.Fatal("page limit is not capped")
	}
	if got := f.list("q="+url.QueryEscape("100%_"), member); got.Total != 238 {
		t.Fatal("literal LIKE search escaped incorrectly")
	}
	if got := f.list("q="+url.QueryEscape("100%X"), member); got.Total != 0 {
		t.Fatal("search wildcard treated as pattern")
	}
	if got := f.list("minAgeSeconds=90000", member); got.Total != 0 {
		t.Fatal("minimum age ignored")
	}
	if got := f.list("maxAgeSeconds=90000", member); got.Total != 238 {
		t.Fatal("maximum age ignored")
	}
}
func TestProjectReviewInboxStableCursorAndConcurrentChanges(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-cursor", "project-cursor", "Cursor")
	for _, entry := range []struct{ id, stamp string }{{"z", "2026-10-11T10:00:00Z"}, {"a", "2026-10-11T10:00:00.1Z"}, {"b", "2026-10-11T10:00:00.100000001Z"}, {"c", "2026-10-11T10:00:00.100000002Z"}} {
		f.add(p, "operation", entry.id, "pending_approval", entry.stamp)
	}
	principal := reviewPrincipal(p.tenant, "member")
	first := f.list("limit=1", principal)
	if first.Items[0].ID != "z" || first.NextCursor == "" {
		t.Fatalf("normalized nanos ordering: %+v", first)
	}
	snapshot := first.SnapshotAt
	f.now = f.now.Add(time.Second)
	// Changing an already displayed state cannot move it below the cursor: risk
	// belongs to its immutable kind. A newly modified row also needs refresh.
	f.exec(`UPDATE execution_operations SET status='unknown',updated_at=? WHERE id='z'`, reviewStamp(f.now))
	f.add(p, "operation", "new-after-snapshot", "unknown", reviewStamp(f.now))
	f.now = f.now.Add(time.Second)
	cursor := first.NextCursor
	seen := []string{"z"}
	for cursor != "" {
		page := f.list("limit=1&cursor="+url.QueryEscape(cursor), principal)
		if page.SnapshotAt != snapshot {
			t.Fatal("page cutoff changed")
		}
		for _, item := range page.Items {
			seen = append(seen, item.ID)
		}
		cursor = page.NextCursor
	}
	if strings.Join(seen, ",") != "z,a,b,c" {
		t.Fatalf("pagination repeated or skipped old records: %v", seen)
	}
	fresh := f.list("limit=200", principal)
	if fresh.Total != 5 {
		t.Fatalf("refresh misses concurrent item: %+v", fresh)
	}
	for _, query := range []string{"kind=merge&cursor=" + first.NextCursor, "cursor=not-base64", "minAgeSeconds=100&maxAgeSeconds=10", "kind=imaginary", "cursor=" + strings.Repeat("x", 2049)} {
		if w := f.request("/api/project-reviews/?"+query, principal); w.Code != 400 {
			t.Fatalf("bad filter/cursor accepted: %d %s", w.Code, w.Body.String())
		}
	}
	other := reviewPrincipal("other-tenant", "member")
	if w := f.request("/api/project-reviews/?cursor="+first.NextCursor, other); w.Code != 400 {
		t.Fatal("cross-tenant cursor accepted")
	}
}
func TestProjectReviewInboxEmptyAndNullArguments(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-empty", "project-empty", "Empty")
	principal := reviewPrincipal(p.tenant, "member")
	if out := f.list("", principal); out.Total != 0 || out.Items == nil || out.VisibleKinds == nil {
		t.Fatalf("empty collections: %+v", out)
	}
	for i, payload := range []string{`{"call":{"name":"tool"}}`, `{"call":{"arguments":null}}`, `{"call":{"arguments":"raw secret"}}`, `{"call":{"arguments":["secret"]}}`} {
		id := fmt.Sprintf("op-%d", i)
		f.add(p, "operation", id, "unknown", reviewStamp(f.now.Add(-time.Hour)))
		f.exec(`UPDATE execution_operations SET operation_json=? WHERE id=?`, payload, id)
	}
	out := f.list("", principal)
	if len(out.Items) != 4 {
		t.Fatalf("null arguments aborted read: %+v", out)
	}
	for _, item := range out.Items {
		if len(item.ArgumentFields) != 0 {
			t.Fatalf("non-object arguments exposed as fields: %+v", item)
		}
	}
}

func TestProjectReviewInboxTaskIdentityIncludesRun(t *testing.T) {
	f := newReviewFixture(t, testDeps(t))
	p := f.project("review-rerun", "rerun-project", "Repeated plan")
	stamp := reviewStamp(f.now.Add(-time.Hour))
	f.add(p, "task_review", p.task, "waiting_review", stamp)
	f.exec(`UPDATE execution_tasks SET id='build' WHERE run_id=?`, p.run)
	otherRun := p.run + "-retry"
	f.exec(`INSERT INTO execution_runs(id,tenant_id,project_id,status,revision,run_json,project_json,created_at,updated_at) VALUES(?,?,?,'waiting_review',1,'{}','{}',?,?)`, otherRun, p.tenant, p.id, stamp, stamp)
	f.exec(`INSERT INTO execution_tasks(id,tenant_id,project_id,run_id,status,revision,task_json,created_at,updated_at) VALUES('build',?,?,?,'waiting_review',1,'{"spec":{"title":"Build retried artifact"}}',?,?)`, p.tenant, p.id, otherRun, stamp, stamp)
	other := f.project(p.tenant, "other-project", "Other plan")
	f.add(other, "task_review", other.task, "waiting_review", stamp)
	f.exec(`UPDATE execution_tasks SET id='build' WHERE run_id=?`, other.run)
	principal := reviewPrincipal(p.tenant, "member")
	cursor := ""
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		page := f.list("limit=1&cursor="+url.QueryEscape(cursor), principal)
		if len(page.Items) != 1 || page.Total != 3 {
			t.Fatalf("same task IDs collapsed: %+v", page)
		}
		item := page.Items[0]
		if item.ID != "build" || seen[item.RunID] {
			t.Fatalf("task cursor repeated: %+v", page)
		}
		seen[item.RunID] = true
		cursor = page.NextCursor
	}
	if cursor != "" || len(seen) != 3 {
		t.Fatalf("same task identity paging: %v %s", seen, cursor)
	}
	exact := f.list("projectId="+p.id+"&kind=task_review&reviewId=build&runId="+otherRun, principal)
	if exact.Total != 1 || exact.Items[0].RunID != otherRun {
		t.Fatalf("stale link recheck matched wrong run: %+v", exact)
	}
}
