// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"gorm.io/gorm"
)

type memoryEmbeddingConfig struct {
	RouteID    string
	RouteSlug  string
	BaseURL    string
	APIKey     string
	Model      string
	Dimensions int
}

func (h *handler) agentEmbeddingConfig(ctx context.Context, tenant, agent string) (*memoryEmbeddingConfig, error) {
	var agentRow struct {
		MemoryProviderID *string `gorm:"column:memory_provider_id"`
	}
	if err := h.deps.Gorm.WithContext(ctx).Table("agents").Select("memory_provider_id").Where("tenant_id = ? AND id = ?", tenant, agent).Take(&agentRow).Error; errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	providerID := agentRow.MemoryProviderID
	var mpRow struct {
		ID         string `gorm:"column:id"`
		Kind       string `gorm:"column:kind"`
		ConfigJSON string `gorm:"column:config_json"`
	}
	mp := h.deps.Gorm.WithContext(ctx).Table("memory_providers").Select("id, kind, config_json").Where("tenant_id = ? AND enabled = TRUE", tenant)
	if providerID != nil && *providerID != "" {
		mp = mp.Where("id = ?", *providerID)
	} else {
		mp = mp.Order("is_default DESC").Order("created_at").Limit(1)
	}
	if err := mp.Take(&mpRow).Error; errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	id, kind, configRaw := mpRow.ID, mpRow.Kind, mpRow.ConfigJSON
	if kind != "builtin" {
		return nil, nil
	}
	var config map[string]any
	if json.Unmarshal([]byte(configRaw), &config) != nil {
		return nil, nil
	}
	embedding, _ := config["embedding"].(map[string]any)
	if embedding == nil || embedding["enabled"] != true {
		return nil, nil
	}
	cfg := &memoryEmbeddingConfig{}
	cfg.RouteID, _ = embedding["routeId"].(string)
	cfg.RouteSlug, _ = embedding["routeSlug"].(string)
	cfg.BaseURL, _ = embedding["baseUrl"].(string)
	cfg.APIKey, _ = embedding["apiKey"].(string)
	cfg.Model, _ = embedding["model"].(string)
	if value, ok := embedding["dimensions"].(float64); ok && value > 0 {
		cfg.Dimensions = int(value)
	}
	if cfg.APIKey == "" {
		if value, ok := config["apiKey"].(string); ok {
			cfg.APIKey = value
		}
		if enc, ok := config["apiKeyEnc"].(string); ok && enc != "" {
			if plain, err := openSecretBox(h.deps.Secret, "memory-provider:"+id, enc); err == nil {
				var secret struct {
					APIKey string `json:"apiKey"`
				}
				if json.Unmarshal(plain, &secret) == nil {
					cfg.APIKey = secret.APIKey
				}
			}
		}
	}
	if cfg.BaseURL == "" && cfg.RouteID == "" && cfg.RouteSlug == "" {
		cfg.Model = "router"
	}
	if cfg.BaseURL != "" && cfg.Model == "" {
		return nil, nil
	}
	return cfg, nil
}

func (h *handler) embedMemoryText(ctx context.Context, tenant string, cfg *memoryEmbeddingConfig, text string) ([]float64, string, error) {
	body := map[string]any{"input": strings.TrimSpace(text)}
	if cfg.Model != "" && cfg.Model != "router" {
		body["model"] = cfg.Model
	}
	if cfg.Dimensions > 0 {
		body["dimensions"] = cfg.Dimensions
	}
	payload, _ := json.Marshal(body)
	var raw []byte
	if cfg.BaseURL == "" {
		selector := cfg.RouteSlug
		if cfg.RouteID != "" {
			var slugRow struct {
				Slug string `gorm:"column:slug"`
			}
			if err := h.deps.Gorm.WithContext(ctx).Table("model_routes").Select("slug").Where("tenant_id = ? AND id = ? AND capability = 'embedding'", tenant, cfg.RouteID).Take(&slugRow).Error; err != nil {
				return nil, "", errors.New("embedding model route not found")
			}
			selector = slugRow.Slug
		}
		resp, err := h.service.gateway.Do(ctx, tenant, "embedding", "embeddings", selector, payload)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		raw, err = io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return nil, "", err
		}
		if resp.Status < 200 || resp.Status >= 300 {
			return nil, "", fmt.Errorf("embedding failed HTTP %d: %s", resp.Status, string(raw))
		}
	} else {
		u, err := safeProviderURL(strings.TrimRight(cfg.BaseURL, "/"), "embeddings")
		if err != nil {
			return nil, "", err
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		if cfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
		resp, err := h.service.gateway.client.Do(req)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		raw, err = io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return nil, "", err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, "", fmt.Errorf("embedding failed HTTP %d: %s", resp.StatusCode, string(raw))
		}
	}
	var decoded struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
			Index     int       `json:"index"`
		} `json:"data"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded.Data) != 1 || len(decoded.Data[0].Embedding) == 0 {
		return nil, "", errors.New("embedding response missing vector")
	}
	model := decoded.Model
	if model == "" {
		model = cfg.Model
	}
	return decoded.Data[0].Embedding, model, nil
}

func (h *handler) setMemoryEmbedding(ctx context.Context, tenant, agent, id, content string, vector []float64, model string) error {
	encoded, _ := json.Marshal(vector)
	hash := sha256.Sum256([]byte(content))
	result := h.deps.Gorm.WithContext(ctx).Table("memories").Where("tenant_id = ? AND agent_id = ? AND id = ?", tenant, agent, id).Updates(map[string]any{"embedding": string(encoded), "embedding_model": model, "embedding_dim": len(vector), "content_hash": hex.EncodeToString(hash[:]), "updated_at": runtimeTimeString(h.store.now())})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
