package refactor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"path"
	"sort"
	"unicode/utf8"
)

func validName(name string) bool {
	return name != "" && name != "_" && len(name) <= 128 && utf8.ValidString(name) && token.IsIdentifier(name) && !token.Lookup(name).IsKeyword()
}
func compatibleSymbolID(id *ast.Ident, obj types.Object, fset interface {
	Position(token.Pos) token.Position
}, requested string) bool {
	p := fset.Position(id.Pos())
	kind := objectKind(obj)
	candidates := []string{kind}
	if kind == "method" {
		candidates = append(candidates, "interface_method")
	}
	if kind == "type" {
		candidates = append(candidates, "local_type")
	}
	for _, candidate := range candidates {
		digest := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%d", p.Filename, candidate, id.Name, p.Offset)))
		if hex.EncodeToString(digest[:16]) == requested {
			return true
		}
	}
	return false
}
func selectObject(p *parsed, c *checker, req Request) (types.Object, *ast.Ident, error) {
	u := p.units[req.Path]
	if u == nil {
		return nil, nil, ErrInvalid
	}
	var selected types.Object
	var definition *ast.Ident
	for _, result := range c.results {
		for id, obj := range result.info.Defs {
			if obj == nil {
				continue
			}
			pos := p.fset.Position(id.Pos())
			if pos.Filename != req.Path {
				continue
			}
			matches := false
			if req.Offset != nil {
				matches = pos.Offset <= *req.Offset && *req.Offset < pos.Offset+len(id.Name)
			}
			if req.SymbolID != "" {
				matches = compatibleSymbolID(id, obj, p.fset, req.SymbolID)
			}
			if matches {
				if selected != nil && objectKey(selected, p.fset, nil) != objectKey(obj, p.fset, nil) {
					return nil, nil, fmt.Errorf("%w: selection is ambiguous", ErrIncomplete)
				}
				selected = obj
				definition = id
			}
		}
	}
	if selected == nil && req.Offset != nil {
		for _, result := range c.results {
			for id, obj := range result.info.Uses {
				pos := p.fset.Position(id.Pos())
				if pos.Filename == req.Path && pos.Offset <= *req.Offset && *req.Offset < pos.Offset+len(id.Name) {
					if selected != nil && objectKey(selected, p.fset, nil) != objectKey(obj, p.fset, nil) {
						return nil, nil, ErrIncomplete
					}
					selected = obj
					definition = id
				}
			}
		}
	}
	if selected == nil {
		return nil, nil, fmt.Errorf("%w: select a Go declaration identifier or its resolved reference", ErrInvalid)
	}
	if !selected.Pos().IsValid() || p.units[p.fset.Position(selected.Pos()).Filename] == nil {
		return nil, nil, fmt.Errorf("%w: selected object belongs to the standard library or an unsupported dependency", ErrInvalid)
	}
	if selected.Name() == req.NewName {
		return nil, nil, fmt.Errorf("%w: new name matches the current name", ErrInvalid)
	}
	if objectKind(selected) == "unsupported" || selected.Name() == "init" || selected.Name() == "main" && selected.Pkg() != nil && selected.Pkg().Name() == "main" {
		return nil, nil, fmt.Errorf("%w: language entry points cannot be renamed", ErrInvalid)
	}
	return selected, definition, nil
}

// Rename validates both the original and rewritten local graph and additionally
// verifies that every original use still resolves to the same declaration. Go's
// checker has no cancellation hook; the runner executes this bounded operation
// in an isolated helper process that is killed on timeout or cancellation.
func Rename(ctx context.Context, source Source, req Request) (Preview, error) {
	if !validName(req.NewName) || !safePath(req.Path) || req.SnapshotID == "" || req.Offset == nil && req.SymbolID == "" || req.Offset != nil && *req.Offset < 0 {
		return Preview{}, ErrInvalid
	}
	if req.SymbolID != "" {
		if len(req.SymbolID) != 32 {
			return Preview{}, ErrInvalid
		}
		if _, err := hex.DecodeString(req.SymbolID); err != nil {
			return Preview{}, ErrInvalid
		}
	}
	files, err := Load(ctx, source, req.SnapshotID)
	if err != nil {
		return Preview{}, err
	}
	p, err := parse(ctx, files)
	if err != nil {
		return Preview{}, err
	}
	checked, err := check(ctx, p)
	if err != nil {
		return Preview{}, err
	}
	target, _, err := selectObject(p, checked, req)
	if err != nil {
		return Preview{}, err
	}
	if err := ctx.Err(); err != nil {
		return Preview{}, err
	}
	targetKey := objectKey(target, p.fset, nil)
	editSets := map[string]map[int]TextEdit{}
	usePositions := map[string]bool{}
	add := func(ident *ast.Ident, obj types.Object, isUse bool) error {
		pos := p.fset.Position(ident.Pos())
		if p.units[pos.Filename] == nil {
			return nil
		}

		if objectKey(obj, p.fset, nil) != targetKey {
			return nil
		}
		if isUse {
			usePositions[stableIdentKey(ident, p.fset, nil)] = true
		}
		set := editSets[pos.Filename]
		if set == nil {
			set = map[int]TextEdit{}
			editSets[pos.Filename] = set
		}
		set[pos.Offset] = TextEdit{Start: pos.Offset, End: pos.Offset + len(ident.Name), OldText: ident.Name, NewText: req.NewName}
		if len(set) > MaxEdits {
			return ErrLimit
		}
		return nil
	}
	for _, result := range checked.results {
		for ident, obj := range result.info.Defs {
			if obj != nil {
				if err := add(ident, obj, false); err != nil {
					return Preview{}, err
				}
			}
		}
		for ident, obj := range result.info.Uses {
			if obj != nil {
				if err := add(ident, obj, true); err != nil {
					return Preview{}, err
				}
			}
		}
	}
	patches := []FilePatch{}
	patchByPath := map[string]FilePatch{}
	rewritten := MemorySource{Snapshot: req.SnapshotID, FilesByPath: map[string]string{}}
	for file, data := range files.FilesByPath {
		rewritten.FilesByPath[file] = data
	}
	count := 0
	for file, set := range editSets {
		edits := []TextEdit{}
		for _, edit := range set {
			edits = append(edits, edit)
		}
		sort.Slice(edits, func(a, b int) bool { return edits[a].Start < edits[b].Start })
		count += len(edits)
		if count > MaxEdits {
			return Preview{}, ErrLimit
		}
		original := []byte(files.FilesByPath[file])
		patch := FilePatch{Path: file, BeforeHash: hash(original), Edits: edits}
		next, err := Apply(original, patch)
		if err != nil {
			return Preview{}, err
		}
		patch.AfterHash = hash(next)
		rewritten.FilesByPath[file] = string(next)
		patches = append(patches, patch)
		patchByPath[file] = patch
	}
	if len(patches) == 0 {
		return Preview{}, ErrIncomplete
	}
	sort.Slice(patches, func(a, b int) bool { return patches[a].Path < patches[b].Path })
	after, err := parse(ctx, rewritten)
	if err != nil {
		return Preview{}, err
	}
	afterChecked, err := check(ctx, after)
	if err != nil {
		return Preview{}, fmt.Errorf("%w: rewritten graph failed type checking: %v", ErrConflict, err)
	}
	// Comparing object positions after applying the exact edits detects captures
	// and silent changes in overload-free Go resolution, even when code compiles.
	expected := map[string]string{}
	for _, result := range checked.results {
		for ident, obj := range result.info.Uses {
			if obj != nil && p.units[p.fset.Position(ident.Pos()).Filename] != nil {
				expected[stableIdentKey(ident, p.fset, patchByPath)] = objectKey(obj, p.fset, patchByPath)
			}
		}
	}
	for _, result := range afterChecked.results {
		for ident, obj := range result.info.Uses {
			if obj == nil {
				continue
			}
			key := stableIdentKey(ident, after.fset, nil)
			if want, ok := expected[key]; ok && want != objectKey(obj, after.fset, nil) {
				return Preview{}, fmt.Errorf("%w: reference binding changed in %s", ErrConflict, after.fset.Position(ident.Pos()).Filename)
			}
		}
	}
	definitionPos := p.fset.Position(target.Pos())
	selection := Selection{Name: target.Name(), Kind: objectKind(target), Path: definitionPos.Filename, Offset: definitionPos.Offset, Package: target.Pkg().Path(), Exported: target.Exported()}
	packageNames := []string{}
	for key := range checked.results {
		packageNames = append(packageNames, key)
	}
	sort.Strings(packageNames)
	apiChanged := target.Exported() && objectKind(target) != "local" && objectKind(target) != "import"
	warnings := []string{"Only references in this immutable snapshot were checked. External consumers are not included.", "This candidate does not inherit task acceptance or merge approval. Run acceptance checks and human review before publication."}
	if apiChanged {
		warnings = append(warnings, "An exported Go API is being renamed. Existing consumers outside this snapshot can break.")
	}
	if objectKind(target) == "method" {
		warnings = append(warnings, "Interface implementation is checked for uses in this snapshot; absent downstream implementations require review.")
	}
	preview := Preview{Version: Version, SnapshotID: req.SnapshotID, Request: req, Selection: selection, NewName: req.NewName, Files: patches, References: len(usePositions), CheckedPackages: packageNames, ExportedAPIChanged: apiChanged, RequiresHumanReview: true, Warnings: warnings}
	canonical, _ := json.Marshal(preview)
	preview.ID = hash(canonical)
	return preview, nil
}

// Apply checks the original digest and the exact text at each byte range. Edits
// are applied in reverse order so Unicode byte positions stay unambiguous.
func Apply(data []byte, patch FilePatch) ([]byte, error) {
	if hash(data) != patch.BeforeHash {
		return nil, ErrConflict
	}
	previous := 0
	for _, edit := range patch.Edits {
		if edit.Start < previous || edit.Start < 0 || edit.End < edit.Start || edit.End > len(data) || !bytes.Equal(data[edit.Start:edit.End], []byte(edit.OldText)) || !validName(edit.NewText) {
			return nil, ErrConflict
		}
		previous = edit.End
	}
	result := append([]byte{}, data...)
	for n := len(patch.Edits) - 1; n >= 0; n-- {
		edit := patch.Edits[n]
		next := make([]byte, 0, len(result)+len(edit.NewText)-len(edit.OldText))
		next = append(next, result[:edit.Start]...)
		next = append(next, edit.NewText...)
		next = append(next, result[edit.End:]...)
		result = next
	}
	if len(result) > MaxFileBytes {
		return nil, ErrLimit
	}
	if patch.AfterHash != "" && hash(result) != patch.AfterHash {
		return nil, ErrConflict
	}
	return result, nil
}

// FilePaths provides deterministic paths for runner adapters without host-path
// interpretation. The package works exclusively with snapshot-relative names.
func FilePaths(p Preview) []string {
	result := []string{}
	for _, file := range p.Files {
		result = append(result, path.Clean(file.Path))
	}
	return result
}
