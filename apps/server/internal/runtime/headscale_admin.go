// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const headscalePlatformUser = "platform@"

const headscalePlatformTag = "tag:platform"

type headscaleUser struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

type headscaleNode struct {
	ID        string
	Name      string
	GivenName string
	Hostname  string
	Addresses []string
	Tags      []string
	Online    bool
	User      string
	UserID    string
	OS        string
	LastSeen  string
	Expiry    string
}

type headscalePreAuthKey struct {
	ID         string   `json:"id"`
	Key        string   `json:"key"`
	Reusable   bool     `json:"reusable"`
	Ephemeral  bool     `json:"ephemeral"`
	Used       bool     `json:"used"`
	Expiration string   `json:"expiration"`
	CreatedAt  string   `json:"createdAt"`
	ACLTags    []string `json:"aclTags"`
}

type headscaleAdminClient struct {
	loginServer string
	apiKey      string
	http        *http.Client
}

func newHeadscaleAdminClient(url, apiKey string) *headscaleAdminClient {
	return &headscaleAdminClient{
		loginServer: strings.TrimRight(url, "/"),
		apiKey:      strings.TrimSpace(apiKey),
		http:        &http.Client{Timeout: 15 * time.Second},
	}
}

func headscaleTenantUserName(tenantID string) string {
	lower := strings.ToLower(tenantID)
	var b strings.Builder
	inInvalid := false
	for _, r := range lower {
		valid := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
		if valid {
			b.WriteRune(r)
			inInvalid = false
		} else if !inInvalid {
			b.WriteByte('-')
			inInvalid = true
		}
	}
	safe := strings.Trim(b.String(), "-")
	if len(safe) > 48 {
		safe = safe[:48]
	}
	if safe == "" {
		safe = "default"
	}
	return "tenant-" + safe + "@"
}

func (c *headscaleAdminClient) request(ctx context.Context, method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(raw))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.loginServer+"/api/v1"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := ""
		if len(raw) > 0 {
			var parsed map[string]any
			if json.Unmarshal(raw, &parsed) == nil {
				if value, ok := parsed["message"]; ok {
					msg = fmt.Sprint(value)
				} else if value, ok := parsed["error"]; ok {
					msg = fmt.Sprint(value)
				}
			}
		}
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		if msg == "" {
			msg = resp.Status
		}
		return nil, fmt.Errorf("headscale API %s %s: %d %s", method, path, resp.StatusCode, msg)
	}
	if len(raw) == 0 {
		return nil, nil
	}
	return raw, nil
}

func (c *headscaleAdminClient) listUsers(ctx context.Context) ([]headscaleUser, error) {
	body, err := c.request(ctx, http.MethodGet, "/user", nil)
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return []headscaleUser{}, nil
	}
	var payload struct {
		Users json.RawMessage `json:"users"`
		User  json.RawMessage `json:"user"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if len(payload.Users) > 0 {
		var users []headscaleUser
		if json.Unmarshal(payload.Users, &users) == nil {
			return users, nil
		}
	}
	if len(payload.User) > 0 {
		var users []headscaleUser
		if json.Unmarshal(payload.User, &users) == nil {
			return users, nil
		}
	}
	return []headscaleUser{}, nil
}

func (c *headscaleAdminClient) getUserByName(ctx context.Context, name string) (*headscaleUser, error) {
	body, err := c.request(ctx, http.MethodGet, "/user?name="+url.QueryEscape(name), nil)
	if err != nil {
		return nil, err
	}
	if len(body) > 0 {
		var payload struct {
			Users json.RawMessage `json:"users"`
			User  json.RawMessage `json:"user"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return nil, err
		}
		if len(payload.Users) > 0 {
			var users []headscaleUser
			if json.Unmarshal(payload.Users, &users) == nil && len(users) > 0 {
				return &users[0], nil
			}
		}
		if len(payload.User) > 0 {
			var users []headscaleUser
			if json.Unmarshal(payload.User, &users) == nil && len(users) > 0 {
				return &users[0], nil
			}
			var user headscaleUser
			if json.Unmarshal(payload.User, &user) == nil && user.ID != "" {
				return &user, nil
			}
		}
	}
	all, err := c.listUsers(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].Name == name {
			return &all[i], nil
		}
	}
	return nil, nil
}

func (c *headscaleAdminClient) createUser(ctx context.Context, name string) (headscaleUser, error) {
	body, err := c.request(ctx, http.MethodPost, "/user", map[string]any{"name": name})
	if err != nil {
		return headscaleUser{}, err
	}
	var payload struct {
		User headscaleUser `json:"user"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			return headscaleUser{}, err
		}
	}
	return payload.User, nil
}

func (c *headscaleAdminClient) ensureTenantUser(ctx context.Context, tenantID string) (headscaleUser, error) {
	name := headscaleTenantUserName(tenantID)
	existing, err := c.getUserByName(ctx, name)
	if err != nil {
		return headscaleUser{}, err
	}
	if existing != nil {
		return *existing, nil
	}
	created, err := c.createUser(ctx, name)
	if err == nil {
		return created, nil
	}
	again, getErr := c.getUserByName(ctx, name)
	if getErr != nil {
		return headscaleUser{}, getErr
	}
	if again != nil {
		return *again, nil
	}
	return headscaleUser{}, err
}

func (c *headscaleAdminClient) ensurePlatformUser(ctx context.Context) (headscaleUser, error) {
	existing, err := c.getUserByName(ctx, headscalePlatformUser)
	if err != nil {
		return headscaleUser{}, err
	}
	if existing != nil {
		return *existing, nil
	}
	created, err := c.createUser(ctx, headscalePlatformUser)
	if err == nil {
		return created, nil
	}
	again, getErr := c.getUserByName(ctx, headscalePlatformUser)
	if getErr != nil {
		return headscaleUser{}, getErr
	}
	if again != nil {
		return *again, nil
	}
	return headscaleUser{}, err
}

func (c *headscaleAdminClient) createPreAuthKey(ctx context.Context, userID string, reusable, ephemeral bool, expirationISO string, aclTags []string) (headscalePreAuthKey, error) {
	if expirationISO == "" {
		expirationISO = time.Now().Add(90 * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	payload := map[string]any{
		"reusable":   reusable,
		"ephemeral":  ephemeral,
		"expiration": expirationISO,
	}
	if userID != "" {
		payload["user"] = userID
	}
	if len(aclTags) > 0 {
		payload["aclTags"] = aclTags
	}
	body, err := c.request(ctx, http.MethodPost, "/preauthkey", payload)
	if err != nil {
		return headscalePreAuthKey{}, err
	}
	var result struct {
		PreAuthKey headscalePreAuthKey `json:"preAuthKey"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &result); err != nil {
			return headscalePreAuthKey{}, err
		}
	}
	return result.PreAuthKey, nil
}

func (c *headscaleAdminClient) createTenantPreAuthKey(ctx context.Context, tenantID string, reusable, ephemeral bool, expirySeconds int) (headscalePreAuthKey, error) {
	user, err := c.ensureTenantUser(ctx, tenantID)
	if err != nil {
		return headscalePreAuthKey{}, err
	}
	if expirySeconds <= 0 {
		expirySeconds = 90 * 24 * 3600
	}
	expiration := time.Now().Add(time.Duration(expirySeconds) * time.Second).UTC().Format(time.RFC3339)
	return c.createPreAuthKey(ctx, user.ID, reusable, ephemeral, expiration, nil)
}

func (c *headscaleAdminClient) createPlatformPreAuthKey(ctx context.Context, reusable bool, expirySeconds int) (headscalePreAuthKey, error) {
	user, err := c.ensurePlatformUser(ctx)
	if err != nil {
		return headscalePreAuthKey{}, err
	}
	if expirySeconds <= 0 {
		expirySeconds = 365 * 24 * 3600
	}
	expiration := time.Now().Add(time.Duration(expirySeconds) * time.Second).UTC().Format(time.RFC3339)
	return c.createPreAuthKey(ctx, user.ID, reusable, false, expiration, []string{headscalePlatformTag})
}

func (c *headscaleAdminClient) listNodes(ctx context.Context, userID string) ([]headscaleNode, error) {
	path := "/node"
	if userID != "" {
		path += "?user=" + url.QueryEscape(userID)
	}
	body, err := c.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Nodes json.RawMessage `json:"nodes"`
		Node  json.RawMessage `json:"node"`
	}
	out := []headscaleNode{}
	if len(body) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	raw := []map[string]any{}
	if len(payload.Nodes) > 0 {
		_ = json.Unmarshal(payload.Nodes, &raw)
	} else if len(payload.Node) > 0 {
		_ = json.Unmarshal(payload.Node, &raw)
	}
	for _, item := range raw {
		out = append(out, c.normalizeNode(item))
	}
	return out, nil
}

func (c *headscaleAdminClient) listTenantNodes(ctx context.Context, tenantID string) ([]headscaleNode, error) {
	user, err := c.ensureTenantUser(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	return c.listNodes(ctx, user.ID)
}

func (c *headscaleAdminClient) deleteNode(ctx context.Context, nodeID string) error {
	_, err := c.request(ctx, http.MethodDelete, "/node/"+url.PathEscape(nodeID), nil)
	return err
}

func (c *headscaleAdminClient) expirePreAuthKey(ctx context.Context, userID, key string) error {
	_, err := c.request(ctx, http.MethodPost, "/preauthkey/expire", map[string]any{"user": userID, "key": key})
	return err
}

func (c *headscaleAdminClient) probe(ctx context.Context) (userCount, nodeCount int, err error) {
	users, err := c.listUsers(ctx)
	if err != nil {
		return 0, 0, err
	}
	nodes, err := c.listNodes(ctx, "")
	if err != nil {
		return 0, 0, err
	}
	return len(users), len(nodes), nil
}

func (c *headscaleAdminClient) normalizeNode(raw map[string]any) headscaleNode {
	addresses := []string{}
	if value, ok := raw["ipAddresses"].([]any); ok {
		addresses = stringSlice(value)
	} else if value, ok := raw["addresses"].([]any); ok {
		addresses = stringSlice(value)
	}
	tags := []string{}
	if value, ok := raw["tags"].([]any); ok {
		tags = stringSlice(value)
	} else if value, ok := raw["forcedTags"].([]any); ok {
		tags = stringSlice(value)
	}
	userName := ""
	userID := ""
	if user, ok := raw["user"].(map[string]any); ok {
		userName = stringOr(user["name"])
		userID = stringOr(user["id"])
	}
	name := firstString(stringOr(raw["name"]), stringOr(raw["givenName"]), stringOr(raw["hostname"]), stringOr(raw["id"]))
	if name == "" {
		name = "node"
	}
	hostname := firstString(stringOr(raw["hostname"]), stringOr(raw["givenName"]), name)
	online := false
	if value, ok := raw["online"]; ok {
		online = boolOr(value)
	} else {
		online = boolOr(raw["connected"])
	}
	return headscaleNode{
		ID:        stringOr(raw["id"]),
		Name:      name,
		GivenName: stringOr(raw["givenName"]),
		Hostname:  hostname,
		Addresses: addresses,
		Tags:      tags,
		Online:    online,
		User:      userName,
		UserID:    userID,
		OS:        stringOr(raw["os"]),
		LastSeen:  stringOr(raw["lastSeen"]),
		Expiry:    stringOr(raw["expiry"]),
	}
}

func stringOr(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func firstString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func boolOr(value any) bool {
	if value == nil {
		return false
	}
	if flag, ok := value.(bool); ok {
		return flag
	}
	return false
}
