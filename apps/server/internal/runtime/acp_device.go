// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// These are Codex's device flow endpoints, not a general OAuth proxy. Never use
// profile/caller supplied URLs, client IDs, redirects, or device codes.
const codexDeviceIssuer = "https://auth.openai.com"
const codexDeviceClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
const codexDeviceTTL = 15 * time.Minute
const acpDeviceTable = "acp_device_auth_attempts"

var errACPDeviceConflict = errors.New("ACP authentication attempt is busy or changed; retry")

type acpDeviceAttempt struct {
	ID                  string `gorm:"column:id"`
	TenantID            string `gorm:"column:tenant_id"`
	SpaceID             string `gorm:"column:space_id"`
	ProfileID           string `gorm:"column:profile_id"`
	PrincipalID         string `gorm:"column:principal_id"`
	NodeID              string `gorm:"column:node_id"`
	ComputerID          string `gorm:"column:computer_id"`
	WorkspaceInstanceID string `gorm:"column:workspace_instance_id"`
	WorkspaceGeneration int64  `gorm:"column:workspace_generation"`
	ConfigHash          string `gorm:"column:config_hash"`
	Status              string `gorm:"column:status"`
	EncryptedPayload    string `gorm:"column:encrypted_payload"`
	UserCode            string `gorm:"column:user_code"`
	VerificationURI     string `gorm:"column:verification_uri"`
	IntervalSeconds     int    `gorm:"column:interval_seconds"`
	ExpiresAt           string `gorm:"column:expires_at"`
	NextPollAt          string `gorm:"column:next_poll_at"`
	Version             int64  `gorm:"column:version"`
	Error               string `gorm:"column:error"`
	CreatedAt           string `gorm:"column:created_at"`
	UpdatedAt           string `gorm:"column:updated_at"`
}

type acpDevicePublic struct {
	AttemptID       string `json:"attemptId"`
	Status          string `json:"status"`
	UserCode        string `json:"userCode,omitempty"`
	VerificationURI string `json:"verificationUri,omitempty"`
	ExpiresAt       string `json:"expiresAt"`
	NextPollAt      string `json:"nextPollAt,omitempty"`
	Interval        int    `json:"interval"`
	Error           string `json:"error,omitempty"`
}

func (a acpDeviceAttempt) public() acpDevicePublic {
	status := a.Status
	switch status {
	case "starting", "polling", "persisting":
		status = "pending"
	case "succeeded":
		status = "complete"
	}
	out := acpDevicePublic{AttemptID: a.ID, Status: status, ExpiresAt: a.ExpiresAt, NextPollAt: a.NextPollAt, Interval: a.IntervalSeconds, Error: a.Error}
	if status == "pending" {
		out.UserCode = a.UserCode
		out.VerificationURI = a.VerificationURI
	}
	return out
}

func acpDeviceActive(status string) bool {
	return status == "starting" || status == "pending" || status == "polling" || status == "persisting"
}

type acpDevicePayload struct {
	DeviceAuthID string `json:"deviceAuthId"`
	UserCode     string `json:"userCode"`
}

type acpDeviceTarget struct {
	space  Space
	setup  acpSetup
	runner *runnerSession
	exec   *resolvedExecution
	hash   string
}

func (h *handler) codexDeviceTarget(ctx context.Context, tenant, spaceID, profile string) (acpDeviceTarget, error) {
	var target acpDeviceTarget
	if profile != "codex" {
		return target, errors.New("device authentication is supported only for Codex")
	}
	space, raw, err := h.acpSpace(ctx, tenant, "", spaceID)
	if err != nil {
		return target, err
	}
	setup, ok := parseACPConfig(acpMap(raw)).Agents[profile]
	if !ok || !setup.Enabled {
		return target, ErrNotFound
	}
	if setup.Command != "" || setup.SetupMode != "oauth" || setup.ModelProvider != "native" {
		return target, errors.New("Codex device authentication requires the native managed OAuth profile")
	}
	for _, name := range []string{"HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"} {
		if setup.Env[name] != "" {
			return target, errors.New("custom authentication HOME is not supported")
		}
	}
	runner, exec, err := h.acpSpaceRunner(ctx, tenant, space.ID)
	if err != nil {
		return target, err
	}
	rawSetup, _ := json.Marshal(setup)
	if exec.workspace != nil {
		rawSetup, _ = json.Marshal([]any{setup, exec.workspace})
	}
	digest := sha256.Sum256(rawSetup)
	return acpDeviceTarget{space: space, setup: setup, runner: runner, exec: exec, hash: hex.EncodeToString(digest[:])}, nil
}

func (h *handler) codexDeviceHTTP(ctx context.Context, path string, body []byte, form bool, out any) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexDeviceIssuer+path, bytes.NewReader(body))
	if err != nil {
		return 0, errors.New("device authentication request failed")
	}
	contentType := "application/json"
	if form {
		contentType = "application/x-www-form-urlencoded"
	}
	req.Header.Set("Content-Type", contentType)
	client := http.Client{Timeout: 15 * time.Second}
	if h.deps.HTTPClient != nil {
		client = *h.deps.HTTPClient
	}
	// Never follow an upstream redirect carrying an authorization code/token.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return 0, errors.New("Codex authentication service is unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || json.Unmarshal(data, out) != nil {
		return resp.StatusCode, errors.New("invalid Codex authentication response")
	}
	return resp.StatusCode, nil
}

func (h *handler) acpDeviceLoad(ctx context.Context, principal, tenant, space, profile, id string) (acpDeviceAttempt, error) {
	var attempt acpDeviceAttempt
	if id == "" || principal == "" {
		return attempt, ErrNotFound
	}
	err := h.deps.Gorm.WithContext(ctx).Table(acpDeviceTable).Where("id=? AND principal_id=? AND tenant_id=? AND space_id=? AND profile_id=?", id, principal, tenant, space, profile).Take(&attempt).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return attempt, ErrNotFound
	}
	return attempt, err
}

func (h *handler) acpDeviceCAS(ctx context.Context, a *acpDeviceAttempt, values map[string]any) error {
	values["version"] = a.Version + 1
	values["updated_at"] = runtimeTimeString(h.store.now())
	res := h.deps.Gorm.WithContext(ctx).Table(acpDeviceTable).Where("id=? AND tenant_id=? AND space_id=? AND profile_id=? AND principal_id=? AND status=? AND version=?", a.ID, a.TenantID, a.SpaceID, a.ProfileID, a.PrincipalID, a.Status, a.Version).Updates(values)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return errACPDeviceConflict
	}
	a.Version++
	if value, ok := values["status"].(string); ok {
		a.Status = value
	}
	if value, ok := values["encrypted_payload"].(string); ok {
		a.EncryptedPayload = value
	}
	if value, ok := values["next_poll_at"].(string); ok {
		a.NextPollAt = value
	}
	if value, ok := values["error"].(string); ok {
		a.Error = value
	}
	return nil
}

func (h *handler) acpDeviceFinish(ctx context.Context, a *acpDeviceAttempt, status, message string) error {
	if err := h.acpDeviceCAS(ctx, a, map[string]any{"status": status, "error": message, "encrypted_payload": "", "user_code": "", "verification_uri": ""}); err != nil {
		return err
	}
	a.UserCode, a.VerificationURI = "", ""
	return h.releaseACPAuthLock(ctx, a.TenantID, a.SpaceID, a.ProfileID, a.ID)
}

func (h *handler) acpDeviceUnknown(ctx context.Context, a *acpDeviceAttempt) error {
	// Never release the profile lock after an unconfirmed remote side effect.
	// Parent recovery requires explicit quiescence acknowledgement before reuse.
	return h.acpDeviceCAS(ctx, a, map[string]any{"status": "unknown", "encrypted_payload": "", "user_code": "", "verification_uri": "", "error": "Credential write outcome is unknown; reconcile this profile before signing in again"})
}

func (h *handler) startACPDeviceAttempt(ctx context.Context, principal, tenant, space, profile string) (acpDevicePublic, error) {
	var empty acpDevicePublic
	if principal == "" {
		return empty, ErrNotFound
	}
	lease, err := h.acquireSpaceInfrastructure(ctx, tenant, space)
	if err != nil {
		return empty, err
	}
	defer lease.release()
	ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, lease.Space)
	target, err := h.codexDeviceTarget(ctx, tenant, space, profile)
	if err != nil {
		return empty, err
	}
	now := h.store.now()
	id := h.store.id()
	// Expire only attempts owned by this claim. Retirement may have already
	// opened the same profile on a replacement disk while target resolution ran.
	instance := ""
	var generation int64
	if target.exec.workspace != nil {
		instance, generation = target.exec.workspace.Target.InstanceID, target.exec.workspace.Target.Generation
	}
	if err = lease.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table(acpDeviceTable).Where("tenant_id=? AND space_id=? AND profile_id=? AND workspace_instance_id=? AND workspace_generation=? AND status IN ? AND expires_at<=?", tenant, space, profile, instance, generation, []string{"starting", "pending", "polling"}, runtimeTimeString(now)).Updates(map[string]any{"status": "expired", "encrypted_payload": "", "user_code": "", "verification_uri": "", "error": "Device authentication expired", "version": gorm.Expr("version+1"), "updated_at": runtimeTimeString(now)}).Error
	}); err != nil {
		return empty, err
	}
	if err = h.acquireACPAuthLock(ctx, tenant, space, profile, "device", id, codexDeviceTTL, target.exec); err != nil {
		return empty, err
	}
	a := acpDeviceAttempt{ID: id, TenantID: tenant, SpaceID: space, ProfileID: profile, PrincipalID: principal, NodeID: target.exec.nodeID, ComputerID: target.exec.computer.ID, ConfigHash: target.hash, Status: "starting", IntervalSeconds: 5, ExpiresAt: runtimeTimeString(now.Add(codexDeviceTTL)), NextPollAt: runtimeTimeString(now), Version: 1, CreatedAt: runtimeTimeString(now), UpdatedAt: runtimeTimeString(now)}
	if target.exec.workspace != nil {
		a.WorkspaceInstanceID, a.WorkspaceGeneration = target.exec.workspace.Target.InstanceID, target.exec.workspace.Target.Generation
	}
	if err = lease.fenced(ctx, func(tx *gorm.DB) error {
		return tx.Table(acpDeviceTable).Create(&a).Error
	}); err != nil {
		_ = h.releaseACPAuthLock(context.WithoutCancel(ctx), tenant, space, profile, id)
		return empty, errACPDeviceConflict
	}
	lease.release()
	var response struct {
		DeviceAuthID string          `json:"device_auth_id"`
		UserCode     string          `json:"user_code"`
		Usercode     string          `json:"usercode"`
		Interval     json.RawMessage `json:"interval"`
	}
	body, _ := json.Marshal(map[string]any{"client_id": codexDeviceClientID})
	status, err := h.codexDeviceHTTP(ctx, "/api/accounts/deviceauth/usercode", body, false, &response)
	if response.UserCode == "" {
		response.UserCode = response.Usercode
	}
	if err != nil || status < 200 || status >= 300 || response.DeviceAuthID == "" || response.UserCode == "" {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Unable to start Codex device authentication")
		return empty, errors.New("unable to start Codex device authentication")
	}
	interval := 5
	var seconds string
	if json.Unmarshal(response.Interval, &seconds) == nil {
		if parsed, parseErr := time.ParseDuration(strings.TrimSpace(seconds) + "s"); parseErr == nil && parsed > 0 && parsed <= time.Minute {
			interval = int(parsed / time.Second)
		}
	}
	payload, _ := json.Marshal(acpDevicePayload{DeviceAuthID: response.DeviceAuthID, UserCode: response.UserCode})
	envelope, err := computers.SealCredentials(h.deps.Secret, tenant, space, "acp-device:"+id, payload)
	if err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Unable to store device authentication")
		return empty, errors.New("unable to store device authentication")
	}
	next := runtimeTimeString(h.store.now().Add(time.Duration(interval) * time.Second))
	if err = h.acpDeviceCAS(ctx, &a, map[string]any{"status": "pending", "encrypted_payload": envelope, "user_code": response.UserCode, "verification_uri": codexDeviceIssuer + "/codex/device", "interval_seconds": interval, "next_poll_at": next}); err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Device authentication start interrupted")
		return empty, err
	}
	a.UserCode, a.VerificationURI, a.IntervalSeconds = response.UserCode, codexDeviceIssuer+"/codex/device", interval
	return a.public(), nil
}

func (h *handler) validateACPDeviceTarget(ctx context.Context, a acpDeviceAttempt) (acpDeviceTarget, error) {
	if err := h.requireSpaceInfrastructureAvailable(ctx, a.TenantID, a.SpaceID); err != nil {
		return acpDeviceTarget{}, errors.New("Space infrastructure is not available for authentication")
	}
	if a.WorkspaceInstanceID != "" {
		ctx = context.WithValue(ctx, workspaceRequestTargetKey{}, Space{ID: a.SpaceID, TenantID: a.TenantID, CurrentWorkspaceInstanceID: &a.WorkspaceInstanceID, WorkspaceGeneration: a.WorkspaceGeneration})
	}
	target, err := h.codexDeviceTarget(ctx, a.TenantID, a.SpaceID, a.ProfileID)
	if err != nil {
		return target, errors.New("Codex authentication target is no longer available")
	}
	if target.exec.nodeID != a.NodeID || target.exec.computer.ID != a.ComputerID || target.hash != a.ConfigHash {
		return target, errors.New("Codex authentication target or profile changed")
	}
	return target, nil
}

func (h *handler) pollACPDeviceAttempt(ctx context.Context, principal, tenant, space, profile, id string) (acpDevicePublic, error) {
	a, err := h.acpDeviceLoad(ctx, principal, tenant, space, profile, id)
	if err != nil {
		return acpDevicePublic{}, err
	}
	if !acpDeviceActive(a.Status) {
		return a.public(), nil
	}
	now := h.store.now()
	expiry, err := time.Parse(time.RFC3339Nano, a.ExpiresAt)
	next, _ := time.Parse(time.RFC3339Nano, a.NextPollAt)
	if a.Status == "persisting" {
		if now.Before(next) {
			return a.public(), nil
		}
		_ = h.acpDeviceUnknown(context.WithoutCancel(ctx), &a)
		return a.public(), nil
	}
	if err != nil || !now.Before(expiry) {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "expired", "Device authentication expired")
		return a.public(), nil
	}
	target, err := h.validateACPDeviceTarget(ctx, a)
	if err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", err.Error())
		return a.public(), nil
	}
	if now.Before(next) {
		return a.public(), nil
	}
	if a.Status == "starting" {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Device authentication interrupted; start again")
		return a.public(), nil
	}
	if a.Status == "polling" {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Device polling was interrupted; start again")
		return a.public(), nil
	}
	if a.Status != "pending" {
		return a.public(), nil
	}
	if err = h.renewACPAuthLock(ctx, tenant, space, profile, id, expiry.Sub(h.store.now())); err != nil {
		return acpDevicePublic{}, errACPDeviceConflict
	}
	payload, err := computers.OpenCredentials(h.deps.Secret, tenant, space, "acp-device:"+id, a.EncryptedPayload)
	var secret acpDevicePayload
	if err != nil || json.Unmarshal(payload, &secret) != nil || secret.DeviceAuthID == "" || secret.UserCode == "" {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Stored device authentication is invalid")
		return a.public(), nil
	}
	if err = h.acpDeviceCAS(ctx, &a, map[string]any{"status": "polling", "next_poll_at": runtimeTimeString(now.Add(time.Minute))}); err != nil {
		return acpDevicePublic{}, err
	}
	body, _ := json.Marshal(map[string]any{"device_auth_id": secret.DeviceAuthID, "user_code": secret.UserCode})
	var response struct {
		AuthorizationCode string `json:"authorization_code"`
		CodeVerifier      string `json:"code_verifier"`
		CodeChallenge     string `json:"code_challenge"`
	}
	status, requestErr := h.codexDeviceHTTP(ctx, "/api/accounts/deviceauth/token", body, false, &response)
	if status == 403 || status == 404 {
		if err = h.acpDeviceCAS(ctx, &a, map[string]any{"status": "pending", "next_poll_at": runtimeTimeString(h.store.now().Add(time.Duration(a.IntervalSeconds) * time.Second))}); err != nil {
			return acpDevicePublic{}, err
		}
		return a.public(), nil
	}
	if requestErr != nil || status < 200 || status >= 300 || response.AuthorizationCode == "" || response.CodeVerifier == "" {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Codex device authorization failed")
		return a.public(), nil
	}
	// Recheck cancellation/version before redeeming the one-use authorization
	// code. A stale in-flight poll must not consume another attempt's grant.
	if err = h.acpDeviceCAS(ctx, &a, map[string]any{"status": "polling", "next_poll_at": runtimeTimeString(h.store.now().Add(time.Minute))}); err != nil {
		return acpDevicePublic{}, err
	}
	// PKCE material is server-only; token exchange is never returned to the UI.
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {codexDeviceClientID}, "code": {response.AuthorizationCode}, "code_verifier": {response.CodeVerifier}, "redirect_uri": {codexDeviceIssuer + "/deviceauth/callback"}}
	var tokens struct {
		IDToken      string `json:"id_token"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	status, requestErr = h.codexDeviceHTTP(ctx, "/oauth/token", []byte(form.Encode()), true, &tokens)
	if requestErr != nil || status < 200 || status >= 300 || tokens.IDToken == "" || tokens.AccessToken == "" || tokens.RefreshToken == "" {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Codex token exchange failed")
		return a.public(), nil
	}
	account, err := codexTokenAccount(tokens.IDToken)
	if err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Invalid Codex identity token")
		return a.public(), nil
	}
	target, err = h.validateACPDeviceTarget(ctx, a)
	if err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", err.Error())
		return a.public(), nil
	}
	if !h.store.now().Before(expiry) {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "expired", "Device authentication expired")
		return a.public(), nil
	}
	if err = h.requirePrivateAtomicFS(ctx, target.runner); err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Runtime node requires secure credential write support")
		return a.public(), nil
	}
	if expiry.Sub(h.store.now()) < 30*time.Second {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "expired", "Device authentication expired")
		return a.public(), nil
	}
	if err = h.renewACPAuthLock(ctx, tenant, space, profile, id, expiry.Sub(h.store.now())); err != nil {
		return acpDevicePublic{}, errACPDeviceConflict
	}
	// CAS fences a concurrently cancelled/replayed poll before any HOME write.
	// Cancellation rejects persisting rather than claiming a write was prevented.
	if err = h.acpDeviceCAS(ctx, &a, map[string]any{"status": "persisting", "next_poll_at": runtimeTimeString(h.store.now().Add(time.Minute))}); err != nil {
		return acpDevicePublic{}, err
	}
	auth, _ := json.Marshal(map[string]any{"auth_mode": "chatgpt", "OPENAI_API_KEY": nil, "tokens": map[string]any{"id_token": tokens.IDToken, "access_token": tokens.AccessToken, "refresh_token": tokens.RefreshToken, "account_id": account}, "last_refresh": h.store.now().UTC().Format(time.RFC3339)})
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	target, err = h.validateACPDeviceTarget(writeCtx, a)
	if err != nil {
		_ = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "failed", "Codex authentication target changed before save")
		return a.public(), nil
	}
	// The existing profile lease and persisting CAS fence cleanup as well as
	// saving. Remove only fingerprint-matching generated API-key configuration;
	// never replace an existing unowned OAuth login with this device attempt.
	if _, err = h.prepareACPFiles(writeCtx, target.runner, target.exec, profile, target.setup, ""); err == nil {
		err = h.requireEmptyACPDeviceAuth(writeCtx, target.runner, target.exec, profile)
	}
	if err != nil {
		_ = h.acpDeviceUnknown(context.WithoutCancel(ctx), &a)
		_ = h.acpDeviceCAS(context.WithoutCancel(ctx), &a, map[string]any{"error": "ACP profile HOME authentication/configuration conflict or cleanup could not be confirmed; existing credentials were preserved. Back up and manually move conflicting files aside before signing in again"})
		return a.public(), nil
	}
	// Secure-write preflight happened before entering persisting.
	var ack map[string]any
	err = h.executionRemote(target.runner, target.exec).call(writeCtx, "host.fs.write", map[string]any{"spaceId": space, "path": "/.zakura/acp/codex/home/.codex/auth.json", "base64": base64.StdEncoding.EncodeToString(auth), "mode": 384, "atomic": true}, &ack)
	if err != nil || gwInt(ack["mode"]) != 384 || ack["atomic"] != true {
		_ = h.acpDeviceUnknown(context.WithoutCancel(ctx), &a)
		return a.public(), nil
	}
	if err = h.acpDeviceFinish(context.WithoutCancel(ctx), &a, "succeeded", ""); err != nil {
		return acpDevicePublic{}, err
	}
	return a.public(), nil
}

func codexTokenAccount(token string) (any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return nil, errors.New("invalid identity token")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return nil, errors.New("invalid identity claims")
	}
	auth, _ := claims["https://api.openai.com/auth"].(map[string]any)
	account, _ := auth["chatgpt_account_id"].(string)
	if account == "" {
		return nil, nil
	}
	return account, nil
}

func (h *handler) cancelACPDeviceAttempt(ctx context.Context, principal, tenant, space, profile, id string) error {
	a, err := h.acpDeviceLoad(ctx, principal, tenant, space, profile, id)
	if err != nil {
		return err
	}
	if !acpDeviceActive(a.Status) {
		return nil
	}
	if a.Status == "persisting" {
		return errors.New("Codex credentials are being saved; cancellation is no longer available")
	}
	return h.acpDeviceFinish(ctx, &a, "cancelled", "")
}

func (h *handler) codexDeviceRequest(r *http.Request) (Space, string, string, error) {
	p := principal(r)
	// Browser-owned interactive attempts must not be shared by API-key pseudo-users.
	if p.APIKey || p.UserID == "" {
		return Space{}, "", "", ErrNotFound
	}
	space, _, err := h.requestACPSpace(r)
	if err != nil {
		return Space{}, "", "", err
	}
	return space, chi.URLParam(r, "profileId"), p.UserID, nil
}
func (h *handler) codexDeviceError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, 404, "Not found")
		return
	}
	// All messages originating from upstream are replaced before reaching here.
	if errors.Is(err, errACPDeviceConflict) {
		httpx.Error(w, 409, errACPDeviceConflict.Error())
		return
	}
	sanitized := errors.New("Codex device authentication operation failed")
	if errors.Is(err, errACPAuthBusy) || errors.Is(err, errACPAuthLockLost) {
		httpx.Error(w, 409, err.Error())
		return
	}
	httpx.Error(w, 400, sanitized.Error())
}
func (h *handler) codexDeviceStart(w http.ResponseWriter, r *http.Request) {
	space, profile, user, err := h.codexDeviceRequest(r)
	if err != nil {
		h.codexDeviceError(w, err)
		return
	}
	attempt, err := h.startACPDeviceAttempt(r.Context(), user, space.TenantID, space.ID, profile)
	if err != nil {
		h.codexDeviceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"device": attempt})
}
func (h *handler) codexDevicePoll(w http.ResponseWriter, r *http.Request) {
	space, profile, user, err := h.codexDeviceRequest(r)
	if err != nil {
		h.codexDeviceError(w, err)
		return
	}
	var body struct {
		AttemptID string `json:"attemptId"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.AttemptID == "" {
		httpx.Error(w, 400, "attemptId required")
		return
	}
	attempt, err := h.pollACPDeviceAttempt(r.Context(), user, space.TenantID, space.ID, profile, body.AttemptID)
	if err != nil {
		h.codexDeviceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"device": attempt})
}
func (h *handler) codexDeviceCancel(w http.ResponseWriter, r *http.Request) {
	space, profile, user, err := h.codexDeviceRequest(r)
	if err != nil {
		h.codexDeviceError(w, err)
		return
	}
	var body struct {
		AttemptID string `json:"attemptId"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.AttemptID == "" {
		httpx.Error(w, 400, "attemptId required")
		return
	}
	if err = h.cancelACPDeviceAttempt(r.Context(), user, space.TenantID, space.ID, profile, body.AttemptID); err != nil {
		h.codexDeviceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"cancelled": true})
}
