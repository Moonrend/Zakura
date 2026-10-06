// Zakura is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or any later version.
package runtime

import (
	"encoding/json"
	"time"
)

type Space struct {
	ID              string          `json:"id"`
	TenantID        string          `json:"tenantId,omitempty"`
	Name            string          `json:"name"`
	Slug            string          `json:"slug"`
	Description     string          `json:"description"`
	EnableComputer  bool            `json:"enableComputer"`
	WorkspaceImage  *string         `json:"workspaceImage"`
	RuntimeNodeID   *string         `json:"runtimeNodeId"`
	WorkspaceKind   string          `json:"workspaceKind"`
	WorkspaceStatus string          `json:"workspaceStatus"`
	Config          json.RawMessage `json:"config"`
	LastError       *string         `json:"lastError"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

type Agent struct {
	ID               string          `json:"id"`
	TenantID         string          `json:"tenantId,omitempty"`
	SpaceID          string          `json:"spaceId"`
	Name             string          `json:"name"`
	Slug             string          `json:"slug"`
	Description      string          `json:"description"`
	EnableMemory     bool            `json:"enableMemory"`
	MemoryProviderID *string         `json:"memoryProviderId"`
	Config           json.RawMessage `json:"config"`
	LastError        *string         `json:"lastError"`
	AvatarColor      *string         `json:"avatarColor"`
	AvatarShape      *string         `json:"avatarShape"`
	AvatarURL        *string         `json:"avatarUrl"`
	CreatedAt        time.Time       `json:"createdAt"`
	UpdatedAt        time.Time       `json:"updatedAt"`
}

type Session struct {
	ID              string          `json:"id"`
	AgentID         string          `json:"agentId"`
	Title           string          `json:"title"`
	Status          string          `json:"status"`
	Kind            string          `json:"kind"`
	Project         *string         `json:"project"`
	Origin          json.RawMessage `json:"origin"`
	Model           *string         `json:"model"`
	ModelRouteID    *string         `json:"modelRouteId"`
	Reasoning       *string         `json:"reasoning"`
	DraftText       string          `json:"draftText"`
	LastSeq         int64           `json:"lastSeq"`
	ActiveRunID     *string         `json:"activeRunId"`
	CreatedByUserID *string         `json:"createdByUserId,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

type Event struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId"`
	Seq       int64           `json:"seq"`
	Type      string          `json:"type"`
	RunID     *string         `json:"runId"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

type Run struct {
	ID              string     `json:"id"`
	SessionID       string     `json:"sessionId"`
	Status          string     `json:"status"`
	CancelRequested bool       `json:"cancelRequested"`
	Error           *string    `json:"error"`
	StartedAt       *time.Time `json:"startedAt"`
	CompletedAt     *time.Time `json:"completedAt"`
	CreatedAt       time.Time  `json:"createdAt"`
}

type QueueMessage struct {
	ID          string          `json:"id"`
	Content     string          `json:"content"`
	Attachments json.RawMessage `json:"attachments,omitempty"`
	Options     json.RawMessage `json:"options,omitempty"`
}

type Memory struct {
	ID         string          `json:"id"`
	AgentID    string          `json:"agentId"`
	ProviderID *string         `json:"providerId"`
	Layer      string          `json:"layer"`
	Content    string          `json:"content"`
	Tags       json.RawMessage `json:"tags"`
	Pinned     bool            `json:"pinned"`
	Importance string          `json:"importance"`
	Source     string          `json:"source"`
	Metadata   json.RawMessage `json:"metadata"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

type Skill struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Version     *string         `json:"version"`
	Builtin     bool            `json:"builtin"`
	Source      json.RawMessage `json:"source"`
	Homepage    *string         `json:"homepage"`
	License     *string         `json:"license"`
	Files       json.RawMessage `json:"files"`
	FileCount   int             `json:"fileCount"`
	SizeBytes   int64           `json:"sizeBytes"`
	AutoUpdate  bool            `json:"autoUpdate"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

type Upstream struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Slug      string          `json:"slug"`
	Protocol  string          `json:"protocol"`
	Config    json.RawMessage `json:"config"`
	Status    string          `json:"status"`
	LastError *string         `json:"lastError"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

type ModelRoute struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Slug       string          `json:"slug"`
	Capability string          `json:"capability"`
	Alias      *string         `json:"alias"`
	UpstreamID string          `json:"upstreamId"`
	Model      string          `json:"model"`
	Options    json.RawMessage `json:"options"`
	Priority   int             `json:"priority"`
	Weight     int             `json:"weight"`
	IsDefault  bool            `json:"isDefault"`
	Status     string          `json:"status"`
	LastError  *string         `json:"lastError"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

type GatewayRequest struct {
	Model       string            `json:"model"`
	Messages    []json.RawMessage `json:"messages,omitempty"`
	Input       json.RawMessage   `json:"input,omitempty"`
	Stream      bool              `json:"stream,omitempty"`
	Temperature *float64          `json:"temperature,omitempty"`
	MaxTokens   *int              `json:"max_tokens,omitempty"`
	Tools       json.RawMessage   `json:"tools,omitempty"`
	Metadata    json.RawMessage   `json:"metadata,omitempty"`
}
