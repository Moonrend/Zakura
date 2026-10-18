// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
)

func skillTestHandler(t *testing.T) (*handler, Space) {
	t.Helper()
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Skills", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	return &handler{deps: d, store: store}, space
}
func skillRequest(t *testing.T, h *handler, p httpx.Principal, method, target string, body any) (int, map[string]any) {
	t.Helper()
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(httpx.WithPrincipal(r.Context(), p)))
		})
	})
	h.registerSkills(router)
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(method, target, bytes.NewReader(raw))
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	out := map[string]any{}
	_ = json.Unmarshal(res.Body.Bytes(), &out)
	return res.Code, out
}
func seedSkillCache(t *testing.T, h *handler, packages []skillCachedPackage) {
	t.Helper()
	raw, _ := json.Marshal(packages)
	now := runtimeTimeString(h.store.now())
	err := h.deps.Gorm.Exec(`INSERT INTO platform_skill_repos(id,repo_key,provider,source_json,ref,version,packages_json,partial,skill_count,size_bytes,warnings_json,checked_at,fetched_at,ref_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "repo", "github:anthropics/skills@HEAD", "github", `{"kind":"github","owner":"anthropics","repo":"skills","ref":"HEAD"}`, "HEAD", "rev1", string(raw), false, len(packages), 100, "[]", now, now, 0, now, now).Error
	if err != nil {
		t.Fatal(err)
	}
}
func TestSkillsSpaceFrontendContractsWithoutAgent(t *testing.T) {
	h, s := skillTestHandler(t)
	p := httpx.Principal{TenantID: "tenant"}
	files := []skillFile{{Path: "SKILL.md", Content: "---\nname: review\ndescription: Check changes\n---\nReview body", Encoding: "utf8"}, {Path: "assets/icon.bin", Content: base64.StdEncoding.EncodeToString([]byte{0, 255, 128}), Encoding: "base64"}}
	seedSkillCache(t, h, []skillCachedPackage{{Name: "review", Title: "Review", Description: "Check changes", Version: "rev1", Files: files}, {Name: "testing", Title: "Testing", Version: "rev1", Files: []skillFile{{Path: "SKILL.md", Content: "# Testing"}}}})
	prefix := "/spaces/" + s.ID + "/skills"
	code, out := skillRequest(t, h, p, "GET", prefix+"/stores", nil)
	if code != 200 || len(out["stores"].([]any)) != 4 {
		t.Fatalf("stores %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "GET", prefix+"/search?store=curated&offset=1&limit=1", nil)
	if code != 200 || out["total"] != float64(2) || len(out["items"].([]any)) != 1 || out["hasMore"] != false {
		t.Fatalf("pagination %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "POST", prefix+"/resolve", map[string]any{"source": "anthropics/skills@review"})
	if code != 200 || len(out["skills"].([]any)) != 1 || out["skills"].([]any)[0].(map[string]any)["body"] != "Review body" {
		t.Fatalf("resolve %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "POST", prefix+"/install", map[string]any{"source": "anthropics/skills", "names": []string{"review"}})
	if code != 201 {
		t.Fatalf("install %d %#v", code, out)
	}
	skillID := out["skills"].([]any)[0].(map[string]any)["id"].(string)
	root := filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "review")
	data, err := os.ReadFile(filepath.Join(root, "assets", "icon.bin"))
	if err != nil || !bytes.Equal(data, []byte{0, 255, 128}) {
		t.Fatalf("binary %v %v", data, err)
	}
	code, out = skillRequest(t, h, p, "GET", prefix, nil)
	if code != 200 || len(out["skills"].([]any)) != 1 || len(out["skills"].([]any)[0].(map[string]any)["agentIds"].([]any)) != 0 {
		t.Fatalf("space list %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "PATCH", prefix+"/"+skillID+"/auto-update", map[string]any{"enabled": false})
	if code != 200 || out["skill"].(map[string]any)["autoUpdate"] != false {
		t.Fatalf("auto-update %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "GET", prefix+"/"+skillID+"/file?path=assets/icon.bin", nil)
	if code != 200 || out["encoding"] != "base64" {
		t.Fatalf("file %d %#v", code, out)
	}
	a, err := h.store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	code, out = skillRequest(t, h, p, "GET", "/agents/"+a.ID+"/skills", nil)
	if code != 200 || out["skills"].([]any)[0].(map[string]any)["enabled"] != false {
		t.Fatalf("agent list %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "PATCH", "/agents/"+a.ID+"/skills/review", map[string]any{"enabled": true})
	if code != 200 {
		t.Fatalf("enable %d %#v", code, out)
	}
	if advertised := h.enabledSpacePromptSkills(context.Background(), "tenant", a.ID); len(advertised) != 1 || advertised[0].Name != "review" || advertised[0].Path != "/skills/review/SKILL.md" {
		t.Fatalf("enabled skill not advertised correctly: %#v", advertised)
	}
	code, out = skillRequest(t, h, p, "DELETE", "/agents/"+a.ID+"/skills/review", nil)
	if code != 200 {
		t.Fatalf("detach %d %#v", code, out)
	}
	if _, err = os.Stat(filepath.Join(root, "SKILL.md")); err != nil {
		t.Fatal("Agent detach removed Space files")
	}
	code, out = skillRequest(t, h, p, "DELETE", prefix+"/"+skillID, nil)
	if code != 200 {
		t.Fatalf("delete %d %#v", code, out)
	}
	if _, err = os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("files remain after remove: %v", err)
	}
}
func TestSkillsSpaceReplacementRollbackAndRemoval(t *testing.T) {
	h, s := skillTestHandler(t)
	ctx := context.Background()
	version := "one"
	skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: "review", Version: version, Files: []skillFile{{Path: "SKILL.md", Content: "one"}, {Path: "old.txt", Content: "obsolete"}}}, json.RawMessage(`{"kind":"upload"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	row, err := h.installSpaceSnapshot(ctx, "tenant", s.ID, skill)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "review")
	// Failing the DB snapshot write after swapping files restores the entire old tree.
	if err = h.deps.Gorm.Exec(`CREATE TRIGGER reject_skill_snapshot BEFORE UPDATE ON space_skills BEGIN SELECT RAISE(FAIL,'injected snapshot failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	two := "two"
	err = h.replaceSpaceSnapshot(ctx, row, []skillFile{{Path: "SKILL.md", Content: "two"}}, &two, false)
	if err == nil {
		t.Fatal("injected DB failure was ignored")
	}
	data, _ := os.ReadFile(filepath.Join(root, "SKILL.md"))
	if string(data) != "one" {
		t.Fatalf("rollback manifest %q", data)
	}
	if _, err = os.Stat(filepath.Join(root, "old.txt")); err != nil {
		t.Fatal("rollback lost old files")
	}
	_ = h.deps.Gorm.Exec(`DROP TRIGGER reject_skill_snapshot`).Error
	if err = h.replaceSpaceSnapshot(ctx, row, []skillFile{{Path: "SKILL.md", Content: "two"}}, &two, false); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, "old.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("upgrade left deleted upstream file")
	}
	if err = h.replaceSpaceSnapshot(ctx, row, nil, nil, true); !errors.Is(err, errSkillConflict) {
		t.Fatalf("stale revision removed new install: %v", err)
	}
	var current spaceSkill
	if err = h.deps.Gorm.Where("id=?", row.ID).Take(&current).Error; err != nil {
		t.Fatal(err)
	}
	if err = h.replaceSpaceSnapshot(ctx, current, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("staging or backup leaked: %v", entries)
	}
}
func TestSkillsSpaceConflictsAuthorizationAndSelectedComputer(t *testing.T) {
	h, s := skillTestHandler(t)
	ctx := context.Background()
	a, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	other, err := h.store.CreateSpace(ctx, "tenant", Space{Name: "Other", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	p := httpx.Principal{TenantID: "tenant", APIKey: true, SpaceID: other.ID}
	for _, route := range []string{"/agents/" + a.ID + "/skills", "/agents/" + a.ID + "/skills/review/file", "/spaces/" + s.ID + "/skills", "/spaces/" + s.ID + "/skills/stores"} {
		code, _ := skillRequest(t, h, p, "GET", route, nil)
		if code != 404 {
			t.Fatalf("bound scope bypass %s: %d", route, code)
		}
	}
	skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: "review", Files: []skillFile{{Path: "SKILL.md", Content: "first"}}}, json.RawMessage(`{"kind":"upload"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	wrong := t.TempDir()
	ctx = context.WithValue(ctx, computerExecKey{}, &resolvedExecution{hostRoot: wrong})
	if _, err = h.installSpaceSnapshot(ctx, "tenant", s.ID, skill); err != nil {
		t.Fatal(err)
	}
	skill.ID = "different"
	if _, err = h.installSpaceSnapshot(ctx, "tenant", s.ID, skill); !errors.Is(err, errSkillConflict) {
		t.Fatalf("same-name overwrite %v", err)
	}
	if _, err = os.Stat(filepath.Join(wrong, "skills")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("selected computer redirected skill files")
	}
}
func TestSkillsWorkspaceRegistrationAndLegacyConflict(t *testing.T) {
	h, s := skillTestHandler(t)
	ctx := context.Background()
	root := filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "local-review")
	if err := os.MkdirAll(filepath.Join(root, "assets"), 0750); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("---\nname: local-review\ndescription: Local review\n---\nReview"), 0640)
	_ = os.WriteFile(filepath.Join(root, "assets", "binary"), []byte{0, 255}, 0640)
	p := httpx.Principal{TenantID: "tenant"}
	code, out := skillRequest(t, h, p, "POST", "/spaces/"+s.ID+"/skills/register", map[string]any{"workspacePath": "/skills/local-review"})
	if code != 201 {
		t.Fatalf("register %d %#v", code, out)
	}
	code, out = skillRequest(t, h, p, "POST", "/spaces/"+s.ID+"/skills/register", map[string]any{"workspacePath": "/skills/../outside"})
	if code != 400 {
		t.Fatalf("unsafe workspace %d %#v", code, out)
	}
	a, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "A", SpaceID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.store.CreateAgent(ctx, "tenant", Agent{Name: "B", SpaceID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: "legacy", Version: "one", Files: []skillFile{{Path: "SKILL.md", Content: "legacy"}}}, json.RawMessage(`{"kind":"upload"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := runtimeTimeString(h.store.now())
	for i, agent := range []string{a.ID, b.ID} {
		version := "one"
		if i == 1 {
			version = "two"
		}
		if err = h.deps.Gorm.Exec(`INSERT INTO agent_skills(id,tenant_id,agent_id,skill_id,name,enabled,path,version,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, h.store.id(), "tenant", agent, skill.ID, "legacy", true, "/skills/legacy", version, "installed", now, now).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err = h.canonicalizeSpaceSkills(ctx, "tenant", s.ID); err != nil {
		t.Fatal(err)
	}
	row, err := h.spaceSkillRecord(ctx, "tenant", s.ID, skill.ID)
	if err != nil || row.Status != "conflict" || row.Error == nil {
		t.Fatalf("legacy conflict not persisted %#v %v", row, err)
	}
	if len(h.enabledSpacePromptSkills(ctx, "tenant", a.ID)) != 0 {
		t.Fatal("legacy conflict advertised")
	}
}
func TestSkillsAutoUpdateHonorsSpaceSwitchAndReplacesFiles(t *testing.T) {
	h, s := skillTestHandler(t)
	ctx := context.Background()
	first := []skillFile{{Path: "SKILL.md", Content: "old"}, {Path: "old.txt", Content: "delete"}}
	seedSkillCache(t, h, []skillCachedPackage{{Name: "review", Version: "one", Files: first}})
	skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: "review", Version: "one", Files: first}, json.RawMessage(`{"kind":"github","owner":"anthropics","repo":"skills","ref":"HEAD"}`), func() *string { key := "github:anthropics/skills@HEAD"; return &key }())
	if err != nil {
		t.Fatal(err)
	}
	row, err := h.installSpaceSnapshot(ctx, "tenant", s.ID, skill)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]skillCachedPackage{{Name: "review", Version: "two", Files: []skillFile{{Path: "SKILL.md", Content: "new"}}}})
	if err = h.deps.Gorm.Exec("UPDATE platform_skill_repos SET packages_json=?,version=?", string(raw), "two").Error; err != nil {
		t.Fatal(err)
	}
	if err = h.deps.Gorm.Exec("UPDATE space_skills SET auto_update=false WHERE id=?", row.ID).Error; err != nil {
		t.Fatal(err)
	}
	summary := h.autoUpdateTenant(ctx, "tenant")
	if len(summary.Updated) != 0 {
		t.Fatal("disabled Space auto-update ran")
	}
	_ = h.deps.Gorm.Exec("UPDATE space_skills SET auto_update=true WHERE id=?", row.ID).Error
	summary = h.autoUpdateTenant(ctx, "tenant")
	if len(summary.Updated) != 1 || len(summary.Failed) != 0 {
		t.Fatalf("auto-update %#v", summary)
	}
	root := filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "review")
	data, _ := os.ReadFile(filepath.Join(root, "SKILL.md"))
	if string(data) != "new" {
		t.Fatal("auto-update did not materialize new revision")
	}
	if _, err = os.Stat(filepath.Join(root, "old.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("auto-update retained removed file")
	}
}

func TestSkillsAutoUpdatePreservesLocalEdits(t *testing.T) {
	h, s := skillTestHandler(t)
	ctx := context.Background()
	skill, err := h.registerSkillPackage(ctx, "tenant", skillCachedPackage{Name: "review", Version: "one", Files: []skillFile{{Path: "SKILL.md", Content: "one"}}}, json.RawMessage(`{"kind":"upload"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	row, err := h.installSpaceSnapshot(ctx, "tenant", s.ID, skill)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "review", "SKILL.md")
	if err = os.WriteFile(file, []byte("user edit"), 0640); err != nil {
		t.Fatal(err)
	}
	version := "two"
	if err = h.replaceSpaceSnapshot(ctx, row, []skillFile{{Path: "SKILL.md", Content: "two"}}, &version, false); err == nil {
		t.Fatal("upgrade overwrote local edits")
	}
	data, _ := os.ReadFile(file)
	if string(data) != "user edit" {
		t.Fatal("local edits lost")
	}
}

func TestSkillsPartialInstallReportsCompletedNames(t *testing.T) {
	h, s := skillTestHandler(t)
	seedSkillCache(t, h, []skillCachedPackage{{Name: "first", Files: []skillFile{{Path: "SKILL.md", Content: "first"}}}, {Name: "second", Files: []skillFile{{Path: "SKILL.md", Content: "second"}}}})
	root := filepath.Join(os.Getenv("ZAKURA_WORKSPACE_ROOT"), "tenant", s.ID, "skills", "second")
	if err := os.MkdirAll(root, 0750); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("user-owned"), 0640)
	code, out := skillRequest(t, h, httpx.Principal{TenantID: "tenant"}, "POST", "/spaces/"+s.ID+"/skills/install", map[string]any{"source": "anthropics/skills", "names": []string{"first", "second"}})
	if code != 409 || out["partial"] != true {
		t.Fatalf("partial failure %d %#v", code, out)
	}
	done := out["installed"].([]any)
	if len(done) != 1 || done[0].(map[string]any)["name"] != "first" {
		t.Fatalf("missing completed names %#v", out)
	}
}

func TestSkillsSourceAndFileValidation(t *testing.T) {
	for _, input := range []string{"anthropics/skills@review", "https://github.com/owner/repo/tree/main/skills/review", "npx skills add owner/repo --skill review", "gitlab:owner/repo"} {
		if _, err := parseSkillSource(input); err != nil {
			t.Fatalf("source %s: %v", input, err)
		}
	}
	for _, input := range []string{"http://github.com/a/b", "https://127.0.0.1/a/b", "https://github.com/a/b/tree/main/../../secret"} {
		if _, err := parseSkillSource(input); err == nil {
			t.Fatalf("unsafe source accepted %s", input)
		}
	}
	for _, files := range [][]skillFile{{{Path: "SKILL.md", Content: "ok"}, {Path: "x", Content: "!!!", Encoding: "base64"}}, {{Path: "SKILL.md", Content: "ok"}, {Path: "X", Content: "one"}, {Path: "x", Content: "two"}}, {{Path: "nested/SKILL.md", Content: "bad"}}, {{Path: "/SKILL.md", Content: "bad"}}} {
		if _, err := validateSkillFiles(files); err == nil {
			t.Fatal("invalid package accepted")
		}
	}
}
