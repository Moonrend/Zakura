package semantic

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/scanner"
	"go/token"
	"io"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"
)

type sourcePositions struct {
	data   []byte
	starts []int
}

func positions(data []byte) sourcePositions {
	p := sourcePositions{data: data, starts: []int{0}}
	for i, b := range data {
		if b == '\n' {
			p.starts = append(p.starts, i+1)
		}
	}
	return p
}
func (p sourcePositions) at(offset int) Position {
	if offset < 0 {
		offset = 0
	}
	if offset > len(p.data) {
		offset = len(p.data)
	}
	lo, hi := 0, len(p.starts)
	for lo+1 < hi {
		mid := (lo + hi) / 2
		if p.starts[mid] <= offset {
			lo = mid
		} else {
			hi = mid
		}
	}
	return Position{Offset: offset, Line: lo + 1, Column: utf8.RuneCount(p.data[p.starts[lo]:offset]) + 1}
}
func (p sourcePositions) rangeAt(start, end int) Range {
	return Range{Start: p.at(start), End: p.at(end)}
}

type signatureWriter struct {
	bytes.Buffer
	remaining int
	truncated bool
}

func (w *signatureWriter) Write(data []byte) (int, error) {
	if len(data) > w.remaining {
		n, _ := w.Buffer.Write(data[:w.remaining])
		w.remaining = 0
		w.truncated = true
		return n, io.ErrShortWrite
	}
	n, err := w.Buffer.Write(data)
	w.remaining -= n
	return n, err
}

const signatureLimitMarker = " [signature limit]"

func astString(node any) string {
	w := &signatureWriter{remaining: 4096}
	err := printer.Fprint(w, token.NewFileSet(), node)
	if w.truncated {
		value := w.String()
		for !utf8.ValidString(value) && len(value) > 0 {
			value = value[:len(value)-1]
		}
		return value + signatureLimitMarker
	}
	if err != nil {
		return ""
	}
	return w.String()
}
func normalizedFields(list *ast.FieldList, keepNames bool) *ast.FieldList {
	if list == nil {
		return nil
	}
	r := &ast.FieldList{List: []*ast.Field{}}
	for _, f := range list.List {
		copy := &ast.Field{Type: f.Type, Tag: f.Tag}
		if keepNames {
			copy.Names = f.Names
			r.List = append(r.List, copy)
			continue
		}
		if len(f.Names) > 1 {
			for range f.Names {
				r.List = append(r.List, &ast.Field{Type: f.Type})
			}
		} else {
			r.List = append(r.List, copy)
		}
	}
	return r
}
func functionSignature(name, receiver string, ft *ast.FuncType) string {
	copy := &ast.FuncType{TypeParams: normalizedFields(ft.TypeParams, true), Params: normalizedFields(ft.Params, false), Results: normalizedFields(ft.Results, false)}
	text := astString(copy)
	prefix := name
	if receiver != "" {
		prefix = "(" + receiver + ")." + name
	}
	return prefix + strings.TrimPrefix(text, "func")
}
func receiverBase(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.StarExpr:
		return receiverBase(e.X)
	case *ast.IndexExpr:
		return receiverBase(e.X)
	case *ast.IndexListExpr:
		return receiverBase(e.X)
	case *ast.ParenExpr:
		return receiverBase(e.X)
	}
	return astString(expr)
}
func parseGo(ctx context.Context, f *File, data []byte, state *buildState) {
	ps := positions(data)
	fset := token.NewFileSet()
	tree, err := parser.ParseFile(fset, f.Path, data, parser.ParseComments|parser.AllErrors)
	if err != nil {
		f.Status = "partial"
		if list, ok := err.(scanner.ErrorList); ok {
			for _, problem := range list {
				if len(f.Diagnostics) >= 50 {
					break
				}
				r := ps.rangeAt(problem.Pos.Offset, problem.Pos.Offset)
				f.Diagnostics = append(f.Diagnostics, Diagnostic{Path: f.Path, Code: "go_parse", Message: problem.Msg, Severity: "error", Range: &r})
			}
		} else {
			f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "go_parse", err.Error(), "error"))
		}
	}
	if tree == nil {
		return
	}
	f.Package = tree.Name.Name
	ast.Inspect(tree, func(node ast.Node) bool {
		if node == nil {
			return true
		}
		if state.stopped || ctx.Err() != nil {
			return false
		}
		return state.node()
	})
	if state.stopped {
		f.Status = "partial"
		f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "index_limit", "AST node budget was exhausted before indexing this file.", "warning"))
		return
	}
	if ctx.Err() != nil {
		return
	}

	pos := func(n ast.Node) Range {
		return ps.rangeAt(fset.Position(n.Pos()).Offset, fset.Position(n.End()).Offset)
	}
	declarations := map[*ast.Ident]string{}
	objectIDs := map[*ast.Object]string{}
	add := func(id *ast.Ident, node ast.Node, kind, receiver, signature string, exported bool) {
		if id == nil || id.Name == "_" {
			return
		}
		selection := pos(id)
		s := Symbol{ID: symbolID(f.Path, kind, id.Name, selection.Start.Offset), Key: apiKey(*f, kind, id.Name, receiver), Name: id.Name, Kind: kind, Path: f.Path, Package: f.Package, Receiver: receiver, Exported: exported, Signature: signature, Range: pos(node), Selection: selection, Confidence: "syntax"}
		if len(f.BuildConditions) > 0 {
			s.Confidence = "conditional"
		}
		if state.addSymbol(f, s) {
			declarations[id] = s.ID
			if id.Obj != nil {
				objectIDs[id.Obj] = s.ID
			}
		}
	}
	for _, group := range tree.Comments {
		for _, comment := range group.List {
			s := strings.TrimSpace(comment.Text)
			if strings.HasPrefix(s, "//go:build ") || strings.HasPrefix(s, "// +build ") {
				f.BuildConditions = append(f.BuildConditions, s)
			}
		}
	}
	if len(f.BuildConditions) > 0 {
		f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "build_conditions", "Build conditions are preserved without evaluating GOOS, GOARCH or custom tags.", "info"))
	}
	for _, spec := range tree.Imports {
		importPath, e := strconv.Unquote(spec.Path.Value)
		if e != nil {
			continue
		}
		name := path.Base(importPath)
		if spec.Name != nil {
			name = spec.Name.Name
			add(spec.Name, spec, "import", "", importPath, false)
		}
		f.Imports = append(f.Imports, Import{Path: importPath, Name: name, ExplicitAlias: spec.Name != nil, Range: pos(spec.Path), Targets: []string{}, Confidence: "unresolved"})
	}
	for _, decl := range tree.Decls {
		if err := ctx.Err(); err != nil {
			return
		}
		switch d := decl.(type) {
		case *ast.FuncDecl:
			receiver, base := "", ""
			if d.Recv != nil && len(d.Recv.List) > 0 {
				receiver = astString(d.Recv.List[0].Type)
				base = receiverBase(d.Recv.List[0].Type)
			}
			kind := "function"
			if receiver != "" {
				kind = "method"
			}
			add(d.Name, d, kind, base, functionSignature(d.Name.Name, receiver, d.Type), ast.IsExported(d.Name.Name))
			if len(f.Symbols) > 0 && f.Symbols[len(f.Symbols)-1].Name == d.Name.Name {
				var recv ast.Expr
				if d.Recv != nil && len(d.Recv.List) > 0 {
					recv = d.Recv.List[0].Type
				}
				shape := functionShape(d.Name.Name, recv, d.Type)
				if !strings.Contains(shape, signatureLimitMarker) && !f.Symbols[len(f.Symbols)-1].SignatureTruncated {
					f.Symbols[len(f.Symbols)-1].SignatureHash = signatureHash(shape)
				} else {
					f.Symbols[len(f.Symbols)-1].SignatureTruncated = true
					f.Status = "partial"
				}
			}
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					signature := s.Name.Name
					if s.TypeParams != nil {
						signature += typeParameterSignature(s.TypeParams)
					}
					if s.Assign.IsValid() {
						signature += " ="
					}
					signature += " " + astString(s.Type)
					add(s.Name, s, "type", "", signature, ast.IsExported(s.Name.Name))
					var fields []*ast.Field
					fieldKind := "field"
					switch t := s.Type.(type) {
					case *ast.StructType:
						fields = t.Fields.List
					case *ast.InterfaceType:
						fields = t.Methods.List
						fieldKind = "interface_method"
					}
					for _, field := range fields {
						for _, id := range field.Names {
							signature := id.Name + " " + astString(field.Type)
							if ft, ok := field.Type.(*ast.FuncType); ok {
								signature = functionSignature(id.Name, "", ft)
							}
							if field.Tag != nil {
								signature += " " + field.Tag.Value
							}
							add(id, field, fieldKind, s.Name.Name, signature, ast.IsExported(id.Name))
						}
					}
				case *ast.ValueSpec:
					kind := "variable"
					if d.Tok == token.CONST {
						kind = "constant"
					}
					for n, id := range s.Names {
						signature := id.Name
						if s.Type != nil {
							signature += " " + astString(s.Type)
						}
						if n < len(s.Values) {
							signature += " = " + astString(s.Values[n])
						} else if len(s.Values) == 1 {
							signature += " = " + astString(s.Values[0])
						}
						add(id, s, kind, "", signature, ast.IsExported(id.Name))
					}
				}
			}
		}
	}
	// Locals are indexed to make local definition navigation useful. Their keys
	// include source offsets so they cannot accidentally be treated as APIs.
	ast.Inspect(tree, func(node ast.Node) bool {
		if node == nil {
			return true
		}
		if state.stopped || ctx.Err() != nil {
			return false
		}
		id, ok := node.(*ast.Ident)
		if !ok || id.Obj == nil || declarations[id] != "" || id.Obj.Pos() != id.Pos() {
			return true
		}
		kind := "local"
		if id.Obj.Kind == ast.Typ {
			kind = "local_type"
		}
		add(id, id, kind, "", id.Name, false)
		return true
	})
	parents := []ast.Node{}
	ast.Inspect(tree, func(node ast.Node) bool {
		if node == nil {
			if len(parents) > 0 {
				parents = parents[:len(parents)-1]
			}
			return true
		}
		if state.stopped || ctx.Err() != nil {
			return false
		}
		var parent ast.Node
		if len(parents) > 0 {
			parent = parents[len(parents)-1]
		}
		parents = append(parents, node)
		id, ok := node.(*ast.Ident)
		if !ok || id == tree.Name || declarations[id] != "" || id.Name == "_" {
			return true
		}
		ref := Reference{Path: f.Path, Name: id.Name, Kind: "reference", Range: pos(id), SymbolIDs: []string{}, Confidence: "unresolved"}
		if call, ok := parent.(*ast.CallExpr); ok && call.Fun == id {
			ref.Kind = "call"
		}
		if selector, ok := parent.(*ast.SelectorExpr); ok && selector.Sel == id {
			ref.Kind = "selector"
			if x, ok := selector.X.(*ast.Ident); ok {
				ref.Qualifier = x.Name
			}
			if len(parents) >= 3 {
				if c, ok := parents[len(parents)-3].(*ast.CallExpr); ok && c.Fun == selector {
					ref.Kind = "selector_call"
				}
			}
		}
		if id.Obj != nil && objectIDs[id.Obj] != "" {
			ref.SymbolIDs = append(ref.SymbolIDs, objectIDs[id.Obj])
			ref.Confidence = "syntax"
			if len(f.BuildConditions) > 0 {
				ref.Confidence = "conditional"
			}
		}
		state.addReference(f, ref)
		return true
	})
	if state.stopped {
		f.Status = "partial"
		f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "index_limit", "Source indexing stopped at the shared resource limit.", "warning"))
	}
}
