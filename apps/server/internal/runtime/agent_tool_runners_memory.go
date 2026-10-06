// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"strings"
)

const memorySearchMinScore = 0.25

type memorySearchHit struct {
	Memory   Memory
	Score    float64
	Semantic bool
}

func memoryScoreValue(score float64) float64 {
	return math.Round(score*10000) / 10000
}

func mergeMemorySearch(limit int, semantic []memorySearchHit, like []Memory) []memorySearchHit {
	merged := make([]memorySearchHit, 0, limit)
	seen := make(map[string]bool, len(semantic)+len(like))
	for _, hit := range semantic {
		if len(merged) >= limit {
			return merged
		}
		if seen[hit.Memory.ID] {
			continue
		}
		seen[hit.Memory.ID] = true
		merged = append(merged, hit)
	}
	for _, item := range like {
		if len(merged) >= limit {
			return merged
		}
		if seen[item.ID] {
			continue
		}
		seen[item.ID] = true
		merged = append(merged, memorySearchHit{Memory: item})
	}
	return merged
}

func (h *handler) memorySearchSemantic(ctx context.Context, tenant, agent, query string, limit int) ([]memorySearchHit, bool) {
	if strings.TrimSpace(query) == "" {
		return nil, false
	}
	cfg, err := h.agentEmbeddingConfig(ctx, tenant, agent)
	if err != nil || cfg == nil {
		return nil, false
	}
	vector, _, err := h.embedMemoryText(ctx, tenant, cfg, query)
	if err != nil || len(vector) == 0 {
		return nil, false
	}
	return h.memoryEmbeddingHits(ctx, tenant, agent, vector, limit), true
}

func (h *handler) memoryScoredSearch(ctx context.Context, tenant, agent, query string, limit int) ([]memorySearchHit, error) {
	if hits, available := h.memorySearchSemantic(ctx, tenant, agent, query, limit); available {
		return hits, nil
	}
	return h.memorySearchTrigram(ctx, tenant, agent, query, limit)
}

func (h *handler) memorySearchTrigram(ctx context.Context, tenant, agent, query string, limit int) ([]memorySearchHit, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	if h.deps == nil || h.deps.Gorm == nil || h.deps.Gorm.Dialector.Name() != "postgres" {
		return nil, nil
	}
	key := tenant + "/" + agent
	h.trigramMu.Lock()
	if h.trigramStates == nil {
		h.trigramStates = map[string]string{}
	}
	state := h.trigramStates[key]
	h.trigramMu.Unlock()
	if state == "" {
		var probe float64
		if err := h.deps.Gorm.WithContext(ctx).Raw(`SELECT similarity('abc','abc')`).Scan(&probe).Error; err != nil {
			if ctx.Err() == nil {
				h.trigramMu.Lock()
				h.trigramStates[key] = "no"
				h.trigramMu.Unlock()
			}
			return nil, nil
		}
		h.trigramMu.Lock()
		h.trigramStates[key] = "ok"
		h.trigramMu.Unlock()
		state = "ok"
	}
	if state != "ok" {
		return nil, nil
	}
	var rows []struct {
		ID         string  `gorm:"column:id"`
		Content    string  `gorm:"column:content"`
		Tags       string  `gorm:"column:tags_json"`
		Pinned     bool    `gorm:"column:pinned"`
		Importance string  `gorm:"column:importance"`
		Layer      string  `gorm:"column:layer"`
		CreatedAt  string  `gorm:"column:created_at"`
		Score      float64 `gorm:"column:score"`
	}
	const trigramSQL = `SELECT id,content,tags_json,pinned,importance,layer,created_at,similarity(content, ?) AS score FROM memories WHERE tenant_id=? AND agent_id=? AND similarity(content, ?) > 0.2 ORDER BY score DESC LIMIT ?`
	if err := h.deps.Gorm.WithContext(ctx).Raw(trigramSQL, query, tenant, agent, query, limit).Scan(&rows).Error; err != nil {
		return nil, err
	}
	hits := make([]memorySearchHit, 0, len(rows))
	for _, row := range rows {
		hits = append(hits, memorySearchHit{
			Memory: Memory{
				ID:         row.ID,
				AgentID:    agent,
				Layer:      row.Layer,
				Content:    row.Content,
				Tags:       json.RawMessage(row.Tags),
				Pinned:     row.Pinned,
				Importance: row.Importance,
				CreatedAt:  parseTime(row.CreatedAt),
			},
			Score:    row.Score,
			Semantic: true,
		})
	}
	return hits, nil
}

func (h *handler) memoryEmbeddingHits(ctx context.Context, tenant, agent string, queryVector []float64, limit int) []memorySearchHit {
	var rows []struct {
		ID         string `gorm:"column:id"`
		Content    string `gorm:"column:content"`
		Tags       string `gorm:"column:tags_json"`
		Pinned     bool   `gorm:"column:pinned"`
		Importance string `gorm:"column:importance"`
		Layer      string `gorm:"column:layer"`
		CreatedAt  string `gorm:"column:created_at"`
		Embedding  string `gorm:"column:embedding"`
		Dim        *int   `gorm:"column:embedding_dim"`
	}
	err := h.deps.Gorm.WithContext(ctx).Table("memories").Select("id,content,tags_json,pinned,importance,layer,created_at,embedding,embedding_dim").Where("tenant_id = ? AND agent_id = ? AND embedding IS NOT NULL AND embedding <> ''", tenant, agent).Order("pinned DESC, updated_at DESC").Limit(500).Scan(&rows).Error
	if err != nil {
		return nil
	}
	hits := make([]memorySearchHit, 0, len(rows))
	for _, row := range rows {
		var vector []float64
		if json.Unmarshal([]byte(row.Embedding), &vector) != nil || len(vector) == 0 {
			continue
		}
		if row.Dim != nil && *row.Dim != len(vector) {
			continue
		}
		score := cosineSimilarity(queryVector, vector)
		if score <= memorySearchMinScore {
			continue
		}
		hits = append(hits, memorySearchHit{
			Memory: Memory{
				ID:         row.ID,
				AgentID:    agent,
				Layer:      row.Layer,
				Content:    row.Content,
				Tags:       json.RawMessage(row.Tags),
				Pinned:     row.Pinned,
				Importance: row.Importance,
				CreatedAt:  parseTime(row.CreatedAt),
			},
			Score:    score,
			Semantic: true,
		})
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

func cosineSimilarity(a, b []float64) float64 {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}
