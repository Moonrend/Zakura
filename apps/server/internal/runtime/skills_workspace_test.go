// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillFilesLiveInSpaceWorkspace(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
	d := testDeps(t)
	seedTenant(t, d, "tenant")
	store := NewStore(d)
	space, err := store.CreateSpace(context.Background(), "tenant", Space{Name: "Space", WorkspaceKind: "local"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "First", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateAgent(context.Background(), "tenant", Agent{Name: "Second", SpaceID: space.ID})
	if err != nil {
		t.Fatal(err)
	}
	h := &handler{deps: d, store: store}
	files := raw([]skillFile{{Path: "SKILL.md", Content: "# Review"}, {Path: "references/checklist.md", Content: "Check the tests."}})
	// Even an explicit run target must not redirect installation to that computer.
	ctx := context.WithValue(context.Background(), computerExecKey{}, &resolvedExecution{hostRoot: "wrong-computer"})
	if err := h.materializeSkill(ctx, "tenant", first.ID, "review", files); err != nil {
		t.Fatal(err)
	}
	workspace, err := h.workspaceFor(context.Background(), "tenant", second.ID)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(workspace.root, "skills", "review", "references", "checklist.md"))
	if err != nil || string(content) != "Check the tests." {
		t.Fatalf("shared skill content=%q err=%v", content, err)
	}
	data, err := h.readAgentAttachment(ctx, "tenant", second.ID, "/workspace/skills/review/SKILL.md", 100)
	if err != nil || string(data) != "# Review" {
		t.Fatalf("read through server workspace: %q %v", data, err)
	}
	if _, err := h.readAgentAttachment(context.Background(), "tenant", second.ID, "/skills/review/SKILL.md", 2); err == nil {
		t.Fatal("attachment size limit was ignored")
	}
}

func TestSkillFilePathsCannotEscapeInstallation(t *testing.T) {
	for _, name := range []string{"..", "../escape", "foo/../../escape", "bad\\file", "bad\x00file"} {
		t.Run(strings.ReplaceAll(name, "\x00", "NUL"), func(t *testing.T) {
			if _, err := validateSkillFiles([]skillFile{{Path: name, Content: "bad"}}); err == nil {
				t.Fatal("unsafe path accepted")
			}
		})
	}
}

func TestSkillInstallFailureDoesNotClaimInstalled(t *testing.T) {
	t.Setenv("ZAKURA_WORKSPACE_ROOT", t.TempDir())
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
	if err := h.materializeSkill(context.Background(), "tenant", agent.ID, "review", json.RawMessage(`[]`)); err == nil {
		t.Fatal("empty skill was reported as materialized")
	}
}
