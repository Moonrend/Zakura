package refactor

import (
	"context"
	"fmt"
	"go/ast"
	"go/importer"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type checkedPackage struct {
	pkg   *types.Package
	info  *types.Info
	units []*unit
}
type checker struct {
	ctx      context.Context
	parsed   *parsed
	results  map[string]*checkedPackage
	loading  map[string]bool
	standard types.Importer
}

func newChecker(ctx context.Context, p *parsed) *checker {
	return &checker{ctx: ctx, parsed: p, results: map[string]*checkedPackage{}, loading: map[string]bool{}, standard: importer.ForCompiler(p.fset, "source", nil)}
}
func info() *types.Info {
	return &types.Info{Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}, Scopes: map[ast.Node]*types.Scope{}, Implicits: map[ast.Node]types.Object{}, Types: map[ast.Expr]types.TypeAndValue{}}
}
func (c *checker) Import(importPath string) (*types.Package, error) {
	if err := c.ctx.Err(); err != nil {
		return nil, err
	}
	if importPath == "unsafe" {
		return types.Unsafe, nil
	}
	if _, ok := c.parsed.packages[importPath]; ok {
		result, err := c.local(importPath, false)
		if err != nil {
			return nil, err
		}
		return result.pkg, nil
	}
	// Source importing is restricted to the installed Go standard library. This
	// excludes vendor/GOPATH/module caches and never fetches a third-party module.
	if importPath == "" || strings.ContainsAny(importPath, "\\\x00") || strings.HasPrefix(importPath, "/") || strings.Contains(importPath, "..") {
		return nil, ErrIncomplete
	}
	directory := filepath.Join(runtime.GOROOT(), "src", filepath.FromSlash(importPath))
	st, err := os.Stat(directory)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("%w: external dependency %s is not in this snapshot or the standard library", ErrIncomplete, importPath)
	}
	actual, err := filepath.EvalSymlinks(directory)
	if err != nil || actual != directory {
		return nil, ErrIncomplete
	}
	result, err := c.standard.Import(importPath)
	if err != nil {
		return nil, fmt.Errorf("%w: standard library %s could not be loaded", ErrIncomplete, importPath)
	}
	return result, nil
}
func (c *checker) local(packagePath string, includeTests bool) (*checkedPackage, error) {
	if err := c.ctx.Err(); err != nil {
		return nil, err
	}
	key := packagePath
	if includeTests {
		key += "#internal-tests"
	}
	if result, ok := c.results[key]; ok {
		return result, nil
	}
	if c.loading[key] {
		return nil, fmt.Errorf("%w: local import cycle includes %s", ErrIncomplete, packagePath)
	}
	c.loading[key] = true
	defer delete(c.loading, key)
	units := []*unit{}
	for _, u := range c.parsed.packages[packagePath] {
		if includeTests || !u.test || strings.HasSuffix(packagePath, "_test") {
			units = append(units, u)
		}
	}
	if len(units) == 0 {
		return nil, fmt.Errorf("%w: package %s contains only internal test files", ErrIncomplete, packagePath)
	}
	trees := []*ast.File{}
	for _, u := range units {
		trees = append(trees, u.tree)
	}
	result := &checkedPackage{info: info(), units: units}
	messages := []string{}
	cfg := types.Config{Importer: c, GoVersion: "go1.23", Error: func(err error) {
		if len(messages) < 10 {
			message := err.Error()
			if len(message) > 512 {
				message = message[:512]
			}
			messages = append(messages, message)
		}
	}}
	pkg, err := cfg.Check(packagePath, c.parsed.fset, trees, result.info)
	if ctxErr := c.ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrIncomplete, strings.Join(messages, "; "))
	}
	result.pkg = pkg
	c.results[key] = result
	return result, nil
}
func check(ctx context.Context, p *parsed) (*checker, error) {
	c := newChecker(ctx, p)
	keys := []string{}
	for key := range p.packages {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, err := c.local(key, false); err != nil {
			return nil, err
		}
		internalTests := false
		for _, u := range p.packages[key] {
			if u.test && !strings.HasSuffix(key, "_test") {
				internalTests = true
				break
			}
		}
		if internalTests {
			if _, err := c.local(key, true); err != nil {
				return nil, err
			}
		}
	}
	return c, nil
}
func objectKind(obj types.Object) string {
	switch o := obj.(type) {
	case *types.Func:
		if signature, ok := o.Type().(*types.Signature); ok && signature.Recv() != nil {
			return "method"
		}
		return "function"
	case *types.TypeName:
		return "type"
	case *types.Const:
		return "constant"
	case *types.Var:
		if o.IsField() {
			return "field"
		}
		if o.Parent() != nil && o.Pkg() != nil && o.Parent() == o.Pkg().Scope() {
			return "variable"
		}
		return "local"
	case *types.PkgName:
		return "import"
	}
	return "unsupported"
}
func objectKey(obj types.Object, fset *token.FileSet, patches map[string]FilePatch) string {
	if obj == nil {
		return ""
	}
	pkg := "builtin"
	if obj.Pkg() != nil {
		pkg = obj.Pkg().Path()
	}
	p := fset.Position(obj.Pos())
	offset := p.Offset
	if patch, ok := patches[p.Filename]; ok {
		offset = shiftOffset(offset, patch.Edits)
	}
	if !obj.Pos().IsValid() {
		return pkg + "::" + objectKind(obj) + "::" + obj.Name()
	}
	return fmt.Sprintf("%s::%s::%s::%d", pkg, objectKind(obj), p.Filename, offset)
}
func stableIdentKey(id *ast.Ident, fset *token.FileSet, patches map[string]FilePatch) string {
	pos := fset.Position(id.Pos())
	offset := pos.Offset
	if patch, ok := patches[pos.Filename]; ok {
		offset = shiftOffset(offset, patch.Edits)
	}
	return fmt.Sprintf("%s::%d", pos.Filename, offset)
}
func shiftOffset(offset int, edits []TextEdit) int {
	result := offset
	for _, edit := range edits {
		if edit.Start < offset {
			result += len(edit.NewText) - len(edit.OldText)
		}
	}
	return result
}
