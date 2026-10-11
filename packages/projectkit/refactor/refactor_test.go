package refactor

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
)

func offset(source, identifier string) *int { n := strings.Index(source, identifier); return &n }
func renamedFiles(t *testing.T, source MemorySource, preview Preview) map[string]string {
	t.Helper()
	result := map[string]string{}
	for p, data := range source.FilesByPath {
		result[p] = data
	}
	for _, patch := range preview.Files {
		changed, err := Apply([]byte(source.FilesByPath[patch.Path]), patch)
		if err != nil {
			t.Fatal(err)
		}
		result[patch.Path] = string(changed)
	}
	return result
}
func TestRenameAcrossLocalImportsAndShadowedScopes(t *testing.T) {
	files := MemorySource{Snapshot: "s", FilesByPath: map[string]string{
		"go.mod":        "module example.com/project\ngo 1.23\n",
		"lib/a.go":      "package lib\n// Exported appears in documentation.\nfunc Exported(value int) int { return value + 1 }\nfunc Inner() { Exported := func() int { return 7 }; _ = Exported() }\nconst Message = \"Exported\"\n",
		"app/use.go":    "package app\nimport dep \"example.com/project/lib\"\nfunc Use() int { return dep.Exported(1) }\n",
		"lib/a_test.go": "package lib\nfunc testUse() int { return Exported(2) }\n",
	}}
	preview, err := Rename(context.Background(), files, Request{SnapshotID: "s", Path: "lib/a.go", Offset: offset(files.FilesByPath["lib/a.go"], "Exported(value"), NewName: "Calculate"})
	if err != nil {
		t.Fatal(err)
	}
	if !preview.ExportedAPIChanged || !preview.RequiresHumanReview || len(preview.Files) != 3 || preview.References != 2 {
		t.Fatalf("preview %#v", preview)
	}
	changed := renamedFiles(t, files, preview)
	if !strings.Contains(changed["app/use.go"], "dep.Calculate(1)") || !strings.Contains(changed["lib/a_test.go"], "Calculate(2)") || !strings.Contains(changed["lib/a.go"], "Exported :=") || !strings.Contains(changed["lib/a.go"], `"Exported"`) || !strings.Contains(changed["lib/a.go"], "// Exported appears") {
		t.Fatalf("wrong edits %#v", changed)
	}
	again, err := Rename(context.Background(), files, preview.Request)
	if err != nil || again.ID != preview.ID {
		t.Fatalf("unstable preview %s %s %v", preview.ID, again.ID, err)
	}
}
func TestRenameSymbolIDMethodsGenericFieldsAndUnicode(t *testing.T) {
	source := "package p\ntype Box[T any] struct { Value T }\nfunc (b *Box[T]) Get() T { return b.Value }\nfunc Use() int { b := Box[int]{Value: 2}; return b.Get() }\nfunc 加法(甲 int) int { return 甲 + 1 }\nfunc Unicode() int { return 加法(3) }\n"
	files := MemorySource{Snapshot: "s", FilesByPath: map[string]string{"a.go": source}}
	index, err := semantic.Build(context.Background(), files, "s", semantic.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	search, err := index.Search(semantic.SearchQuery{Query: "Get", Kind: "method"})
	if err != nil || len(search.Symbols) != 1 {
		t.Fatalf("index %#v %v", search, err)
	}
	preview, err := Rename(context.Background(), files, Request{SnapshotID: "s", Path: "a.go", SymbolID: search.Symbols[0].ID, NewName: "Read"})
	if err != nil {
		t.Fatal(err)
	}
	changed := renamedFiles(t, files, preview)
	if !strings.Contains(changed["a.go"], "b.Read()") || !strings.Contains(changed["a.go"], ") Read() T") {
		t.Fatalf("method rename %s", changed["a.go"])
	}
	preview, err = Rename(context.Background(), files, Request{SnapshotID: "s", Path: "a.go", Offset: offset(source, "加法(甲"), NewName: "计算"})
	if err != nil {
		t.Fatal(err)
	}
	changed = renamedFiles(t, files, preview)
	if !strings.Contains(changed["a.go"], "计算(3)") {
		t.Fatalf("unicode %s", changed["a.go"])
	}
	preview, err = Rename(context.Background(), files, Request{SnapshotID: "s", Path: "a.go", Offset: offset(source, "Value T"), NewName: "Item"})
	if err != nil {
		t.Fatal(err)
	}
	changed = renamedFiles(t, files, preview)
	if !strings.Contains(changed["a.go"], "b.Item") || !strings.Contains(changed["a.go"], "Item: 2") {
		t.Fatalf("field rename %s", changed["a.go"])
	}
}
func TestImportAliasAndReferenceSelection(t *testing.T) {
	files := MemorySource{Snapshot: "s", FilesByPath: map[string]string{"go.mod": "module example.com/p\n", "lib/a.go": "package lib\nfunc F() int { return 1 }\n", "a.go": "package p\nimport dep \"example.com/p/lib\"\nfunc Use() int { return dep.F() }\n"}}
	preview, err := Rename(context.Background(), files, Request{SnapshotID: "s", Path: "a.go", Offset: offset(files.FilesByPath["a.go"], "dep \""), NewName: "local"})
	if err != nil {
		t.Fatal(err)
	}
	result := renamedFiles(t, files, preview)
	if !strings.Contains(result["a.go"], `import local "example.com/p/lib"`) || !strings.Contains(result["a.go"], "local.F()") {
		t.Fatalf("alias %s", result["a.go"])
	}
	preview, err = Rename(context.Background(), files, Request{SnapshotID: "s", Path: "a.go", Offset: offset(files.FilesByPath["a.go"], "F()"), NewName: "G"})
	if err != nil {
		t.Fatal(err)
	}
	if preview.Selection.Path != "lib/a.go" || len(preview.Files) != 2 {
		t.Fatalf("reference selection %#v", preview)
	}
}
func TestRenameRejectsCollisionsBindingCaptureAndIncompleteTypes(t *testing.T) {
	for _, test := range []struct {
		source, selection, name string
		expected                error
	}{
		{"package p\nfunc A() {}\nfunc B() {}\n", "A()", "B", ErrConflict},
		{"package p\nvar x = 1\nfunc F() { y := 2; _ = x; _ = y }\n", "x =", "y", ErrConflict},

		{"package p\nimport \"example.com/missing\"\nfunc F() { missing.X() }\n", "F()", "G", ErrIncomplete},
		{"//go:build linux\npackage p\nfunc F() {}\n", "F()", "G", ErrIncomplete},
		{"package p\nfunc F() { unknown() }\n", "F()", "G", ErrIncomplete},
	} {
		files := MemorySource{Snapshot: "s", FilesByPath: map[string]string{"a.go": test.source}}
		_, err := Rename(context.Background(), files, Request{SnapshotID: "s", Path: "a.go", Offset: offset(test.source, test.selection), NewName: test.name})
		if !errors.Is(err, test.expected) {
			t.Fatalf("%s ->%s: expected %v got %v", test.selection, test.name, test.expected, err)
		}
	}
	platform := MemorySource{Snapshot: "s", FilesByPath: map[string]string{"a_windows.go": "package p\nfunc F() {}\n"}}
	_, err := Rename(context.Background(), platform, Request{SnapshotID: "s", Path: "a_windows.go", Offset: offset(platform.FilesByPath["a_windows.go"], "F()"), NewName: "G"})
	if !errors.Is(err, ErrIncomplete) {
		t.Fatalf("platform ambiguity %v", err)
	}
}
func TestPatchDigestAndRangesAreMandatory(t *testing.T) {
	data := []byte("package p\nvar 名字 = 1\n")
	start := strings.Index(string(data), "名字")
	patch := FilePatch{Path: "a.go", BeforeHash: hash(data), Edits: []TextEdit{{Start: start, End: start + len("名字"), OldText: "名字", NewText: "名称"}}}
	changed, err := Apply(data, patch)
	if err != nil || !strings.Contains(string(changed), "名称") {
		t.Fatalf("patch %s %v", changed, err)
	}
	if _, err := Apply(append(data, byte('\n')), patch); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale digest %v", err)
	}
	patch.Edits[0].Start++
	if _, err := Apply(data, patch); !errors.Is(err, ErrConflict) {
		t.Fatalf("misaligned Unicode %v", err)
	}
	files := MemorySource{Snapshot: "s", FilesByPath: map[string]string{"a.go": "package p\nfunc F() {}\n"}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = Rename(ctx, files, Request{SnapshotID: "s", Path: "a.go", Offset: offset(files.FilesByPath["a.go"], "F()"), NewName: "G"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel %v", err)
	}
	if !reflect.DeepEqual(FilePaths(Preview{Files: []FilePatch{{Path: "a.go"}}}), []string{"a.go"}) {
		t.Fatal("path helper")
	}
}
