package runtime

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"net/url"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/golang-jwt/jwt/v5"
)

func TestProjectKnowledgePublicHTTPHumanReviewAndRevisionReferences(t *testing.T) {
	d := testDeps(t)
	apiToken := seedTenant(t, d, "tenant-knowledge")
	otherToken := seedTenant(t, d, "tenant-other")
	human := projectTestHumanToken(t, d, "tenant-knowledge", "knowledge-member")
	seed := sha256.Sum256(append(append([]byte{}, d.Secret...), []byte("zakura-oauth-eddsa-v1")...))
	oauth, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{"sub": "knowledge-member", "tid": "tenant-knowledge", "scope": "api", "iss": d.PublicURL, "exp": d.Clock().Add(time.Hour).Unix()}).SignedString(ed25519.NewKeyFromSeed(seed[:]))
	if err != nil {
		t.Fatal(err)
	}
	h, server, _ := projectTestServer(t, d)
	h.initializeProjectKnowledge()
	space, err := h.store.CreateSpace(context.Background(), "tenant-knowledge", Space{Name: "Knowledge workspace"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.projects.CreateProject(context.Background(), mission.Project{TenantID: "tenant-knowledge", SpaceID: space.ID, Name: "Design decisions", Goal: "Preserve collaboration evidence", Plan: mission.Plan{Version: 1, Tasks: []mission.TaskSpec{{ID: "write", Title: "Implement", Prompt: "Implement", AgentID: "agent-placeholder", MaxAttempts: 3, Checks: []mission.CheckSpec{{ID: "artifact", Kind: "path_exists", Path: "result.txt", Required: true}}}}}, Config: mission.Config{Budget: mission.Budget{MaxConcurrent: 1}, MaxTasks: 100}})
	if err != nil {
		t.Fatal(err)
	}
	base := server.URL + "/api/project-executions/" + p.ID + "/knowledge"
	code, out := doJSON(t, server.Client(), "POST", base, apiToken, map[string]any{"kind": "decision", "title": "缓存一致性协议", "body": "采用事务索引和 PostgreSQL 事务。", "tags": []string{"缓存", "数据库"}})
	projectTestStatus(t, code, 201, out)
	entry := projectTestDecode[knowledge.Entry](t, out)
	for _, token := range []string{apiToken, oauth} {
		code, out = doJSON(t, server.Client(), "GET", base+"/"+entry.ID, token, nil)
		projectTestStatus(t, code, 200, out)
		code, out = doJSON(t, server.Client(), "POST", base+"/"+entry.ID+"/state", token, map[string]any{"expectedRevision": 1, "action": "approve", "comment": "批准协议"})
		projectTestStatus(t, code, 403, out)
	}
	code, out = doJSON(t, server.Client(), "POST", base+"/"+entry.ID+"/state", human, map[string]any{"expectedRevision": 1, "action": "approve", "comment": "检查事务边界与恢复语义"})
	projectTestStatus(t, code, 200, out)
	approved := projectTestDecode[knowledge.Entry](t, out)
	if approved.Status != "approved" || approved.UpdatedBy != "knowledge-member" {
		t.Fatalf("human approval not bound: %+v", approved)
	}
	code, out = doJSON(t, server.Client(), "PATCH", base+"/"+entry.ID, apiToken, map[string]any{"expectedRevision": 2, "kind": "decision", "title": entry.Title, "body": "修改为新的事务协议", "tags": entry.Tags})
	projectTestStatus(t, code, 200, out)
	changed := projectTestDecode[knowledge.Entry](t, out)
	if changed.Status != "proposed" {
		t.Fatalf("edit retained stale approval %+v", changed)
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/"+entry.ID+"?revision=2", apiToken, nil)
	projectTestStatus(t, code, 200, out)
	if out["status"] != "approved" || out["body"] != entry.Body {
		t.Fatalf("immutable revision changed: %#v", out)
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/search?q="+url.QueryEscape("缓存")+"&tag="+url.QueryEscape("数据库"), apiToken, nil)
	projectTestStatus(t, code, 200, out)
	search := projectTestDecode[knowledge.SearchResult](t, out)
	if len(search.Items) != 1 || search.Items[0].Entry.Revision != 3 || len(search.Items[0].TitleHighlights) == 0 {
		t.Fatalf("search inconsistent: %+v", search)
	}
	code, out = doJSON(t, server.Client(), "POST", base+"/"+entry.ID+"/comments", human, map[string]any{"expectedRevision": 3, "body": "请解释最新协议如何避免重复提交。"})
	projectTestStatus(t, code, 201, out)
	code, out = doJSON(t, server.Client(), "GET", base+"/"+entry.ID+"/comments", apiToken, nil)
	projectTestStatus(t, code, 200, out)
	if len(out["items"].([]any)) != 1 {
		t.Fatal("comment thread missing")
	}
	code, out = doJSON(t, server.Client(), "GET", base+"/"+entry.ID, otherToken, nil)
	projectTestStatus(t, code, 404, out)
	code, out = doJSON(t, server.Client(), "PATCH", base+"/"+entry.ID, apiToken, map[string]any{"expectedRevision": 2, "kind": "decision", "title": entry.Title, "body": "stale update"})
	projectTestStatus(t, code, 409, out)
	code, out = doJSON(t, server.Client(), "DELETE", base+"/"+entry.ID, human, map[string]any{"expectedRevision": 3, "comment": "保留旧审批与讨论审计"})
	projectTestStatus(t, code, 200, out)
	code, out = doJSON(t, server.Client(), "GET", base+"/"+entry.ID+"/history", human, nil)
	projectTestStatus(t, code, 200, out)
	if len(out["items"].([]any)) != 4 {
		t.Fatalf("audit history incomplete: %#v", out)
	}
	code, out = doJSON(t, server.Client(), "POST", base, apiToken, map[string]any{"kind": "question", "title": "缓存TTL", "body": "如何选择 TTL？"})
	projectTestStatus(t, code, 201, out)
	question := projectTestDecode[knowledge.Entry](t, out)
	for _, token := range []string{apiToken, oauth} {
		code, out = doJSON(t, server.Client(), "POST", base+"/"+question.ID+"/state", token, map[string]any{"expectedRevision": 1, "action": "resolve", "comment": "设置60秒"})
		projectTestStatus(t, code, 403, out)
	}
	code, out = doJSON(t, server.Client(), "POST", base+"/"+question.ID+"/state", human, map[string]any{"expectedRevision": 1, "action": "resolve", "comment": "基于测量设置60秒"})
	projectTestStatus(t, code, 200, out)
}
