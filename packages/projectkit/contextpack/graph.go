package contextpack

import (
	"context"
	"sort"

	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
)

func attachGraph(ctx context.Context, docs []*document, index *semantic.Index, report *Pack) error {
	byPath := map[string]*document{}
	for _, doc := range docs {
		byPath[doc.entry.Path] = doc
	}
	for i := range index.Files {
		file := &index.Files[i]
		doc := byPath[file.Path]
		if doc == nil {
			continue
		}
		doc.meta = file
		if file.Status != "indexed" || len(file.BuildConditions) > 0 {
			report.Partial = true
			report.Boundaries = append(report.Boundaries, Boundary{Path: file.Path, Kind: "partial_index"})
		}
		for _, imp := range file.Imports {
			if len(imp.Targets) == 0 || imp.Confidence == "ambiguous" {
				report.Partial = true
				kind := "unresolved_import"
				if imp.Confidence == "ambiguous" {
					kind = "ambiguous_import"
				}
				report.Boundaries = append(report.Boundaries, Boundary{Path: file.Path, Kind: kind, Detail: imp.Path})
			}
		}
		unresolved := 0
		for _, ref := range file.References {
			if len(ref.SymbolIDs) != 1 {
				unresolved++
			}
		}
		if unresolved > 0 {
			report.Partial = true
			report.Boundaries = append(report.Boundaries, Boundary{Path: file.Path, Kind: "unresolved_references"})
		}
	}
	if !index.Complete {
		report.Partial = true
	}
	// Two hops, at most 64 participating files and 512 inspected adjacency
	// entries per hop. Initial seed/lexical ranking is independent of path order.
	sortDocuments(docs)
	frontier := []string{}
	visited := map[string]bool{}
	seedCount := 0
	for _, doc := range docs {
		if len(doc.reasons) > 0 {
			seedCount++
		}
		if len(doc.reasons) > 0 && len(frontier) < 16 {
			frontier = append(frontier, doc.entry.Path)
			visited[doc.entry.Path] = true
		}
	}
	if seedCount > 16 {
		report.Partial = true
		report.Boundaries = append(report.Boundaries, Boundary{Kind: "graph_seed_limit"})
	}
	graphFilesLimited := false
	adj := map[string][]semantic.Edge{}
	for _, edge := range index.Edges {
		adj[edge.From] = append(adj[edge.From], edge)
		adj[edge.To] = append(adj[edge.To], edge)
	}
	for p := range adj {
		sort.Slice(adj[p], func(i, j int) bool {
			a, b := adj[p][i], adj[p][j]
			if a.From != b.From {
				return a.From < b.From
			}
			if a.To != b.To {
				return a.To < b.To
			}
			return a.Kind < b.Kind
		})
	}
	for hop := 0; hop < 2 && len(frontier) > 0; hop++ {
		next := []string{}
		inspected := 0
		for _, from := range frontier {
			if err := ctx.Err(); err != nil {
				return err
			}
			for _, edge := range adj[from] {
				inspected++
				if inspected > 512 {
					report.Partial = true
					report.Boundaries = append(report.Boundaries, Boundary{Kind: "graph_expansion_limit"})
					break
				}
				to, kind := edge.To, "dependency"
				if from == edge.To {
					to, kind = edge.From, "referrer"
				}
				doc := byPath[to]
				if doc == nil {
					continue
				}
				if !visited[to] && len(visited) >= 64 {
					report.Partial = true
					if !graphFilesLimited {
						report.Boundaries = append(report.Boundaries, Boundary{Kind: "graph_file_limit"})
						graphFilesLimited = true
					}
					continue
				}
				reason := Reason{Kind: kind, Via: from, Confidence: edge.Confidence}
				duplicate := false
				for _, old := range doc.reasons {
					if old == reason {
						duplicate = true
						break
					}
				}
				if !duplicate && len(doc.reasons) < 6 {
					doc.reasons = append(doc.reasons, reason)
				}
				if visited[to] {
					continue
				}
				visited[to] = true
				next = append(next, to)
			}
			if inspected > 512 {
				break
			}
		}
		sort.Strings(next)
		frontier = next
	}
	return ctx.Err()
}
