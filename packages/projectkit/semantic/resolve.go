package semantic

import (
	"path"
	"sort"
	"strings"
)

func packageKey(f File) string { return path.Dir(f.Path) + "::" + f.Package }
func resolve(index *Index, modules map[string]string) {
	files := map[string]*File{}
	packages := map[string][]*File{}
	names := map[string][]Symbol{}
	for n := range index.Files {
		f := &index.Files[n]
		files[f.Path] = f
		if f.Language == "go" {
			packages[packageKey(*f)] = append(packages[packageKey(*f)], f)
		}
		for _, s := range f.Symbols {
			if s.Kind == "local" || s.Kind == "local_type" || s.Kind == "import" {
				continue
			}
			key := f.Path + "::" + s.Name
			if f.Language == "go" {
				key = packageKey(*f) + "::" + s.Name
			}
			names[key] = append(names[key], s)
		}
	}
	edges := map[string]Edge{}
	addEdge := func(from, to, kind, confidence string) {
		if from == to {
			return
		}
		key := from + "\x00" + to + "\x00" + kind
		if len(edges) >= index.Limits.MaxEdges {
			index.Complete = false
			return
		}
		edges[key] = Edge{From: from, To: to, Kind: kind, Confidence: confidence}
	}
	moduleDirs := []string{}
	for d := range modules {
		moduleDirs = append(moduleDirs, d)
	}
	sort.Slice(moduleDirs, func(a, b int) bool {
		x, y := modules[moduleDirs[a]], modules[moduleDirs[b]]
		if len(x) != len(y) {
			return len(x) > len(y)
		}
		if x != y {
			return x < y
		}
		return moduleDirs[a] < moduleDirs[b]
	})
	for n := range index.Files {
		f := &index.Files[n]
		for k := range f.Imports {
			imp := &f.Imports[k]
			targets := []string{}
			if f.Language == "go" {
				matchedModule := ""
				for _, dir := range moduleDirs {
					module := modules[dir]
					if matchedModule != "" && module != matchedModule {
						continue
					}
					if imp.Path != module && !strings.HasPrefix(imp.Path, module+"/") {
						continue
					}
					relative := strings.TrimPrefix(imp.Path, module)
					targetDir := path.Clean(path.Join(dir, relative))
					for _, candidate := range index.Files {
						if candidate.Language == "go" && !candidate.Test && candidate.Status != "skipped" && path.Dir(candidate.Path) == targetDir {
							targets = append(targets, candidate.Path)
						}
					}
					if len(targets) > 0 {
						matchedModule = module
					}
				}
			} else if strings.HasPrefix(imp.Path, "./") || strings.HasPrefix(imp.Path, "../") {
				target := path.Clean(path.Join(path.Dir(f.Path), imp.Path))
				if validPath(target) {
					candidates := []string{target}
					ext := path.Ext(target)
					if ext == ".js" || ext == ".mjs" || ext == ".cjs" {
						stem := strings.TrimSuffix(target, ext)
						candidates = append(candidates, stem+".ts", stem+".tsx")
					}
					if ext == "" {
						for _, suffix := range []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"} {
							candidates = append(candidates, target+suffix)
						}
					}
					for _, candidate := range candidates {
						if targetFile := files[candidate]; targetFile != nil && targetFile.Status != "skipped" {
							targets = append(targets, candidate)
						}
					}
				}
			}
			sort.Strings(targets)
			imp.Targets = targets
			if f.Language == "go" && !imp.ExplicitAlias && len(targets) > 0 {
				name := ""
				consistent := true
				for _, target := range targets {
					candidate := files[target]
					if candidate == nil {
						continue
					}
					if name == "" {
						name = candidate.Package
					} else if name != candidate.Package {
						consistent = false
					}
				}
				if consistent && name != "" {
					imp.Name = name
				}
			}
			if len(targets) > 0 {
				if f.Language == "go" {
					imp.Confidence = "syntax"
					packages := map[string]bool{}
					for _, target := range targets {
						if file := files[target]; file != nil {
							packages[packageKey(*file)] = true
						}
					}
					if len(packages) > 1 {
						imp.Confidence = "ambiguous"
						f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "ambiguous_module", "Several local packages match module path "+imp.Path, "info"))
					}
				} else if len(targets) == 1 {
					imp.Confidence = "lexical"
				} else {
					imp.Confidence = "ambiguous"
					f.Diagnostics = append(f.Diagnostics, diagnostic(f.Path, "ambiguous_module", "Several snapshot files match module path "+imp.Path+"; resolver configuration was not executed.", "info"))
				}
				for _, target := range targets {
					addEdge(f.Path, target, "import", imp.Confidence)
				}
			} else {
				imp.Confidence = "external_or_unresolved"
			}
		}
		// All files of a Go package are compiled together. These edges intentionally
		// remain conservative and separate from import-cycle diagnostics.
		if f.Language == "go" {
			for _, candidate := range packages[packageKey(*f)] {
				if !candidate.Test || f.Test {
					confidence := "syntax"
					if len(f.BuildConditions) > 0 || len(candidate.BuildConditions) > 0 {
						confidence = "conditional"
					}
					addEdge(f.Path, candidate.Path, "same_package", confidence)
				}
			}
		}
		for k := range f.References {
			ref := &f.References[k]
			if len(ref.SymbolIDs) > 0 {
				continue
			}
			candidates := []Symbol{}
			if f.Language == "go" {
				if ref.Qualifier != "" {
					for _, imp := range f.Imports {
						if imp.Name != ref.Qualifier {
							continue
						}
						for _, target := range imp.Targets {
							targetFile := files[target]
							if targetFile == nil {
								continue
							}
							for _, s := range names[packageKey(*targetFile)+"::"+ref.Name] {
								if s.Exported && (s.Kind == "function" || s.Kind == "type" || s.Kind == "constant" || s.Kind == "variable") {
									candidates = append(candidates, s)
								}
							}
						}
					}
				} else {
					for _, s := range names[packageKey(*f)+"::"+ref.Name] {
						if s.Receiver == "" {
							candidates = append(candidates, s)
						}
					}
				}
			} else if ref.Qualifier == "" {
				candidates = append(candidates, names[f.Path+"::"+ref.Name]...)
			}
			unique := map[string]Symbol{}
			for _, s := range candidates {
				unique[s.ID] = s
			}
			ids := []string{}
			for id := range unique {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			ref.SymbolIDs = ids
			if len(ids) == 1 {
				if f.Language == "go" {
					ref.Confidence = "syntax"
					if unique[ids[0]].Confidence == "conditional" || len(f.BuildConditions) > 0 {
						ref.Confidence = "conditional"
					}
				} else {
					ref.Confidence = "lexical"
				}
			} else if len(ids) > 1 {
				ref.Confidence = "ambiguous"
			}
			for _, id := range ids {
				s := unique[id]
				addEdge(f.Path, s.Path, "reference", ref.Confidence)
			}
		}
	}
	for _, e := range edges {
		index.Edges = append(index.Edges, e)
	}
	sort.Slice(index.Edges, func(a, b int) bool {
		x, y := index.Edges[a], index.Edges[b]
		if x.From != y.From {
			return x.From < y.From
		}
		if x.To != y.To {
			return x.To < y.To
		}
		return x.Kind < y.Kind
	})
	if len(edges) >= index.Limits.MaxEdges {
		index.addDiagnostic(diagnostic("", "dependency_limit", "Dependency graph reached its edge budget; impacts can be incomplete.", "warning"))
	}
}

// Tarjan's algorithm runs only on actual local import edges. Package-membership
// edges model joint compilation and must not be presented as import cycles.
func dependencyCycles(files []File, edges []Edge) []Cycle {
	adjacency := map[string][]string{}
	for _, e := range edges {
		if e.Kind == "import" {
			adjacency[e.From] = append(adjacency[e.From], e.To)
		}
	}
	order := 0
	number := map[string]int{}
	low := map[string]int{}
	stack := []string{}
	active := map[string]bool{}
	result := []Cycle{}
	var visit func(string)
	visit = func(v string) {
		order++
		number[v] = order
		low[v] = order
		stack = append(stack, v)
		active[v] = true
		for _, w := range adjacency[v] {
			if number[w] == 0 {
				visit(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if active[w] && number[w] < low[v] {
				low[v] = number[w]
			}
		}
		if low[v] != number[v] {
			return
		}
		component := []string{}
		for len(stack) > 0 {
			w := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			active[w] = false
			component = append(component, w)
			if w == v {
				break
			}
		}
		if len(component) > 1 {
			sort.Strings(component)
			result = append(result, Cycle{Files: component})
		}
	}
	for _, f := range files {
		if number[f.Path] == 0 {
			visit(f.Path)
		}
	}
	sort.Slice(result, func(a, b int) bool {
		return strings.Join(result[a].Files, "\x00") < strings.Join(result[b].Files, "\x00")
	})
	return result
}
