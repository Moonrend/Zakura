package semantic

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

var limitations = []string{
	"Go analysis uses syntax trees and conservative package-level name resolution; it does not type-check code or resolve external modules.",
	"Build constraints are reported but not evaluated for a target platform. Multiple candidate definitions remain ambiguous.",
	"TypeScript and JavaScript analysis is lexical and partial; overloads, computed exports, templates and dynamic module paths are not type-checked.",
	"Dependency impact and related tests are evidence-based candidates, not proof of runtime reachability or test coverage.",
}

func validPath(p string) bool {
	return p != "" && p != "." && len(p) <= 4096 && utf8.ValidString(p) && !strings.HasPrefix(p, "/") && !strings.ContainsAny(p, "\\\x00") && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../")
}
func normalizedLimits(l Limits) Limits {
	d := DefaultLimits()
	if l.MaxFiles > 0 && l.MaxFiles < d.MaxFiles {
		d.MaxFiles = l.MaxFiles
	}
	if l.MaxFileBytes > 0 && l.MaxFileBytes < d.MaxFileBytes {
		d.MaxFileBytes = l.MaxFileBytes
	}
	if l.MaxTotalBytes > 0 && l.MaxTotalBytes < d.MaxTotalBytes {
		d.MaxTotalBytes = l.MaxTotalBytes
	}
	if l.MaxEdges > 0 && l.MaxEdges < d.MaxEdges {
		d.MaxEdges = l.MaxEdges
	}
	if l.MaxNodes > 0 && l.MaxNodes < d.MaxNodes {
		d.MaxNodes = l.MaxNodes
	}
	if l.MaxSymbols > 0 && l.MaxSymbols < d.MaxSymbols {
		d.MaxSymbols = l.MaxSymbols
	}
	if l.MaxReferences > 0 && l.MaxReferences < d.MaxReferences {
		d.MaxReferences = l.MaxReferences
	}
	if l.MaxDiagnostics > 0 && l.MaxDiagnostics < d.MaxDiagnostics {
		d.MaxDiagnostics = l.MaxDiagnostics
	}
	if l.MaxResults > 0 && l.MaxResults < d.MaxResults {
		d.MaxResults = l.MaxResults
	}
	return d
}
func language(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "javascript"
	}
	return ""
}
func testFile(p string) bool {
	base := strings.ToLower(path.Base(p))
	return strings.HasSuffix(base, "_test.go") || strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") || strings.HasPrefix(base, "test_") || strings.Contains("/"+p+"/", "/__tests__/")
}
func emptyFile(p, h, lang string) File {
	return File{Path: p, Hash: h, Language: lang, Test: testFile(p), Status: "indexed", BuildConditions: []string{}, Symbols: []Symbol{}, Imports: []Import{}, References: []Reference{}, Diagnostics: []Diagnostic{}}
}
func symbolID(p, kind, name string, offset int) string {
	s := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%d", p, kind, name, offset)))
	return hex.EncodeToString(s[:16])
}
func apiKey(f File, kind, name, receiver string) string {
	if f.Language == "go" {
		return path.Dir(f.Path) + "::" + f.Package + "::" + receiver + "::" + name
	}
	return f.Path + "::" + name
}
func diagnostic(p, code, msg, severity string) Diagnostic {
	return Diagnostic{Path: p, Code: code, Message: msg, Severity: severity}
}
func generatedSource(data []byte) bool {
	head := data
	if len(head) > 4096 {
		head = head[:4096]
	}
	for _, line := range strings.Split(string(head), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "// Code generated ") && strings.HasSuffix(strings.TrimSpace(line), " DO NOT EDIT.") {
			return true
		}
	}
	return bytes.Contains(head, []byte("@generated"))
}

type buildState struct {
	nodes, symbols, references int
	limits                     Limits
	stopped                    bool
}

func (b *buildState) node() bool {
	b.nodes++
	if b.nodes > b.limits.MaxNodes {
		b.stopped = true
		return false
	}
	return true
}
func (b *buildState) addSymbol(f *File, s Symbol) bool {
	if b.symbols >= b.limits.MaxSymbols {
		b.stopped = true
		return false
	}
	if len(s.Signature) > 4096 || strings.Contains(s.Signature, signatureLimitMarker) {
		if len(s.Signature) > 4096 {
			s.Signature = s.Signature[:4096]
			for !utf8.ValidString(s.Signature) && len(s.Signature) > 0 {
				s.Signature = s.Signature[:len(s.Signature)-1]
			}
		}
		s.SignatureTruncated = true
		f.Status = "partial"
		found := false
		for _, d := range f.Diagnostics {
			if d.Code == "signature_limit" {
				found = true
				break
			}
		}
		if !found {
			f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "signature_limit", "Large declaration signatures are omitted at 4096 bytes; API compatibility remains unknown.", "warning"))
		}
	}
	b.symbols++
	f.Symbols = append(f.Symbols, s)
	return true
}
func (b *buildState) addReference(f *File, r Reference) bool {
	if b.references >= b.limits.MaxReferences {
		b.stopped = true
		return false
	}
	b.references++
	f.References = append(f.References, r)
	return true
}

// Build reads only entries advertised by the snapshot source. Ordering is stable
// and every budget is enforced across the complete index, not per file alone.
func Build(ctx context.Context, source Source, snapshotID string, limits Limits) (*Index, error) {
	if source == nil || snapshotID == "" || len(snapshotID) > 128 {
		return nil, ErrInvalid
	}
	limits = normalizedLimits(limits)
	entries, err := source.Files(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	index := &Index{SnapshotID: snapshotID, Version: Version, Entries: entries, Files: []File{}, Diagnostics: []Diagnostic{}, Edges: []Edge{}, Cycles: []Cycle{}, Complete: true, Limits: limits}
	state := &buildState{limits: limits}
	total := int64(0)
	modules := map[string]string{}
	seen := map[string]bool{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !validPath(entry.Path) || seen[entry.Path] || entry.Size < 0 {
			return nil, ErrInvalid
		}
		seen[entry.Path] = true
		lang := language(entry.Path)
		isModule := path.Base(entry.Path) == "go.mod"
		if lang == "" && !isModule {
			continue
		}
		if len(index.Files) >= limits.MaxFiles || state.stopped {
			index.SkippedFiles++
			index.Complete = false
			continue
		}
		if entry.Size > limits.MaxFileBytes || entry.Size > limits.MaxTotalBytes-total {
			index.SkippedFiles++
			index.Complete = false
			index.addDiagnostic(diagnostic(entry.Path, "size_limit", "File omitted by semantic index byte limits.", "warning"))
			continue
		}
		data, err := source.Read(ctx, snapshotID, entry.Path)
		if err != nil {
			return nil, err
		}
		if int64(len(data)) != entry.Size {
			return nil, fmt.Errorf("%w: snapshot file size changed", ErrInvalid)
		}
		if int64(len(data)) > limits.MaxFileBytes || int64(len(data)) > limits.MaxTotalBytes-total {
			return nil, ErrLimit
		}
		total += int64(len(data))
		if isModule {
			if module := modulePath(data); module != "" {
				modules[path.Dir(entry.Path)] = module
			}
			continue
		}
		f := emptyFile(entry.Path, entry.Hash, lang)
		f.Generated = generatedSource(data)
		if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			f.Status = "skipped"
			f.Diagnostics = append(f.Diagnostics, diagnostic(entry.Path, "binary_source", "Binary or invalid UTF-8 source omitted.", "warning"))
			index.SkippedFiles++
			index.Complete = false
			index.Files = append(index.Files, f)
			continue
		}
		if lang == "go" {
			parseGo(ctx, &f, data, state)
		} else {
			parseScript(ctx, &f, data, state)
		}
		if f.Status != "indexed" {
			index.Complete = false
		}
		index.Files = append(index.Files, f)
	}
	if state.stopped {
		index.Complete = false
		index.addDiagnostic(diagnostic("", "index_limit", "Index AST/token, symbol or reference limit reached; missing declarations must not be treated as removals.", "warning"))
	}
	if index.SkippedFiles > 0 {
		index.addDiagnostic(diagnostic("", "incomplete_index", fmt.Sprintf("%d source entries were omitted or skipped.", index.SkippedFiles), "warning"))
	}
	resolve(index, modules)
	index.Cycles = dependencyCycles(index.Files, index.Edges)
	for i := range index.Files {
		f := &index.Files[i]
		sort.Slice(f.Symbols, func(a, b int) bool { return f.Symbols[a].Selection.Start.Offset < f.Symbols[b].Selection.Start.Offset })
		sort.Slice(f.References, func(a, b int) bool { return f.References[a].Range.Start.Offset < f.References[b].Range.Start.Offset })
		for _, d := range f.Diagnostics {
			index.addDiagnostic(d)
		}
	}
	sort.Slice(index.Diagnostics, func(i, j int) bool {
		a, b := index.Diagnostics[i], index.Diagnostics[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Code != b.Code {
			return a.Code < b.Code
		}
		return a.Message < b.Message
	})
	return index, nil
}
func (i *Index) addDiagnostic(d Diagnostic) {
	if len(i.Diagnostics) < i.Limits.MaxDiagnostics {
		i.Diagnostics = append(i.Diagnostics, d)
	} else {
		i.Complete = false
	}
}
func modulePath(data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "module ") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				return strings.Trim(parts[1], "\"")
			}
		}
	}
	return ""
}
func (i *Index) Summary() Summary {
	result := Summary{SnapshotID: i.SnapshotID, Version: i.Version, Complete: i.Complete, SkippedFiles: i.SkippedFiles, Files: []FileSummary{}, Diagnostics: i.Diagnostics, Edges: i.Edges, Cycles: i.Cycles, Limitations: append([]string{}, limitations...)}
	for _, f := range i.Files {
		if f.Status != "skipped" {
			result.IndexedFiles++
		}
		result.Symbols += len(f.Symbols)
		result.References += len(f.References)
		result.Files = append(result.Files, FileSummary{Path: f.Path, Language: f.Language, Package: f.Package, Generated: f.Generated, Test: f.Test, Status: f.Status, Symbols: len(f.Symbols), References: len(f.References)})
	}
	return result
}
func (i *Index) File(p string) (FileResult, error) {
	if !validPath(p) {
		return FileResult{}, ErrInvalid
	}
	for _, f := range i.Files {
		if f.Path == p {
			r := FileResult{SnapshotID: i.SnapshotID, Version: i.Version, File: f, Dependencies: []Edge{}, Dependents: []Edge{}}
			for _, e := range i.Edges {
				if e.From == p {
					r.Dependencies = append(r.Dependencies, e)
				}
				if e.To == p {
					r.Dependents = append(r.Dependents, e)
				}
			}
			return r, nil
		}
	}
	return FileResult{}, ErrNotFound
}
func (i *Index) Search(q SearchQuery) (SearchResult, error) {
	if len(q.Query) > 256 || len(q.Path) > 4096 || q.Offset < 0 || q.Offset > 1000000 {
		return SearchResult{}, ErrInvalid
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > i.Limits.MaxResults {
		limit = i.Limits.MaxResults
	}
	query := strings.ToLower(strings.TrimSpace(q.Query))
	prefix := q.Path
	if prefix != "" && !validPath(prefix) {
		return SearchResult{}, ErrInvalid
	}
	r := SearchResult{SnapshotID: i.SnapshotID, Version: i.Version, Symbols: []Symbol{}}
	for _, f := range i.Files {
		if prefix != "" && f.Path != prefix && !strings.HasPrefix(f.Path, prefix+"/") {
			continue
		}
		for _, s := range f.Symbols {
			if q.ExportedOnly && !s.Exported || q.Kind != "" && q.Kind != s.Kind {
				continue
			}
			if query != "" && !strings.Contains(strings.ToLower(s.Name), query) && !strings.Contains(strings.ToLower(s.Key), query) {
				continue
			}
			r.Total++
			if r.Total > q.Offset && len(r.Symbols) < limit {
				r.Symbols = append(r.Symbols, s)
			}
		}
	}
	r.Truncated = q.Offset+len(r.Symbols) < r.Total
	return r, nil
}
func (i *Index) Navigate(id string, limit int) (Navigation, error) {
	if len(id) != 32 {
		return Navigation{}, ErrInvalid
	}
	if _, err := hex.DecodeString(id); err != nil {
		return Navigation{}, ErrInvalid
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > i.Limits.MaxResults {
		limit = i.Limits.MaxResults
	}
	r := Navigation{SnapshotID: i.SnapshotID, References: []Reference{}}
	found := false
	for _, f := range i.Files {
		for _, s := range f.Symbols {
			if s.ID == id {
				r.Symbol = s
				found = true
				break
			}
		}
	}
	if !found {
		return r, ErrNotFound
	}
	for _, f := range i.Files {
		for _, ref := range f.References {
			for _, candidate := range ref.SymbolIDs {
				if candidate == id {
					r.Total++
					if len(r.References) < limit {
						r.References = append(r.References, ref)
					}
					break
				}
			}
		}
	}
	r.Truncated = r.Total > len(r.References)
	return r, nil
}

// EstimatedBytes is deliberately conservative and used to bound in-memory caches.
func (i *Index) EstimatedBytes() int64 {
	n := int64(2048)
	for _, entry := range i.Entries {
		n += int64(128 + len(entry.Path) + len(entry.Hash))
	}
	for _, f := range i.Files {
		n += int64(len(f.Path) + len(f.Hash) + len(f.Package) + 512)
		for _, s := range f.Symbols {
			n += int64(512 + len(s.Signature) + len(s.Name) + len(s.Key))
		}
		for _, r := range f.References {
			n += int64(256 + len(r.Name) + len(r.SymbolIDs)*64)
		}
		for _, v := range f.Imports {
			n += int64(256 + len(v.Path) + len(v.Targets)*128)
		}
		n += int64(len(f.Diagnostics) * 512)
	}
	n += int64(len(i.Edges)*256 + len(i.Diagnostics)*512)
	return n
}
