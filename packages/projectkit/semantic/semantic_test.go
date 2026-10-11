package semantic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type memorySource map[string]map[string]string

func (m memorySource) Files(_ context.Context, id string) ([]InputFile, error) {
	files, ok := m[id]
	if !ok {
		return nil, ErrNotFound
	}
	r := []InputFile{}
	for p, s := range files {
		h := sha256.Sum256([]byte(s))
		r = append(r, InputFile{Path: p, Hash: hex.EncodeToString(h[:]), Size: int64(len(s))})
	}
	return r, nil
}
func (m memorySource) Read(_ context.Context, id, p string) ([]byte, error) {
	s, ok := m[id][p]
	if !ok {
		return nil, ErrNotFound
	}
	return []byte(s), nil
}
func indexFor(t *testing.T, m map[string]string) *Index {
	t.Helper()
	i, err := Build(context.Background(), memorySource{"s": m}, "s", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	return i
}
func symbol(t *testing.T, i *Index, p, name, kind string) Symbol {
	t.Helper()
	for _, f := range i.Files {
		if f.Path == p {
			for _, s := range f.Symbols {
				if s.Name == name && s.Kind == kind {
					return s
				}
			}
		}
	}
	t.Fatalf("missing %s %s in %s", kind, name, p)
	return Symbol{}
}
func TestGoDeclarationNavigationAndUnicodePositions(t *testing.T) {
	i := indexFor(t, map[string]string{
		"go.mod":        "module example.com/project\ngo 1.23\n",
		"math/value.go": "package math\ntype Box[T any] struct { Value T }\nfunc (b *Box[T]) Get(first string, second ...int) (value T, err error) { return b.Value, nil }\nfunc 加法(甲 int) int { 乙 := 甲 + 1; return 乙 }\n",
		"math/use.go":   "package math\nfunc Use() int { return 加法(3) }\n",
		"main.go":       "package main\nimport \"example.com/project/math\"\nfunc Main() { math.Use() }\n",
	})
	get := symbol(t, i, "math/value.go", "Get", "method")
	if get.Receiver != "Box" || get.Signature != "(*Box[T]).Get(string, ...int) (T, error)" {
		t.Fatalf("signature %#v", get)
	}
	add := symbol(t, i, "math/value.go", "加法", "function")
	if add.Selection.Start.Column != 6 || add.Selection.End.Column != 8 || add.Selection.End.Offset-add.Selection.Start.Offset != 6 {
		t.Fatalf("rune positions: %#v", add.Selection)
	}
	nav, err := i.Navigate(add.ID, 100)
	if err != nil || nav.Total != 1 || nav.References[0].Path != "math/use.go" || nav.References[0].Kind != "call" {
		t.Fatalf("navigation %#v %v", nav, err)
	}
	local := symbol(t, i, "math/value.go", "乙", "local")
	nav, err = i.Navigate(local.ID, 100)
	if err != nil || nav.Total != 1 {
		t.Fatalf("local nav %#v %v", nav, err)
	}
	use := symbol(t, i, "math/use.go", "Use", "function")
	nav, err = i.Navigate(use.ID, 100)
	if err != nil || nav.Total != 1 || nav.References[0].Path != "main.go" || nav.References[0].Confidence != "syntax" {
		t.Fatalf("import navigation %#v %v", nav, err)
	}
	if !i.Complete {
		t.Fatalf("unexpected incomplete %#v", i.Diagnostics)
	}
}
func TestGoAPIDiffAndTransitiveImpact(t *testing.T) {
	source := memorySource{
		"before": {"go.mod": "module example.com/p\n", "lib/a.go": "package lib\nfunc Exported(name string) int { return 1 }\ntype Interface interface { Existing() }\n", "lib/a_test.go": "package lib\nfunc test() { Exported(\"x\") }\n", "app/b.go": "package app\nimport \"example.com/p/lib\"\nfunc B() { lib.Exported(\"x\") }\n", "cli/c.go": "package cli\nimport \"example.com/p/app\"\nfunc C() { app.B() }\n"},
		"after":  {"go.mod": "module example.com/p\n", "lib/a.go": "package lib\nfunc Exported(count int) int { return count }\ntype Interface interface { Existing(); Added() }\n", "lib/a_test.go": "package lib\nfunc test() { Exported(3) }\n", "app/b.go": "package app\nimport \"example.com/p/lib\"\nfunc B() { lib.Exported(\"x\") }\n", "cli/c.go": "package cli\nimport \"example.com/p/app\"\nfunc C() { app.B() }\n"},
	}
	a, err := Build(context.Background(), source, "before", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	b, err := Build(context.Background(), source, "after", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	c, err := Compare(a, b)
	if err != nil {
		t.Fatal(err)
	}
	breaking := map[string]bool{}
	for _, change := range c.APIChanges {
		if change.Classification == "breaking" {
			for _, s := range append(change.Before, change.After...) {
				breaking[s.Name] = true
			}
		}
	}
	if !breaking["Exported"] || !breaking["Added"] {
		t.Fatalf("API changes %#v", c.APIChanges)
	}
	found := false
	for _, impact := range c.Impacted {
		if impact.Path == "cli/c.go" {
			found = true
			if !reflect.DeepEqual(impact.Via, []string{"lib/a.go", "app/b.go", "cli/c.go"}) {
				t.Fatalf("impact path %#v", impact)
			}
		}
	}
	if !found {
		t.Fatal("missing transitive impact")
	}
	if len(c.RelatedTests) == 0 || c.RelatedTests[0].Path != "lib/a_test.go" {
		t.Fatalf("tests %#v", c.RelatedTests)
	}
	// Parameter names are not Go call compatibility constraints.
	afterRename := indexFor(t, map[string]string{"a.go": "package p\nfunc F(second int, third string) (result int) { return 1 }\n"})
	beforeRename := indexFor(t, map[string]string{"a.go": "package p\nfunc F(first int, other string) (value int) { return 1 }\n"})
	renamed, err := Compare(beforeRename, afterRename)
	if err != nil || len(renamed.APIChanges) != 0 {
		t.Fatalf("parameter rename produced changes: %#v %v", renamed.APIChanges, err)
	}
}
func TestExportRemovalAndConditionalAmbiguity(t *testing.T) {
	a := indexFor(t, map[string]string{"a.go": "package p\nfunc Removed() {}\n"})
	b := indexFor(t, map[string]string{"a.go": "package p\nfunc Added() {}\n"})
	c, _ := Compare(a, b)
	found := false
	for _, change := range c.APIChanges {
		if change.Kind == "removed" && change.Classification == "breaking" {
			found = true
		}
	}
	if !found {
		t.Fatalf("removal %#v", c.APIChanges)
	}
	conditional := indexFor(t, map[string]string{"unix.go": "//go:build linux\npackage p\nfunc Platform(x int) {}\n", "windows.go": "//go:build windows\npackage p\nfunc Platform(x string) {}\n", "use.go": "package p\nfunc Use() { Platform(1) }\n"})
	r := symbol(t, conditional, "unix.go", "Platform", "function")
	nav, _ := conditional.Navigate(r.ID, 100)
	if nav.Total != 1 || nav.References[0].Confidence != "ambiguous" || len(nav.References[0].SymbolIDs) != 2 {
		t.Fatalf("conditional ref %#v", nav)
	}
	changed := indexFor(t, map[string]string{"unix.go": "//go:build linux\npackage p\nfunc Platform(x bool) {}\n", "windows.go": "//go:build windows\npackage p\nfunc Platform(x string) {}\n"})
	c, _ = Compare(conditional, changed)
	for _, change := range c.APIChanges {
		if strings.Contains(change.Key, "Platform") && change.Classification != "unknown" {
			t.Fatalf("conditional change falsely certain %#v", change)
		}
	}
}
func TestImportCyclesAndNestedModules(t *testing.T) {
	i := indexFor(t, map[string]string{"go.mod": "module example.com/root\n", "a/a.go": "package a\nimport \"example.com/root/b\"\nfunc A() { b.B() }\n", "b/b.go": "package b\nimport \"example.com/root/a\"\nfunc B() { a.A() }\n", "nested/go.mod": "module example.com/nested\n", "nested/x/x.go": "package x\nfunc X() {}\n", "use.go": "package root\nimport \"example.com/nested/x\"\nfunc Use() { x.X() }\n"})
	if len(i.Cycles) != 1 || !reflect.DeepEqual(i.Cycles[0].Files, []string{"a/a.go", "b/b.go"}) {
		t.Fatalf("cycles %#v", i.Cycles)
	}
	file, err := i.File("use.go")
	if err != nil || len(file.File.Imports) != 1 || !reflect.DeepEqual(file.File.Imports[0].Targets, []string{"nested/x/x.go"}) {
		t.Fatalf("nested module %#v %v", file, err)
	}
}
func TestScriptLexicalSafetyExportsAndDependencies(t *testing.T) {
	i := indexFor(t, map[string]string{
		"src/a.ts":      "// export function Fake() {}\nconst text = \"export function AlsoFake() {}\";\nconst regexp = /export function RegexFake\\(\\)/;\nconst template = `export function TemplateFake() {}`;\nexport function real(名字: string): number { return 1; }\nexport { real as alias };\nimport { other } from './b';\nother();\n",
		"src/b.ts":      "export const other = () => 2;\n",
		"src/a.test.ts": "import { real } from './a'; real('x');\n",
	})
	if i.Complete {
		t.Fatal("lexical analysis must remain explicitly partial")
	}
	r, _ := i.Search(SearchQuery{Query: "Fake"})
	if r.Total != 0 {
		t.Fatalf("literal/comment declarations leaked %#v", r)
	}
	real := symbol(t, i, "src/a.ts", "real", "function")
	if !real.Exported || real.Confidence != "lexical" {
		t.Fatalf("real %#v", real)
	}
	alias := symbol(t, i, "src/a.ts", "alias", "export")
	if !alias.Exported {
		t.Fatal("alias not exported")
	}
	f, _ := i.File("src/a.ts")
	if len(f.File.Imports) != 1 || !reflect.DeepEqual(f.File.Imports[0].Targets, []string{"src/b.ts"}) {
		t.Fatalf("import %#v", f.File.Imports)
	}
	c, _ := Compare(i, indexFor(t, map[string]string{"src/a.ts": "export function replacement() {}\n"}))
	for _, change := range c.APIChanges {
		if change.Classification == "breaking" {
			t.Fatalf("lexical API must not claim typechecked break %#v", change)
		}
	}
}
func TestResourceLimitsPartialDataAndStableOutput(t *testing.T) {
	m := memorySource{"s": {"a.go": "package p\nfunc A() {}\n", "b.go": "package p\nfunc B() {}\n"}}
	full, err := Build(context.Background(), m, "s", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	small, err := Build(context.Background(), m, "s", Limits{MaxFiles: 1})
	if err != nil {
		t.Fatal(err)
	}
	if small.Complete || small.SkippedFiles != 1 {
		t.Fatalf("file budget %#v", small.Summary())
	}
	c, _ := Compare(full, small)
	for _, change := range c.APIChanges {
		if change.Kind == "removed" && change.Classification == "breaking" {
			t.Fatalf("omitted file removal %#v", change)
		}
	}
	tiny, err := Build(context.Background(), m, "s", Limits{MaxNodes: 1})
	if err != nil || tiny.Complete {
		t.Fatalf("node limit %v %#v", err, tiny)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = Build(ctx, m, "s", DefaultLimits())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel %v", err)
	}
	r, err := full.Search(SearchQuery{Limit: 1})
	if err != nil || !r.Truncated || r.Total != 2 {
		t.Fatalf("search window %#v %v", r, err)
	}
	if _, err := full.File("../a.go"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unsafe path %v", err)
	}
	first, _ := json.Marshal(full.Summary())
	other := indexFor(t, m["s"])
	second, _ := json.Marshal(other.Summary())
	if string(first) != string(second) {
		t.Fatalf("unstable JSON\n%s\n%s", first, second)
	}
}
func TestRenameAmbiguityAndBinaryGeneratedSources(t *testing.T) {
	a := indexFor(t, map[string]string{"old1.go": "package p\n", "old2.go": "package p\n"})
	b := indexFor(t, map[string]string{"new1.go": "package p\n", "new2.go": "package p\n"})
	c, _ := Compare(a, b)
	for _, change := range c.Changes {
		if change.Kind == "rename_candidate" {
			t.Fatalf("ambiguous rename %#v", change)
		}
	}
	if len(c.Diagnostics) == 0 {
		t.Fatal("rename ambiguity diagnostic absent")
	}
	i := indexFor(t, map[string]string{"generated.go": "// Code generated by tool. DO NOT EDIT.\npackage p\nfunc G() {}\n", "binary.go": "package p\x00\xff"})
	f, _ := i.File("generated.go")
	if !f.File.Generated {
		t.Fatal("generated flag absent")
	}
	f, _ = i.File("binary.go")
	if f.File.Status != "skipped" || i.Complete {
		t.Fatalf("binary %#v", f)
	}
}

func TestGenericParameterRenamesAndSignatureBudgets(t *testing.T) {
	before := indexFor(t, map[string]string{"a.go": "package p\ntype Box[T any] struct { Value T }\nfunc F[T ~int | ~string](value T) T { return value }\nfunc (b *Box[T]) Get() T { return b.Value }\n"})
	after := indexFor(t, map[string]string{"a.go": "package p\ntype Box[T any] struct { Value T }\nfunc F[U ~int | ~string](item U) U { return item }\nfunc (b *Box[U]) Get() U { return b.Value }\n"})
	diff, err := Compare(before, after)
	if err != nil || len(diff.APIChanges) != 0 {
		t.Fatalf("generic alpha rename changed API %#v %v", diff.APIChanges, err)
	}
	ty := symbol(t, before, "a.go", "Box", "type")
	if !strings.HasPrefix(ty.Signature, "Box[T any]") {
		t.Fatalf("type params missing: %q", ty.Signature)
	}
	a := indexFor(t, map[string]string{"a.go": "package p\nfunc F[T any](value struct{ T T }) {}\n"})
	b := indexFor(t, map[string]string{"a.go": "package p\nfunc F[U any](value struct{ U U }) {}\n"})
	diff, err = Compare(a, b)
	if err != nil || len(diff.APIChanges) != 1 {
		t.Fatalf("field rename was incorrectly alpha normalized %#v %v", diff.APIChanges, err)
	}
	huge := "package p\ntype Huge struct {\n"
	for n := 0; n < 1000; n++ {
		huge += "Field" + strings.Repeat("x", n%20) + " " + "int\n"
	}
	huge += "}\n"
	indexed := indexFor(t, map[string]string{"a.go": huge})
	s := symbol(t, indexed, "a.go", "Huge", "type")
	if !s.SignatureTruncated || len(s.Signature) > 4096 || indexed.Complete {
		t.Fatalf("signature limit not enforced len=%d truncated=%v complete=%v", len(s.Signature), s.SignatureTruncated, indexed.Complete)
	}
}
