//go:build tools

// Command scanlint audits GORM struct scans for missing column tags.
//
// Run from the apps/server module root:
//
//	CGO_ENABLED=1 go run -tags tools ./tools/scanlint
//
// The server uses gorm.Config{NamingStrategy: schema.NamingStrategy{NoLowerCase:
// true}}. Under that strategy GORM does not snake_case field names, so a struct
// scanned via Take/First/Find/Scan/ScanRows/Pluck/Last MUST carry an explicit
// `gorm:"column:..."` tag on every mapped field. A missing tag silently scans
// the zero value (observed with the agent_channel_bindings roster scan).
//
// The check resolves actual receiver types, so positional .Scan(&a,&b) calls on
// *sql.Row/.Rows are ignored; only *gorm.DB receivers are audited. Generated
// models (internal/platform/db/models) carry explicit tags and pass.
//
// Exit code is nonzero when violations are found, so it can act as a CI gate.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/types"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/tools/go/packages"
)

// scanMethodNames are the *gorm.DB finishing methods that scan into a struct.
var scanMethodNames = map[string]bool{
	"Take": true, "First": true, "Last": true,
	"Find": true, "Scan": true, "ScanRows": true, "Pluck": true,
}

func main() {
	root := flag.String("root", ".", "module root to audit")
	tests := flag.Bool("tests", true, "also audit _test.go files")
	flag.Parse()

	cfg := &packages.Config{
		Mode:  packages.NeedName | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo,
		Dir:   *root,
		Tests: *tests,
	}
	pkgs, err := packages.Load(cfg, "./internal/...", "./cmd/...", "./integration/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "load packages:", err)
		os.Exit(2)
	}
	rootAbs, err := filepath.Abs(*root)
	if err != nil {
		rootAbs = *root
	}

	var violations []string
	debug := os.Getenv("SCANLINT_DEBUG") != ""
	// Discover the gorm.DB named type across every loaded package first:
	// packages like internal/runtime only reference *gorm.DB through fields,
	// so the bare named type may not appear in their own type info.
	var gormDB *types.Named
	for _, pkg := range pkgs {
		for _, objMap := range []map[*ast.Ident]types.Object{pkg.TypesInfo.Defs, pkg.TypesInfo.Uses} {
			for _, obj := range objMap {
				if obj == nil {
					continue
				}
				if tn, ok := obj.(*types.TypeName); ok && tn.Pkg() != nil && tn.Pkg().Path() == "gorm.io/gorm" && tn.Name() == "DB" {
					if named, ok := tn.Type().(*types.Named); ok {
						gormDB = named
					}
				}
			}
			if gormDB != nil {
				break
			}
		}
		if gormDB != nil {
			break
		}
	}
	if gormDB == nil {
		fmt.Fprintln(os.Stderr, "scanlint: gorm.DB type not found (is gorm.io/gorm imported anywhere?)")
		os.Exit(2)
	}
	for _, pkg := range pkgs {
		if len(pkg.Errors) > 0 {
			if debug {
				for _, e := range pkg.Errors {
					fmt.Fprintf(os.Stderr, "pkg %s error: %v\n", pkg.PkgPath, e)
				}
			}
			continue
		}
		if debug {
			fmt.Fprintf(os.Stderr, "pkg %s: auditing\n", pkg.PkgPath)
		}
		for _, file := range pkg.Syntax {
			for _, decl := range file.Decls {
				ast.Inspect(decl, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok || len(call.Args) == 0 {
						return true
					}
					sel, ok := call.Fun.(*ast.SelectorExpr)
					if !ok || !scanMethodNames[sel.Sel.Name] {
						return true
					}
					recv := pkg.TypesInfo.TypeOf(sel.X)
					if debug && sel.Sel.Name == "Take" {
						fmt.Fprintf(os.Stderr, "  recv %T %v isDB=%v\n", recv, recv, recv != nil && isGormDB(recv, gormDB))
					}
					if recv == nil || !isGormDB(recv, gormDB) {
						return true
					}
					pos := pkg.Fset.Position(call.Pos())
					rel, _ := filepath.Rel(rootAbs, pos.Filename)
					for _, arg := range call.Args {
						if missing := missingColumns(pkg.TypesInfo.TypeOf(arg)); len(missing) > 0 {
							violations = append(violations, fmt.Sprintf("%s:%d: %s.%s scans into struct missing gorm column tags: %s",
								rel, pos.Line, pkg.PkgPath, sel.Sel.Name, strings.Join(missing, ", ")))
						}
					}
					return true
				})
			}
		}
	}
	if len(violations) > 0 {
		seen := map[string]bool{}
		for _, v := range violations {
			if seen[v] {
				continue
			}
			seen[v] = true
			fmt.Println(v)
		}
		fmt.Fprintf(os.Stderr, "scanlint: %d violation(s)\n", len(seen))
		os.Exit(1)
	}
	fmt.Println("scanlint: ok")
}

// findGormDBType removed: gorm.DB is discovered globally in main.

func isGormDB(t types.Type, gormDB *types.Named) bool {
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	named, ok := t.(*types.Named)
	return ok && gormDB != nil && named.Obj() == gormDB.Obj()
}

// missingColumns unwraps the scan-target expression type down to its struct
// element and lists fields without an explicit gorm column tag.
func missingColumns(argType types.Type) []string {
	if argType == nil {
		return nil
	}
	if ptr, ok := argType.(*types.Pointer); ok {
		argType = ptr.Elem()
	}
	if slice, ok := argType.(*types.Slice); ok {
		argType = slice.Elem()
		if ptr, ok := argType.(*types.Pointer); ok {
			argType = ptr.Elem()
		}
	}
	strct, ok := argType.Underlying().(*types.Struct)
	if !ok {
		return nil
	}
	var missing []string
	for i := 0; i < strct.NumFields(); i++ {
		field := strct.Field(i)
		// Embedded structs are parsed with their own fields; unexported
		// fields are never scanned by GORM.
		if field.Anonymous() || !field.Exported() {
			continue
		}
		if hasColumnTag(strct.Tag(i)) {
			continue
		}
		missing = append(missing, field.Name())
	}
	return missing
}

// hasColumnTag reports whether the struct tag excludes the field from GORM
// mapping (gorm:"-") or pins a column name. A bare gorm tag without column is
// still a violation under NoLowerCase (the column would be the field name).
func hasColumnTag(tag string) bool {
	for _, part := range strings.Split(tag, ";") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, `gorm:"`) {
			continue
		}
		for _, directive := range strings.Split(strings.TrimSuffix(strings.TrimPrefix(part, `gorm:"`), `"`), ";") {
			directive = strings.TrimSpace(directive)
			switch directive {
			case "-", "-:all", "->-":
				return true
			}
			if directive == "column" || strings.HasPrefix(directive, "column:") || strings.HasPrefix(directive, "column=") {
				return true
			}
		}
	}
	return false
}
