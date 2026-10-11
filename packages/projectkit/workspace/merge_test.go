package workspace

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mergeTestFile struct {
	content string
	mode    uint32
}

func mergeTestRepository(t *testing.T, options Options) *Repository {
	t.Helper()
	r, err := New(t.TempDir(), options)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func mergeTestSnapshot(t *testing.T, r *Repository, files map[string]mergeTestFile) Snapshot {
	t.Helper()
	var snapshot Snapshot
	err := r.locked(context.Background(), func() error {
		entries := make([]Entry, 0, len(files))
		for _, path := range sortedMapKeys(files) {
			file := files[path]
			hash, err := r.putObject(context.Background(), []byte(file.content))
			if err != nil {
				return err
			}
			mode := file.mode
			if mode == 0 {
				mode = 0644
			}
			entries = append(entries, Entry{Path: path, Hash: hash, Size: int64(len(file.content)), Mode: mode})
		}
		var err error
		snapshot, err = r.saveSnapshot(context.Background(), entries)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func mergeTestContent(t *testing.T, r *Repository, snapshot Snapshot, path string) string {
	t.Helper()
	for _, entry := range snapshot.Entries {
		if entry.Path == path {
			content, err := r.readObject(entry.Hash, entry.Size)
			if err != nil {
				t.Fatal(err)
			}
			return string(content)
		}
	}
	t.Fatalf("missing %q in %#v", path, snapshot.Entries)
	return ""
}

func mergeTestResolve(t *testing.T, r *Repository, plan MergePlan, resolutions []Resolution) (Snapshot, error) {
	t.Helper()
	var result Snapshot
	err := r.locked(context.Background(), func() error {
		var err error
		result, err = r.resolvePlan(context.Background(), plan, resolutions)
		return err
	})
	return result, err
}

func TestDiffUniqueRenamesAndAmbiguousCopies(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{
		"move.txt": {content: "unique"}, "same-a.txt": {content: "copy"}, "same-b.txt": {content: "copy"},
		"mode.txt": {content: "unchanged"}, "edit.txt": {content: "old"},
	})
	target := mergeTestSnapshot(t, r, map[string]mergeTestFile{
		"moved.txt": {content: "unique", mode: 0755}, "new-a.txt": {content: "copy"}, "new-b.txt": {content: "copy"},
		"mode.txt": {content: "unchanged", mode: 0755}, "edit.txt": {content: "new"},
	})
	changes, err := r.Diff(context.Background(), base.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	counts := make(map[string]int)
	for _, change := range changes {
		counts[change.Kind]++
		if change.Kind == "rename" && (change.OldPath != "move.txt" || change.Path != "moved.txt" || change.After.Mode != 0755) {
			t.Fatalf("rename: %#v", change)
		}
	}
	if counts["rename"] != 1 || counts["add"] != 2 || counts["delete"] != 2 || counts["mode"] != 1 || counts["modify"] != 1 {
		t.Fatalf("changes: %#v", changes)
	}
}

func TestMergeNonOverlappingEditsAndRename(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"file.txt": {content: "one\ntwo\nthree\nfour"}, "old.txt": {content: "rename me"}})
	ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"file.txt": {content: "ONE\ntwo\nthree\nfour"}, "renamed.txt": {content: "rename me"}})
	theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{"file.txt": {content: "one\ntwo\nthree\nFOUR"}, "old.txt": {content: "rename me", mode: 0755}})
	plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Conflicts) != 0 {
		t.Fatalf("unexpected conflicts: %#v", plan.Conflicts)
	}
	if got := mergeTestContent(t, r, plan.Result, "file.txt"); got != "ONE\ntwo\nthree\nFOUR" {
		t.Fatalf("merged text %q", got)
	}
	if len(plan.Result.Entries) != 2 || entryIndex(plan.Result.Entries)["renamed.txt"].Mode != 0755 {
		t.Fatalf("rename/mode result: %#v", plan.Result)
	}
	loaded, err := r.GetMergePlan(context.Background(), plan.ID)
	if err != nil || loaded.ID != plan.ID {
		t.Fatalf("load: %v %#v", err, loaded)
	}
	repeated, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
	if err != nil || repeated.ID != plan.ID {
		t.Fatalf("nondeterministic plan: %v %#v", err, repeated)
	}
}

func TestMergeInsertionBoundariesAndIdenticalEdits(t *testing.T) {
	cases := []struct{ base, ours, theirs, want string }{
		{"a\nb\n", "intro\na\nb\n", "A\nb\n", "intro\nA\nb\n"},
		{"a\nb\n", "a\ninsert\nb\n", "A\nb\n", "A\ninsert\nb\n"},
		{"a\nb\nc\n", "A\nb\nc\n", "A\nb\nC\n", "A\nb\nC\n"},
		{"a\nb\n", "a\n", "a\nb\nlast\n", "a\nlast\n"},
	}
	for _, test := range cases {
		t.Run(test.want, func(t *testing.T) {
			r := mergeTestRepository(t, Options{})
			base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: test.base}})
			ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: test.ours}})
			theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: test.theirs}})
			plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.Conflicts) != 0 {
				t.Fatalf("conflicts: %#v", plan.Conflicts)
			}
			if got := mergeTestContent(t, r, plan.Result, "f"); got != test.want {
				t.Fatalf("got %q want %q", got, test.want)
			}
		})
	}
}

func TestMergeReportsTextBinaryModesAndDeletes(t *testing.T) {
	cases := []struct {
		name, base, ours, theirs, kind string
		baseMode, oursMode, theirsMode uint32
		deleted                        bool
	}{
		{name: "text", base: "line\n", ours: "ours\n", theirs: "theirs\n", kind: "text"},
		{name: "binary", base: "\x00a", ours: "\x00b", theirs: "\x00c", kind: "binary"},
		{name: "mode", base: "same", ours: "same", theirs: "same", kind: "mode", baseMode: 0644, oursMode: 0600, theirsMode: 0755},
		{name: "delete", base: "old", theirs: "new", kind: "delete/modify", deleted: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			r := mergeTestRepository(t, Options{})
			base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: test.base, mode: test.baseMode}})
			ofiles := map[string]mergeTestFile{"f": {content: test.ours, mode: test.oursMode}}
			if test.deleted {
				delete(ofiles, "f")
			}
			ours := mergeTestSnapshot(t, r, ofiles)
			theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: test.theirs, mode: test.theirsMode}})
			plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.Conflicts) != 1 || plan.Conflicts[0].Kind != test.kind {
				t.Fatalf("conflicts: %#v", plan.Conflicts)
			}
			if plan.Result.ID != ours.ID {
				t.Fatalf("conflicted preview changed ours: %#v", plan.Result)
			}
			if test.kind == "text" && !strings.Contains(plan.Conflicts[0].Preview, "<<<<<<< ours") {
				t.Fatal("missing conflict preview")
			}
			if test.kind == "binary" && plan.Conflicts[0].Preview != "" {
				t.Fatal("binary content leaked into textual preview")
			}
		})
	}
}

func TestMergeRenameDeleteAndRenameRename(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"old": {content: "same"}})
	ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"ours": {content: "same"}})
	for _, test := range []struct {
		files map[string]mergeTestFile
		kind  string
	}{
		{map[string]mergeTestFile{}, "rename/delete"},
		{map[string]mergeTestFile{"theirs": {content: "same"}}, "rename/rename"},
	} {
		theirs := mergeTestSnapshot(t, r, test.files)
		plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(plan.Conflicts) != 1 || plan.Conflicts[0].Kind != test.kind {
			t.Fatalf("conflicts: %#v", plan.Conflicts)
		}
		result, err := mergeTestResolve(t, r, plan, []Resolution{{ConflictID: plan.Conflicts[0].ID, Choice: "ours", Destination: "chosen"}})
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Entries) != 1 || result.Entries[0].Path != "chosen" {
			t.Fatalf("destination: %#v", result)
		}
	}
}

func TestMergeCollisionRetainsValidOursAndRequiresAllResolutions(t *testing.T) {
	for _, prefix := range []bool{false, true} {
		t.Run(map[bool]string{false: "same-path", true: "prefix"}[prefix], func(t *testing.T) {
			r := mergeTestRepository(t, Options{})
			base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"old": {content: "original"}})
			ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"old": {content: "original"}, "dest": {content: "ours addition"}, "dest-z": {content: "sorting interposition"}})
			destination := "dest"
			if prefix {
				destination = "dest/child"
			}
			theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{destination: {content: "original"}})
			plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.Conflicts) != 2 || plan.Result.ID != ours.ID {
				t.Fatalf("collision preview: %#v", plan)
			}
			if _, err := mergeTestResolve(t, r, plan, nil); !errors.Is(err, ErrUnresolved) {
				t.Fatalf("missing resolutions: %v", err)
			}
			resolutions := make([]Resolution, 0, len(plan.Conflicts))
			for _, conflict := range plan.Conflicts {
				if !strings.Contains(conflict.Kind, "path-collision") {
					t.Fatalf("kind: %#v", conflict)
				}
				choice := "theirs"
				if conflict.Base == nil {
					choice = "delete"
				}
				resolutions = append(resolutions, Resolution{ConflictID: conflict.ID, Choice: choice})
			}
			result, err := mergeTestResolve(t, r, plan, resolutions)
			if err != nil {
				t.Fatal(err)
			}
			if got := mergeTestContent(t, r, result, destination); got != "original" {
				t.Fatalf("resolved content %q", got)
			}
			for index, resolution := range resolutions {
				if resolution.Choice == "theirs" {
					resolution.Destination = "dest-z"
					resolutions[index] = resolution
					break
				}
			}
			if _, err := mergeTestResolve(t, r, plan, resolutions); !errors.Is(err, ErrUnresolved) {
				t.Fatalf("overwrite accepted: %v", err)
			}
			for index, resolution := range resolutions {
				if resolution.Choice == "theirs" {
					resolutions[index].Destination = "dest-z/child"
				}
			}
			if _, err := mergeTestResolve(t, r, plan, resolutions); !errors.Is(err, ErrUnresolved) {
				t.Fatalf("prefix collision accepted: %v", err)
			}
		})
	}
}

func TestMergeResolutionValidationAndContent(t *testing.T) {
	r := mergeTestRepository(t, Options{MaxFileBytes: 64})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "old\n"}})
	ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "ours\n"}})
	theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "theirs\n"}})
	plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
	if err != nil {
		t.Fatal(err)
	}
	id := plan.Conflicts[0].ID
	invalid := []Resolution{
		{ConflictID: "unknown", Choice: "ours"},
		{ConflictID: id, Choice: "unsupported"},
		{ConflictID: id, Choice: "ours", Content: []byte("ignored")},
		{ConflictID: id, Choice: "delete", Destination: "x"},
		{ConflictID: id, Choice: "content", Content: []byte("new"), Destination: "../escape"},
		{ConflictID: id, Choice: "content", Content: []byte("new"), Mode: 04755},
		{ConflictID: id, Choice: "content", Content: bytes.Repeat([]byte("x"), 65)},
	}
	for _, resolution := range invalid {
		if _, err := mergeTestResolve(t, r, plan, []Resolution{resolution}); err == nil {
			t.Fatalf("accepted invalid resolution: %#v", resolution)
		}
	}
	if _, err := mergeTestResolve(t, r, plan, []Resolution{{ConflictID: id, Choice: "ours"}, {ConflictID: id, Choice: "ours"}}); err == nil {
		t.Fatal("duplicate accepted")
	}
	result, err := mergeTestResolve(t, r, plan, []Resolution{{ConflictID: id, Choice: "content", Content: []byte{}, Mode: 0600, Destination: "empty"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 1 || result.Entries[0].Size != 0 || result.Entries[0].Mode != 0600 || mergeTestContent(t, r, result, "empty") != "" {
		t.Fatalf("empty resolution %#v", result)
	}
}

func TestMergePlanTamperingAndMissingObjects(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "old"}})
	ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "ours"}})
	theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "theirs"}})
	plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(r.root, "plans", plan.ID+".json")
	if err := atomicJSON(path, MergePlan{ID: plan.ID, Base: plan.Base, Ours: plan.Ours, Theirs: plan.Theirs, Result: base}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.GetMergePlan(context.Background(), plan.ID); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("tampering: %v", err)
	}
	if err := atomicJSON(path, plan); err != nil {
		t.Fatal(err)
	}
	forged := plan
	forged.Result = base
	forged.Result.TotalBytes++
	forged.ID = planDigest(forged)
	if err := atomicJSON(filepath.Join(r.root, "plans", forged.ID+".json"), forged); err != nil {
		t.Fatal(err)
	}
	if _, err := r.GetMergePlan(context.Background(), forged.ID); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("forged result manifest: %v", err)
	}
	if _, err := r.GetMergePlan(context.Background(), "../escape"); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("unsafe plan path: %v", err)
	}
	// Every referenced object must still validate when a persisted plan is read.
	object := ours.Entries[0]
	objectPath := filepath.Join(r.root, "objects", object.Hash[:2], object.Hash[2:])
	if _, err := os.Stat(objectPath); errors.Is(err, os.ErrNotExist) {
		objectPath = filepath.Join(r.root, "objects", object.Hash)
	}
	if err := os.WriteFile(objectPath, []byte("bad"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.GetMergePlan(context.Background(), plan.ID); err == nil {
		t.Fatal("corrupt object accepted")
	}
}

func TestMergeBudgetAndCancellation(t *testing.T) {
	r := mergeTestRepository(t, Options{MaxTextBytes: 4})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "long original"}})
	ours := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "long ours"}})
	theirs := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "long theirs"}})
	plan, err := r.PlanMerge(context.Background(), base.ID, ours.ID, theirs.ID)
	if err != nil || len(plan.Conflicts) != 1 || plan.Conflicts[0].Kind != "text-limit" {
		t.Fatalf("text size budget: %v %#v", err, plan)
	}
	budget := int64(1)
	if _, ok, err := textEdits(context.Background(), []string{"a"}, []string{"b"}, &budget); err != nil || ok {
		t.Fatalf("LCS budget: %v %v", ok, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.PlanMerge(ctx, base.ID, ours.ID, theirs.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestComposeIndependentHeadsAndConflictProvenance(t *testing.T) {
	r := mergeTestRepository(t, Options{})
	base := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "a\nb\nc\n"}})
	first := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "A\nb\nc\n"}})
	second := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "a\nb\nC\n"}})
	third := mergeTestSnapshot(t, r, map[string]mergeTestFile{"f": {content: "other\nb\nc\n"}})
	composition, err := r.Compose(context.Background(), base.ID, []string{first.ID, second.ID, third.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(composition.Plans) != 3 || len(composition.Conflicts) != 1 || composition.Conflicts[0].Source != third.ID {
		t.Fatalf("composition: %#v", composition)
	}
	if got := mergeTestContent(t, r, composition.Snapshot, "f"); got != "A\nb\nC\n" {
		t.Fatalf("conflicted composition altered accepted edits %q", got)
	}
	if _, err := r.GetMergePlan(context.Background(), composition.Plans[2].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Compose(context.Background(), base.ID, []string{first.ID, first.ID}); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate head: %v", err)
	}
}

func FuzzTextEditsReconstructTarget(f *testing.F) {
	f.Add("a\nb\nc\n", "a\nB\nc\n")
	f.Add("", "insert\n")
	f.Add("one\ntwo", "two")
	f.Fuzz(func(t *testing.T, base, side string) {
		if len(base) > 2048 || len(side) > 2048 {
			t.Skip()
		}
		before, after := textLines([]byte(base)), textLines([]byte(side))
		budget := int64(8_000_000)
		edits, ok, err := textEdits(context.Background(), before, after, &budget)
		if err != nil || !ok {
			t.Fatalf("small diff failed %v %v", ok, err)
		}
		var result strings.Builder
		position := 0
		for _, edit := range edits {
			if edit.start < position || edit.end < edit.start || edit.end > len(before) {
				t.Fatalf("invalid edit %#v", edit)
			}
			for _, line := range before[position:edit.start] {
				result.WriteString(line)
			}
			for _, line := range edit.lines {
				result.WriteString(line)
			}
			position = edit.end
		}
		for _, line := range before[position:] {
			result.WriteString(line)
		}
		if result.String() != side {
			t.Fatalf("reconstructed %q want %q", result.String(), side)
		}
	})
}
