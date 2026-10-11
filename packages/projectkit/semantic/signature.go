package semantic

import (
	"crypto/sha256"
	"encoding/hex"
	"go/ast"
	"strconv"
)

func signatureHash(shape string) string {
	sum := sha256.Sum256([]byte(shape))
	return hex.EncodeToString(sum[:])
}

// normalizeType clones type expressions without altering the AST used for
// definition navigation. Generic parameter names are alpha-renamed so an API
// comparison does not mistake a parameter rename for a call incompatibility.
func normalizeType(expr ast.Expr, names map[string]string) ast.Expr {
	switch e := expr.(type) {
	case *ast.Ident:
		if name, ok := names[e.Name]; ok {
			return &ast.Ident{Name: name}
		}
		return &ast.Ident{Name: e.Name}
	case *ast.SelectorExpr:
		return &ast.SelectorExpr{X: normalizeType(e.X, names), Sel: &ast.Ident{Name: e.Sel.Name}}
	case *ast.StarExpr:
		return &ast.StarExpr{X: normalizeType(e.X, names)}
	case *ast.ArrayType:
		return &ast.ArrayType{Len: normalizeType(e.Len, names), Elt: normalizeType(e.Elt, names)}
	case *ast.MapType:
		return &ast.MapType{Key: normalizeType(e.Key, names), Value: normalizeType(e.Value, names)}
	case *ast.ChanType:
		return &ast.ChanType{Dir: e.Dir, Value: normalizeType(e.Value, names)}
	case *ast.Ellipsis:
		return &ast.Ellipsis{Elt: normalizeType(e.Elt, names)}
	case *ast.ParenExpr:
		return &ast.ParenExpr{X: normalizeType(e.X, names)}
	case *ast.IndexExpr:
		return &ast.IndexExpr{X: normalizeType(e.X, names), Index: normalizeType(e.Index, names)}
	case *ast.IndexListExpr:
		r := &ast.IndexListExpr{X: normalizeType(e.X, names)}
		for _, index := range e.Indices {
			r.Indices = append(r.Indices, normalizeType(index, names))
		}
		return r
	case *ast.UnaryExpr:
		return &ast.UnaryExpr{Op: e.Op, X: normalizeType(e.X, names)}
	case *ast.BinaryExpr:
		return &ast.BinaryExpr{X: normalizeType(e.X, names), Op: e.Op, Y: normalizeType(e.Y, names)}
	case *ast.FuncType:
		return normalizedFunction(e, names)
	case *ast.InterfaceType:
		return &ast.InterfaceType{Methods: shapeFields(e.Methods, names, true)}
	case *ast.StructType:
		return &ast.StructType{Fields: shapeFields(e.Fields, names, true)}
	case *ast.BasicLit:
		return &ast.BasicLit{Kind: e.Kind, Value: e.Value}
	default:
		return expr
	}
}
func shapeFields(list *ast.FieldList, names map[string]string, retainNames bool) *ast.FieldList {
	if list == nil {
		return nil
	}
	r := &ast.FieldList{}
	for _, field := range list.List {
		f := &ast.Field{Type: normalizeType(field.Type, names), Tag: field.Tag}
		if retainNames {
			for _, name := range field.Names {
				value := name.Name
				f.Names = append(f.Names, &ast.Ident{Name: value})
			}
			r.List = append(r.List, f)
		} else {
			count := len(field.Names)
			if count == 0 {
				count = 1
			}
			for n := 0; n < count; n++ {
				r.List = append(r.List, &ast.Field{Type: f.Type})
			}
		}
	}
	return r
}
func normalizedFunction(ft *ast.FuncType, outer map[string]string) *ast.FuncType {
	names := map[string]string{}
	for key, value := range outer {
		names[key] = value
	}
	counter := 0
	if ft.TypeParams != nil {
		for _, field := range ft.TypeParams.List {
			for _, name := range field.Names {
				names[name.Name] = "_P" + strconv.Itoa(counter)
				counter++
			}
		}
	}
	typeParams := shapeFields(ft.TypeParams, names, true)
	if typeParams != nil {
		for _, field := range typeParams.List {
			for _, name := range field.Names {
				if replacement, ok := names[name.Name]; ok {
					name.Name = replacement
				}
			}
		}
	}
	return &ast.FuncType{TypeParams: typeParams, Params: shapeFields(ft.Params, names, false), Results: shapeFields(ft.Results, names, false)}
}
func functionShape(name string, recv ast.Expr, ft *ast.FuncType) string {
	names := map[string]string{}
	var arguments []ast.Expr
	switch receiver := recv.(type) {
	case *ast.StarExpr:
		recvBase := receiver.X
		switch base := recvBase.(type) {
		case *ast.IndexExpr:
			arguments = []ast.Expr{base.Index}
		case *ast.IndexListExpr:
			arguments = base.Indices
		}
	case *ast.IndexExpr:
		arguments = []ast.Expr{receiver.Index}
	case *ast.IndexListExpr:
		arguments = receiver.Indices
	}
	for n, arg := range arguments {
		if id, ok := arg.(*ast.Ident); ok {
			names[id.Name] = "_R" + strconv.Itoa(n)
		}
	}
	prefix := name
	if recv != nil {
		prefix = "(" + astString(normalizeType(recv, names)) + ")." + name
	}
	return prefix + astString(normalizedFunction(ft, names))
}
func typeParameterSignature(list *ast.FieldList) string {
	if list == nil {
		return ""
	}
	ft := &ast.FuncType{TypeParams: list, Params: &ast.FieldList{}}
	text := astString(ft)
	if len(text) >= 6 {
		return text[4 : len(text)-2]
	}
	return ""
}
