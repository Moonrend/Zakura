// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/runtime/builtins"
	"github.com/go-chi/chi/v5"
)

var builtinVersionPattern = regexp.MustCompile(`^builtin-[0-9a-f]{12}$`)

func builtinManifestParts(t *testing.T, manifest string) (name, description, body string) {
	t.Helper()
	rest, ok := strings.CutPrefix(manifest, "---\n")
	if !ok {
		t.Fatalf("manifest missing frontmatter: %q", manifest[:min(20, len(manifest))])
	}
	end := strings.Index(rest, "\n---\n")
	if end < 0 {
		t.Fatal("manifest missing frontmatter terminator")
	}
	for _, line := range strings.Split(rest[:end], "\n") {
		if v, ok := strings.CutPrefix(line, "name: "); ok {
			name = v
		}
		if v, ok := strings.CutPrefix(line, "description: "); ok {
			description = v
		}
	}
	body = rest[end+len("\n---\n"):]
	return
}

func TestBuiltinSkillDefinitions(t *testing.T) {
	defs := builtins.All()
	if len(defs) != 19 {
		t.Fatalf("expected 19 builtin skills, got %d", len(defs))
	}
	recommended := 0
	seen := map[string]bool{}
	for _, d := range defs {
		if d.Name == "" || d.Title == "" || d.Description == "" {
			t.Fatalf("incomplete definition: %#v", d)
		}
		if seen[d.Name] {
			t.Fatalf("duplicate builtin name %q", d.Name)
		}
		seen[d.Name] = true
		if !builtinVersionPattern.MatchString(d.Version()) {
			t.Fatalf("bad version %q for %s", d.Version(), d.Name)
		}
		manifest := d.Manifest()
		if strings.Contains(manifest, "${") {
			t.Fatalf("unresolved placeholder in %s", d.Name)
		}
		name, description, body := builtinManifestParts(t, manifest)
		if name != d.Name {
			t.Fatalf("frontmatter name %q != %q", name, d.Name)
		}
		if description != d.Description {
			t.Fatalf("frontmatter description mismatch for %s", d.Name)
		}
		if strings.TrimSpace(body) == "" {
			t.Fatalf("empty body for %s", d.Name)
		}
		if d.Recommended {
			recommended++
		}
	}
	if recommended != 7 {
		t.Fatalf("expected 7 recommended builtin skills, got %d", recommended)
	}
}

func TestBuiltinSkillSyncAndAutoUpdate(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant-sync")
	seedTenant(t, d, "tenant-autoupdate")
	h := &handler{deps: d, store: NewStore(d)}
	ctx := context.Background()

	if n := h.syncBuiltinSkills(ctx, "tenant-sync"); n != 19 {
		t.Fatalf("first sync inserted %d, want 19", n)
	}
	if n := h.syncBuiltinSkills(ctx, "tenant-sync"); n != 0 {
		t.Fatalf("second sync changed %d, want 0", n)
	}
	var stored int64
	if err := d.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("tenant_id = ? AND builtin = true", "tenant-sync").Count(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored != 19 {
		t.Fatalf("stored builtin rows = %d, want 19", stored)
	}
	var row models.Skill
	if err := d.Gorm.WithContext(ctx).Where("tenant_id = ? AND builtin = true AND name = ?", "tenant-sync", "find-skills").Take(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.Version == nil || !builtinVersionPattern.MatchString(*row.Version) {
		t.Fatalf("stored version invalid: %v", row.Version)
	}
	if row.AutoUpdate {
		t.Fatal("builtin row must not auto-update")
	}
	if row.RepoKey != nil {
		t.Fatal("builtin row must have null repo_key")
	}
	if !strings.Contains(row.FilesJSON, `"encoding":"utf8"`) || !strings.Contains(row.FilesJSON, `"size":`) {
		t.Fatalf("files_json missing encoding/size: %s", row.FilesJSON)
	}

	summary := h.autoUpdateTenant(ctx, "tenant-autoupdate")
	if summary.BuiltinSynced <= 0 {
		t.Fatalf("autoUpdate builtin pass synced %d, want > 0", summary.BuiltinSynced)
	}
	var storedAuto int64
	if err := d.Gorm.WithContext(ctx).Model(&models.Skill{}).Where("tenant_id = ? AND builtin = true", "tenant-autoupdate").Count(&storedAuto).Error; err != nil {
		t.Fatal(err)
	}
	if storedAuto != 19 {
		t.Fatalf("autoUpdate stored %d builtin rows, want 19", storedAuto)
	}
}

func TestInstallRecommendedBuiltinSkills(t *testing.T) {
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "S", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "A", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	h.installRecommendedSkills(context.Background(), "tenant", agent.ID)
	var count int64
	if err := d.Gorm.WithContext(context.Background()).Model(&models.AgentSkill{}).Where("tenant_id = ? AND agent_id = ?", "tenant", agent.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 7 {
		t.Fatalf("recommended skills installed = %d, want 7", count)
	}
}

func TestInstallBuiltinSkillViaAPI(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	client := server.Client()
	code, out := doJSON(t, client, "POST", server.URL+"/api/spaces", token, map[string]any{"name": "S", "workspaceKind": "local"})
	if code != 201 {
		t.Fatalf("space: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/agents", token, map[string]any{"name": "A", "spaceId": out["id"]})
	if code != 201 {
		t.Fatalf("agent: %d %#v", code, out)
	}
	code, out = doJSON(t, client, "POST", server.URL+"/api/skills/install", token, map[string]any{"source": "builtin:find-skills", "all": true})
	if code != 200 {
		t.Fatalf("install builtin: %d %#v", code, out)
	}
	skills, _ := out["skills"].([]any)
	found := false
	for _, s := range skills {
		if m, ok := s.(map[string]any); ok && m["name"] == "find-skills" {
			found = true
		}
	}
	if !found {
		t.Fatalf("find-skills not returned after builtin install: %#v", out)
	}
	code, out = doJSON(t, client, "GET", server.URL+"/api/skills/stores", token, nil)
	if code != 200 {
		t.Fatalf("stores: %d %#v", code, out)
	}
	catalog, _ := out["builtin"].([]any)
	if len(catalog) != 19 {
		t.Fatalf("builtin catalog length = %d, want 19", len(catalog))
	}
}
