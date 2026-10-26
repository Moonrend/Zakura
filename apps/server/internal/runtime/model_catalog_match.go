// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"reflect"
	"regexp"
	"sort"
	"strings"
)

var catalogVersionSeparator = regexp.MustCompile(`([0-9])\.([0-9])`)

func catalogModelKey(id string) string {
	id = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(id)), "models/")
	// Normalize numeric version spelling without removing dates or variants.
	for catalogVersionSeparator.MatchString(id) {
		id = catalogVersionSeparator.ReplaceAllString(id, "${1}-${2}")
	}
	return strings.Join(strings.FieldsFunc(id, func(r rune) bool { return r == '_' || r == ' ' || r == '-' }), "-")
}

type catalogIndex struct {
	byID      map[string][]catalogEntry
	byOrigin  map[string]catalogEntry
	originals map[string]bool
}

func catalogIdentity(entry catalogEntry) string {
	if canonical := gwStr(gwMap(entry.Meta["raw"])["canonical_model_id"]); canonical != "" {
		return catalogModelKey(canonical)
	}
	id := catalogModelKey(entry.ModelID)
	if strings.Contains(id, "/") {
		return id
	}
	return strings.ToLower(entry.ProviderID) + "/" + id
}

func newCatalogIndex(entries []catalogEntry) catalogIndex {
	entries = append([]catalogEntry(nil), entries...)
	// Overlay the curated source only within the same provider and model.
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Source == "models.dev" && entries[j].Source != "models.dev" })
	merged := map[string]catalogEntry{}
	index := catalogIndex{byID: map[string][]catalogEntry{}, byOrigin: map[string]catalogEntry{}, originals: map[string]bool{}}
	for _, entry := range entries {
		key := strings.ToLower(entry.ProviderID) + "\x00" + entry.ModelID
		if previous, exists := merged[key]; exists {
			entry.Meta = mergeCatalogMeta(previous.Meta, previous.Meta, entry.Meta, false)
		}
		merged[key] = entry
		if canonical := gwStr(gwMap(entry.Meta["raw"])["canonical_model_id"]); canonical != "" {
			if provider, _, ok := strings.Cut(catalogModelKey(canonical), "/"); ok {
				index.originals[provider] = true
			}
		}
	}
	for _, entry := range merged {
		index.byOrigin[strings.ToLower(entry.ProviderID)+"\x00"+entry.ModelID] = entry
		id, identity := catalogModelKey(entry.ModelID), catalogIdentity(entry)
		keys := map[string]bool{id: true, identity: true, strings.ToLower(entry.ProviderID) + "/" + id: true}
		if _, bare, ok := strings.Cut(identity, "/"); ok {
			keys[bare] = true
		}
		for key := range keys {
			index.byID[key] = append(index.byID[key], entry)
		}
	}
	return index
}

func (index catalogIndex) match(native, canonical, capability, apiBase string) *catalogEntry {
	entry, _ := index.resolve(native, canonical, capability, apiBase)
	return entry
}

func (index catalogIndex) resolve(native, canonical, capability, apiBase string) (*catalogEntry, string) {
	if capability == "evaluation" {
		return nil, "not_found"
	}
	matchID := func(id string) (*catalogEntry, string) {
		key := catalogModelKey(id)
		var best []catalogEntry
		bestRank := -1
		for _, candidate := range index.byID[key] {
			rank := 0
			identity := catalogIdentity(candidate)
			provider, _, _ := strings.Cut(identity, "/")
			if catalogAPIHostMatches(apiBase, gwStr(candidate.Meta["apiBase"])) {
				rank += 10000
			}
			if strings.EqualFold(candidate.ProviderID, provider) && (index.originals[provider] || candidate.Source == "llm-metadata") {
				rank += 2000
			}
			if strings.EqualFold(strings.TrimPrefix(strings.TrimSpace(id), "models/"), candidate.ModelID) {
				rank += 1000
			}
			if gwStr(gwMap(candidate.Meta["raw"])["canonical_model_id"]) != "" {
				rank += 100
			}
			if candidate.Source == "llm-metadata" {
				rank += 10
			}
			// Discovery defaults all /v1/models entries to chat. Capability is a
			// tie breaker, not a reason to discard an exact model's metadata.
			if containsCatalogString(candidate.Meta["capabilities"], capability) {
				rank++
			}
			if rank > bestRank {
				best, bestRank = []catalogEntry{candidate}, rank
			} else if rank == bestRank {
				best = append(best, candidate)
			}
		}
		if len(best) == 0 {
			return nil, "not_found"
		}
		if len(best) == 1 {
			return &best[0], ""
		}
		identity := catalogIdentity(best[0])
		sameIdentity, sameModel := true, true
		for _, entry := range best {
			if catalogIdentity(entry) != identity || gwStr(gwMap(entry.Meta["raw"])["canonical_model_id"]) == "" {
				sameIdentity = false
			}
			if entry.ModelID != best[0].ModelID {
				sameModel = false
			}
		}
		if !sameIdentity {
			sort.Slice(best, func(i, j int) bool {
				return best[i].ProviderID+"/"+best[i].ModelID < best[j].ProviderID+"/"+best[j].ModelID
			})
			identity = catalogIdentity(best[0])
		}
		entry := catalogConsensus(best, identity)
		// Some catalogs omit canonical IDs for regional copies or shared
		// router aliases. Accept only identical IDs with agreeing core data.
		if !sameIdentity && !(sameModel && gwInt(entry.Meta["contextLimit"]) > 0 && entry.Meta["modalities"] != nil && entry.Meta["reasoning"] != nil) {
			return nil, "ambiguous"
		}
		return &entry, ""
	}
	best, reason := matchID(native)
	if reason == "ambiguous" {
		return nil, reason
	}
	if canonical != "" && catalogModelKey(canonical) != catalogModelKey(native) {
		other, otherReason := matchID(canonical)
		if otherReason == "ambiguous" {
			return nil, otherReason
		}
		if best == nil {
			return other, otherReason
		}
		if other != nil && catalogIdentity(*best) != catalogIdentity(*other) {
			return nil, "ambiguous"
		}
	}
	return best, reason
}

// Without an original-provider record, only publish fields that agree across
// deployments of the same explicitly identified model. Prices stay deployment-specific.
func catalogConsensus(entries []catalogEntry, identity string) catalogEntry {
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].ProviderID+"/"+entries[i].ModelID < entries[j].ProviderID+"/"+entries[j].ModelID
	})
	meta := map[string]any{}
	for _, key := range []string{"contextLimit", "outputLimit", "reasoning", "reasoningLevels", "defaultReasonLevel", "toolCall", "attachment", "openWeights", "modalities", "capabilities", "family", "knowledge", "releaseDate"} {
		value, exists := entries[0].Meta[key]
		if !exists {
			continue
		}
		agrees := true
		for _, entry := range entries[1:] {
			if !reflect.DeepEqual(value, entry.Meta[key]) {
				agrees = false
				break
			}
		}
		if agrees {
			meta[key] = value
		}
	}
	provider, model, _ := strings.Cut(identity, "/")
	meta["source"], meta["providerId"], meta["providerName"] = entries[0].Source, provider, provider
	meta["modelId"], meta["name"] = model, model
	meta["raw"] = map[string]any{"canonical_model_id": identity}
	return catalogEntry{entries[0].Source, provider, provider, model, meta}
}
