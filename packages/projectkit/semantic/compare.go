package semantic

import (
	"path"
	"sort"
	"strings"
)

func Compare(before, after *Index) (Comparison, error) {
	if before == nil || after == nil || before.Version != after.Version {
		return Comparison{}, ErrInvalid
	}
	result := Comparison{BeforeSnapshot: before.SnapshotID, AfterSnapshot: after.SnapshotID, Version: after.Version, Complete: before.Complete && after.Complete, Changes: []FileChange{}, APIChanges: []APIChange{}, Impacted: []Impact{}, RelatedTests: []RelatedTest{}, Diagnostics: []Diagnostic{}, Limitations: append([]string{}, limitations...)}
	left, right := map[string]File{}, map[string]File{}
	for _, f := range before.Files {
		left[f.Path] = f
	}
	for _, f := range after.Files {
		right[f.Path] = f
	}
	paths := map[string]bool{}
	for p := range left {
		paths[p] = true
	}
	for p := range right {
		paths[p] = true
	}
	ordered := []string{}
	for p := range paths {
		ordered = append(ordered, p)
	}
	sort.Strings(ordered)
	added, removed := map[string][]string{}, map[string][]string{}
	for _, p := range ordered {
		a, aok := left[p]
		b, bok := right[p]
		kind := ""
		confidence := "content_hash"
		switch {
		case !aok && bok:
			kind = "added"
			added[b.Hash] = append(added[b.Hash], p)
		case aok && !bok:
			kind = "removed"
			removed[a.Hash] = append(removed[a.Hash], p)
		case a.Hash != b.Hash:
			kind = "modified"
		}
		if kind == "" {
			continue
		}
		if !aok && before.hasEntry(p) || !bok && after.hasEntry(p) {
			kind = "index_unavailable"
			confidence = "unknown"
		}
		result.Changes = append(result.Changes, FileChange{Path: p, Kind: kind, Confidence: confidence})
	}
	// Identical content is a rename candidate only for a one-to-one match. It is
	// not a proof of API compatibility: moving a Go file can change its package.
	renamed := map[string]string{}
	for hash, oldPaths := range removed {
		newPaths := added[hash]
		if hash != "" && len(oldPaths) == 1 && len(newPaths) == 1 {
			renamed[newPaths[0]] = oldPaths[0]
		} else if hash != "" && len(oldPaths) > 0 && len(newPaths) > 0 {
			result.Diagnostics = append(result.Diagnostics, diagnostic("", "ambiguous_rename", "Identical contents match multiple added/removed paths; no rename was inferred.", "info"))
		}
	}
	rewritten := []FileChange{}
	oldRenames := map[string]bool{}
	for _, old := range renamed {
		oldRenames[old] = true
	}
	for _, c := range result.Changes {
		if c.Kind == "removed" && oldRenames[c.Path] {
			continue
		}
		if old, ok := renamed[c.Path]; ok && c.Kind == "added" {
			c.Kind = "rename_candidate"
			c.OldPath = old
		}
		rewritten = append(rewritten, c)
	}
	result.Changes = rewritten
	beforeAPI, afterAPI := apiSymbols(before), apiSymbols(after)
	keys := map[string]bool{}
	for key := range beforeAPI {
		keys[key] = true
	}
	for key := range afterAPI {
		keys[key] = true
	}
	orderedKeys := []string{}
	for key := range keys {
		orderedKeys = append(orderedKeys, key)
	}
	sort.Strings(orderedKeys)
	for _, key := range orderedKeys {
		a, b := beforeAPI[key], afterAPI[key]
		if sameAPI(a, b) || truncatedSameFiles(a, b, left, right) {
			continue
		}
		change := APIChange{Key: key, Before: append([]Symbol{}, a...), After: append([]Symbol{}, b...), Confidence: "syntax", Classification: "review"}
		if len(a) > 1 || len(b) > 1 {
			change.Kind = "ambiguous"
			change.Classification = "unknown"
			change.Confidence = "ambiguous"
			change.Reason = "Multiple declarations share this API key, including conditional build variants; compatibility cannot be decided without a build target."
			result.APIChanges = append(result.APIChanges, change)
			continue
		}
		switch {
		case len(a) == 0:
			change.Kind = "added"
			change.Classification = "additive"
			change.Reason = "A new exported declaration is present."
		case len(b) == 0:
			change.Kind = "removed"
			change.Classification = "breaking"
			change.Reason = "An exported declaration was removed from this package/module namespace."
		default:
			change.Kind = "signature_changed"
			change.Classification = "breaking"
			change.Reason = "An exported Go function, method, field or constant declaration changed."
			if a[0].Kind == "type" || a[0].Kind == "variable" || a[0].Kind == "constant" {
				change.Classification = "review"
				change.Reason = "An exported type or value declaration changed; source syntax alone cannot establish assignment or behavioral compatibility."
			}
		}
		sample := a
		if len(sample) == 0 {
			sample = b
		}
		if len(sample) > 0 {
			if sample[0].Confidence == "conditional" {
				change.Confidence = "conditional"
				change.Reason += " Build constraints were not evaluated; this declaration is conditional."
			}
			if sample[0].Confidence == "lexical" {
				change.Confidence = "lexical"
				change.Classification = "unknown"
				change.Reason = "The lexical export surface changed; type checking and complete JavaScript export evaluation are unavailable."
			}
			if change.Kind == "added" && sample[0].Kind == "interface_method" {
				change.Classification = "breaking"
				change.Reason = "Adding a method to an exported Go interface adds a requirement for existing implementers."
			}
			if len(a) > 0 && before.fileUncertain(a[0].Path) || len(b) > 0 && after.fileUncertain(b[0].Path) || len(a) == 0 && before.namespaceUncertain(sample[0]) || len(b) == 0 && after.namespaceUncertain(sample[0]) {
				change.Classification = "unknown"
				change.Confidence = "incomplete"
				change.Reason = "An involved file or namespace was not completely indexed; this change requires inspection."
			}
		}
		result.APIChanges = append(result.APIChanges, change)
	}
	seeds := []string{}
	for _, c := range result.Changes {
		seeds = append(seeds, c.Path)
		if c.OldPath != "" {
			seeds = append(seeds, c.OldPath)
		}
	}
	result.Impacted = impactPaths(before, after, seeds)
	result.RelatedTests = relatedTests(before, after, result.Impacted)
	result.Limitations = append(result.Limitations, "This semantic comparison describes supported code files. Use the artifact content diff for other file formats and byte-level changes.")
	if !result.Complete {
		result.Diagnostics = append(result.Diagnostics, diagnostic("", "incomplete_comparison", "At least one index is partial; omitted paths and APIs are not proof of absence.", "warning"))
	}
	return result, nil
}
func (i *Index) hasEntry(p string) bool {
	for _, e := range i.Entries {
		if e.Path == p {
			return true
		}
	}
	return false
}
func (i *Index) fileUncertain(p string) bool {
	for _, f := range i.Files {
		if f.Path == p {
			return f.Status != "indexed"
		}
	}
	return i.hasEntry(p)
}
func (i *Index) namespaceUncertain(s Symbol) bool {
	for _, f := range i.Files {
		if path.Dir(f.Path) == path.Dir(s.Path) && f.Package == s.Package && f.Status != "indexed" {
			return true
		}
	}
	for _, e := range i.Entries {
		if language(e.Path) == "go" && path.Dir(e.Path) == path.Dir(s.Path) && i.fileUncertain(e.Path) {
			return true
		}
	}
	return false
}
func apiSymbols(index *Index) map[string][]Symbol {
	result := map[string][]Symbol{}
	for _, f := range index.Files {
		if f.Test {
			continue
		}
		for _, s := range f.Symbols {
			if s.Exported {
				result[s.Key] = append(result[s.Key], s)
			}
		}
	}
	for k := range result {
		sort.Slice(result[k], func(a, b int) bool {
			if result[k][a].Path != result[k][b].Path {
				return result[k][a].Path < result[k][b].Path
			}
			return result[k][a].ID < result[k][b].ID
		})
	}
	return result
}
func sameAPI(a, b []Symbol) bool {
	if len(a) != len(b) {
		return false
	}
	left, right := []string{}, []string{}
	for _, s := range a {
		if s.SignatureTruncated {
			return false
		}
		shape := s.Signature
		if s.SignatureHash != "" {
			shape = s.SignatureHash
		}
		left = append(left, s.Kind+"\x00"+shape)
	}
	for _, s := range b {
		if s.SignatureTruncated {
			return false
		}
		shape := s.Signature
		if s.SignatureHash != "" {
			shape = s.SignatureHash
		}
		right = append(right, s.Kind+"\x00"+shape)
	}
	sort.Strings(left)
	sort.Strings(right)
	return strings.Join(left, "\x01") == strings.Join(right, "\x01")
}
func impactPaths(before, after *Index, seeds []string) []Impact {
	reverse := map[string][]Edge{}
	dedup := map[string]bool{}
	for _, index := range []*Index{before, after} {
		for _, e := range index.Edges {
			key := e.From + "\x00" + e.To + "\x00" + e.Kind
			if !dedup[key] {
				reverse[e.To] = append(reverse[e.To], e)
				dedup[key] = true
			}
		}
	}
	for key := range reverse {
		sort.Slice(reverse[key], func(a, b int) bool {
			if reverse[key][a].From != reverse[key][b].From {
				return reverse[key][a].From < reverse[key][b].From
			}
			return reverse[key][a].Kind < reverse[key][b].Kind
		})
	}
	sort.Strings(seeds)
	seen := map[string]Impact{}
	queue := []string{}
	for _, p := range seeds {
		if _, ok := seen[p]; !ok {
			seen[p] = Impact{Path: p, Reason: "changed_source", Via: []string{p}, Confidence: "content_hash"}
			queue = append(queue, p)
		}
	}
	for cursor := 0; cursor < len(queue); cursor++ {
		p := queue[cursor]
		current := seen[p]
		for _, e := range reverse[p] {
			if _, ok := seen[e.From]; ok {
				continue
			}
			via := append(append([]string{}, current.Via...), e.From)
			confidence := e.Confidence
			if current.Confidence == "ambiguous" || current.Confidence == "conditional" {
				confidence = current.Confidence
			}
			seen[e.From] = Impact{Path: e.From, Reason: e.Kind, Via: via, Confidence: confidence}
			queue = append(queue, e.From)
		}
	}
	result := []Impact{}
	for _, v := range seen {
		result = append(result, v)
	}
	sort.Slice(result, func(a, b int) bool {
		if len(result[a].Via) != len(result[b].Via) {
			return len(result[a].Via) < len(result[b].Via)
		}
		return result[a].Path < result[b].Path
	})
	return result
}
func relatedTests(before, after *Index, impacts []Impact) []RelatedTest {
	result := []RelatedTest{}
	unique := map[string]bool{}
	files := map[string]File{}
	for _, f := range before.Files {
		files[f.Path] = f
	}
	for _, f := range after.Files {
		files[f.Path] = f
	}
	add := func(test, source, reason, confidence string) {
		key := test + "\x00" + source
		if !unique[key] {
			unique[key] = true
			result = append(result, RelatedTest{Path: test, SourcePath: source, Reason: reason, Confidence: confidence})
		}
	}
	for _, impact := range impacts {
		f, ok := files[impact.Path]
		if !ok {
			continue
		}
		if f.Test {
			source := impact.Via[0]
			add(f.Path, source, "dependency_path", impact.Confidence)
			continue
		}
		for _, candidate := range after.Files {
			if !candidate.Test || candidate.Status == "skipped" {
				continue
			}
			if f.Language == "go" && candidate.Language == "go" && path.Dir(f.Path) == path.Dir(candidate.Path) && (candidate.Package == f.Package || candidate.Package == f.Package+"_test") {
				add(candidate.Path, f.Path, "same_go_package", "candidate")
				continue
			}
			sourceStem := strings.TrimSuffix(path.Base(f.Path), path.Ext(f.Path))
			testBase := path.Base(candidate.Path)
			if path.Dir(candidate.Path) == path.Dir(f.Path) && (strings.HasPrefix(testBase, sourceStem+".test.") || strings.HasPrefix(testBase, sourceStem+".spec.")) {
				add(candidate.Path, f.Path, "matching_test_filename", "candidate")
			}
		}
	}
	sort.Slice(result, func(a, b int) bool {
		if result[a].Path != result[b].Path {
			return result[a].Path < result[b].Path
		}
		return result[a].SourcePath < result[b].SourcePath
	})
	return result
}

func truncatedSameFiles(a, b []Symbol, left, right map[string]File) bool {
	if len(a) != len(b) || len(a) == 0 {
		return false
	}
	found := false
	for n, s := range a {
		if s.SignatureTruncated || b[n].SignatureTruncated {
			found = true
		}
		if s.Key != b[n].Key || s.Path != b[n].Path || left[s.Path].Hash != right[s.Path].Hash {
			return false
		}
	}
	return found
}
