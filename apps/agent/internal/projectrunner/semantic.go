package projectrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

// The cache contains immutable snapshot indexes only. Scope and repository root
// are part of every key, so two tenants/projects cannot share content by an ID.
const maxSemanticCacheBytes = 64 << 20
const maxSemanticReplyBytes = 8 << 20

var semanticCache = struct {
	sync.Mutex
	entries map[string]semanticCacheEntry
	weight  int64
	clock   uint64
}{entries: map[string]semanticCacheEntry{}}

type semanticCacheEntry struct {
	index  *semantic.Index
	weight int64
	access uint64
}
type semanticRequest struct {
	Scope
	SnapshotID     string `json:"snapshotId"`
	BeforeSnapshot string `json:"beforeSnapshot,omitempty"`
	Query          string `json:"query,omitempty"`
	Path           string `json:"path,omitempty"`
	Kind           string `json:"kind,omitempty"`
	ExportedOnly   bool   `json:"exportedOnly,omitempty"`
	Limit          int    `json:"limit,omitempty"`
	Offset         int    `json:"offset,omitempty"`
	SymbolID       string `json:"symbolId,omitempty"`
}

var semanticMethodFields = map[string]string{
	"project.semantic.index":   "snapshotId",
	"project.semantic.search":  "snapshotId query path kind exportedOnly limit offset",
	"project.semantic.file":    "snapshotId path limit",
	"project.semantic.symbol":  "snapshotId symbolId limit",
	"project.semantic.compare": "snapshotId beforeSnapshot limit",
}

func decodeSemanticRequest(method string, raw json.RawMessage) (semanticRequest, error) {
	fields, ok := semanticMethodFields[method]
	if !ok {
		return semanticRequest{}, errors.New("unknown project semantic RPC method")
	}
	if len(raw) == 0 || len(raw) > 65536 {
		return semanticRequest{}, errors.New("semantic RPC request size exceeds limit")
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil || keys == nil {
		return semanticRequest{}, errors.New("semantic parameters must be a JSON object")
	}
	allowed := map[string]bool{"spaceId": true, "projectId": true}
	for _, field := range strings.Fields(fields) {
		allowed[field] = true
	}
	for key := range keys {
		if !allowed[key] {
			return semanticRequest{}, fmt.Errorf("unsupported semantic parameter %q", key)
		}
	}
	var req semanticRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, errors.New("invalid semantic parameters")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return req, errors.New("semantic request requires exactly one JSON object")
	}
	if err := req.Scope.Validate(); err != nil {
		return req, err
	}
	if req.SnapshotID == "" || len(req.SnapshotID) > 128 {
		return req, errors.New("snapshotId is required")
	}
	if req.Limit < 0 || req.Limit > 1000 || req.Offset < 0 || req.Offset > 1000000 {
		return req, errors.New("invalid semantic result window")
	}
	return req, nil
}

type semanticSource struct{ repository *workspace.Repository }

func (s semanticSource) Files(ctx context.Context, id string) ([]semantic.InputFile, error) {
	snapshot, err := s.repository.GetSnapshot(ctx, id)
	if err != nil {
		return nil, err
	}
	files := make([]semantic.InputFile, 0, len(snapshot.Entries))
	for _, entry := range snapshot.Entries {
		files = append(files, semantic.InputFile{Path: entry.Path, Hash: entry.Hash, Size: entry.Size})
	}
	return files, nil
}
func (s semanticSource) Read(ctx context.Context, id, path string) ([]byte, error) {
	return s.repository.ReadSnapshot(ctx, id, path)
}
func cachedSemanticIndex(ctx context.Context, p *project, id string) (*semantic.Index, error) {
	// Validate existence on every read even on cache hits; GC must not make a
	// deleted artifact observable merely because an old index is in memory.
	if _, err := p.repository.GetSnapshot(ctx, id); err != nil {
		return nil, err
	}
	key := p.root + "\x00" + semantic.Version + "\x00" + id
	semanticCache.Lock()
	semanticCache.clock++
	entry, ok := semanticCache.entries[key]
	if ok {
		entry.access = semanticCache.clock
		semanticCache.entries[key] = entry
	}
	semanticCache.Unlock()
	if ok {
		return entry.index, nil
	}
	index, err := semantic.Build(ctx, semanticSource{p.repository}, id, semantic.DefaultLimits())
	if err != nil {
		return nil, err
	}
	weight := index.EstimatedBytes()
	if weight > maxSemanticCacheBytes {
		return index, nil
	}
	semanticCache.Lock()
	defer semanticCache.Unlock()
	if current, ok := semanticCache.entries[key]; ok {
		return current.index, nil
	}
	for len(semanticCache.entries) >= 16 || semanticCache.weight+weight > maxSemanticCacheBytes {
		keys := make([]string, 0, len(semanticCache.entries))
		for existing := range semanticCache.entries {
			keys = append(keys, existing)
		}
		sort.Strings(keys)
		victim := ""
		oldest := ^uint64(0)
		for _, candidate := range keys {
			if semanticCache.entries[candidate].access < oldest {
				victim = candidate
				oldest = semanticCache.entries[candidate].access
			}
		}
		if victim == "" {
			break
		}
		semanticCache.weight -= semanticCache.entries[victim].weight
		delete(semanticCache.entries, victim)
	}
	semanticCache.clock++
	semanticCache.entries[key] = semanticCacheEntry{index: index, weight: weight, access: semanticCache.clock}
	semanticCache.weight += weight
	return index, nil
}

// SemanticDispatch is an independently decoded read-only RPC family. The
// ordinary dispatcher routes this prefix before mutable-workspace decoding.
func (m *Manager) SemanticDispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	req, err := decodeSemanticRequest(method, raw)
	if err != nil {
		return nil, err
	}
	p, err := m.get(req.Scope)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	index, err := cachedSemanticIndex(ctx, p, req.SnapshotID)
	if err != nil {
		return nil, err
	}
	var result any
	switch method {
	case "project.semantic.index":
		result = index.Summary()
	case "project.semantic.search":
		result, err = index.Search(semantic.SearchQuery{Query: req.Query, Path: req.Path, Kind: req.Kind, ExportedOnly: req.ExportedOnly, Limit: req.Limit, Offset: req.Offset})
	case "project.semantic.file":
		var file semantic.FileResult
		file, err = index.File(req.Path)
		if err == nil {
			file = semantic.LimitFile(file, req.Limit)
			result = file
		}
	case "project.semantic.symbol":
		result, err = index.Navigate(req.SymbolID, req.Limit)
	case "project.semantic.compare":
		if req.BeforeSnapshot == "" {
			return nil, errors.New("beforeSnapshot is required")
		}
		var before *semantic.Index
		before, err = cachedSemanticIndex(ctx, p, req.BeforeSnapshot)
		if err == nil {
			var comparison semantic.Comparison
			comparison, err = semantic.Compare(before, index)
			if err == nil {
				result = semantic.LimitComparison(comparison, req.Limit)
			}
		}
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxSemanticReplyBytes {
		return nil, fmt.Errorf("%w: semantic output exceeds 8 MiB; request a narrower file or result window", semantic.ErrLimit)
	}
	return json.RawMessage(encoded), nil
}
