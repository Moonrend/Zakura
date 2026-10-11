package refactor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path"
	"sort"
	"strings"
	"unicode/utf8"
)

func hash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func safePath(p string) bool {
	return p != "" && p != "." && len(p) <= 4096 && utf8.ValidString(p) && path.Clean(p) == p && !strings.HasPrefix(p, "/") && !strings.ContainsAny(p, "\\\x00") && p != ".." && !strings.HasPrefix(p, "../")
}

var platforms = map[string]bool{"aix": true, "android": true, "darwin": true, "dragonfly": true, "freebsd": true, "hurd": true, "illumos": true, "ios": true, "js": true, "linux": true, "nacl": true, "netbsd": true, "openbsd": true, "plan9": true, "solaris": true, "wasip1": true, "windows": true, "386": true, "amd64": true, "amd64p32": true, "arm": true, "arm64": true, "loong64": true, "mips": true, "mips64": true, "mips64le": true, "mipsle": true, "ppc64": true, "ppc64le": true, "riscv64": true, "s390x": true, "sparc64": true, "wasm": true}

func conditionalFile(p string, data []byte) bool {
	name := strings.TrimSuffix(path.Base(p), ".go")
	name = strings.TrimSuffix(name, "_test")
	parts := strings.Split(name, "_")
	if len(parts) > 1 && platforms[parts[len(parts)-1]] {
		return true
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "//go:build ") || strings.HasPrefix(line, "// +build ") {
			return true
		}
		if strings.HasPrefix(line, "package ") {
			break
		}
	}
	return false
}
func Load(ctx context.Context, source Source, snapshot string) (MemorySource, error) {
	if source == nil || snapshot == "" {
		return MemorySource{}, ErrInvalid
	}
	entries, err := source.Files(ctx, snapshot)
	if err != nil {
		return MemorySource{}, err
	}
	sort.Slice(entries, func(a, b int) bool { return entries[a].Path < entries[b].Path })
	m := MemorySource{Snapshot: snapshot, FilesByPath: map[string]string{}}
	total := int64(0)
	count := 0
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return m, err
		}
		if !safePath(entry.Path) || entry.Size < 0 {
			return m, ErrInvalid
		}
		if !strings.HasSuffix(entry.Path, ".go") && path.Base(entry.Path) != "go.mod" {
			continue
		}
		count++
		if count > MaxFiles || entry.Size > MaxFileBytes || entry.Size > MaxTotalBytes-total {
			return m, ErrLimit
		}
		data, err := source.Read(ctx, snapshot, entry.Path)
		if err != nil {
			return m, err
		}
		if int64(len(data)) != entry.Size || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			return m, fmt.Errorf("%w: invalid source bytes in %s", ErrIncomplete, entry.Path)
		}
		if entry.Hash != "" && hash(data) != entry.Hash {
			return m, fmt.Errorf("%w: source digest mismatch", ErrInvalid)
		}
		m.FilesByPath[entry.Path] = string(data)
		total += int64(len(data))
	}
	return m, nil
}

type unit struct {
	path        string
	data        []byte
	tree        *ast.File
	packagePath string
	test        bool
}
type parsed struct {
	fset     *token.FileSet
	units    map[string]*unit
	packages map[string][]*unit
	files    MemorySource
}

func parse(ctx context.Context, source MemorySource) (*parsed, error) {
	modules := map[string]string{}
	paths := []string{}
	for p, data := range source.FilesByPath {
		if !safePath(p) {
			return nil, ErrInvalid
		}
		paths = append(paths, p)
		if path.Base(p) == "go.mod" {
			for _, line := range strings.Split(data, "\n") {
				words := strings.Fields(line)
				if len(words) >= 2 && words[0] == "module" {
					module := strings.Trim(words[1], "\"")
					if module == "" || strings.ContainsAny(module, "\\\x00") {
						return nil, ErrInvalid
					}
					modules[path.Dir(p)] = module
					break
				}
			}
		}
	}
	sort.Strings(paths)
	if len(paths) > MaxFiles {
		return nil, ErrLimit
	}
	dirs := []string{}
	for dir := range modules {
		dirs = append(dirs, dir)
	}
	sort.Slice(dirs, func(a, b int) bool { return len(dirs[a]) > len(dirs[b]) })
	result := &parsed{fset: token.NewFileSet(), units: map[string]*unit{}, packages: map[string][]*unit{}, files: source}
	nodes := 0
	total := 0
	for _, p := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		data := []byte(source.FilesByPath[p])
		total += len(data)
		if len(data) > MaxFileBytes || total > MaxTotalBytes {
			return nil, ErrLimit
		}
		if !strings.HasSuffix(p, ".go") {
			continue
		}
		if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			return nil, ErrIncomplete
		}
		if conditionalFile(p, data) {
			return nil, fmt.Errorf("%w: build/platform conditions in %s require an explicit build target", ErrIncomplete, p)
		}
		tree, err := parser.ParseFile(result.fset, p, data, parser.ParseComments|parser.AllErrors)
		if err != nil {
			return nil, fmt.Errorf("%w: %s cannot be parsed", ErrIncomplete, p)
		}
		ast.Inspect(tree, func(n ast.Node) bool {
			if n == nil {
				return true
			}
			nodes++
			return nodes <= MaxNodes && ctx.Err() == nil
		})
		if nodes > MaxNodes {
			return nil, ErrLimit
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		directory := path.Dir(p)
		packagePath := "artifact.local/root"
		if directory != "." {
			packagePath += "/" + directory
		}
		for _, dir := range dirs {
			if directory == dir || dir == "." || strings.HasPrefix(directory, dir+"/") {
				relative := strings.TrimPrefix(directory, dir)
				if dir == "." {
					relative = directory
				}
				packagePath = modules[dir]
				if relative != "" && relative != "." {
					packagePath += "/" + strings.TrimPrefix(relative, "/")
				}
				break
			}
		}
		isExternalTest := strings.HasSuffix(p, "_test.go") && strings.HasSuffix(tree.Name.Name, "_test")
		if isExternalTest {
			packagePath += "_test"
		}
		u := &unit{path: p, data: data, tree: tree, packagePath: packagePath, test: strings.HasSuffix(p, "_test.go")}
		result.units[p] = u
		result.packages[packagePath] = append(result.packages[packagePath], u)
	}
	if len(result.units) == 0 {
		return nil, ErrIncomplete
	}
	return result, nil
}
