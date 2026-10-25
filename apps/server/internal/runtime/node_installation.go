package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/Moonrend/Zakura/apps/agent/bootstrap"
	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

var errInstallationWaiting = errors.New("complete administrator setup before enrolling the Compose node")
var errInstallationRevoked = errors.New("node installation has been revoked or its identity changed")

func (h *handler) registerNodeInstallation() error {
	directory := strings.TrimSpace(os.Getenv("ZAKURA_NODE_BOOTSTRAP_DIR"))
	if directory == "" {
		return nil
	}
	installation, err := bootstrap.Initialize(h.deps.RunContext(), directory)
	if err != nil {
		return err
	}
	h.nodeInstallation = &installation
	return nil
}

func (h *handler) enrollComposeNode(w http.ResponseWriter, r *http.Request) {
	installation := h.nodeInstallation
	if installation == nil {
		httpx.Error(w, http.StatusNotFound, "node bootstrap is disabled")
		return
	}
	token, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !bearer || len(token) > 256 || subtle.ConstantTimeCompare([]byte(token), []byte(installation.Secret)) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var request bootstrap.Request
	if httpx.DecodeJSON(r, &request) != nil || request.InstallationID != installation.ID || !protocol.ValidIdentity(request.NodeIncarnation) {
		httpx.Error(w, http.StatusBadRequest, "invalid node enrollment identity")
		return
	}
	credential, err := h.provisionComposeNode(r.Context(), *installation, request.NodeIncarnation)
	if errors.Is(err, errInstallationWaiting) {
		httpx.Error(w, http.StatusConflict, err.Error())
		return
	}
	if errors.Is(err, errInstallationRevoked) {
		httpx.Error(w, http.StatusForbidden, err.Error())
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "node enrollment failed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, credential)
}

// Compose credentials never enter the manual-install token cache or UI.
func (h *handler) cacheRuntimeNodeToken(ctx context.Context, nodeID, token string) (string, error) {
	var incarnation string
	var revoked bool
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT node_incarnation,revoked FROM node_installations WHERE node_id=?`), nodeID).Scan(&incarnation, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		runnerTokenCache.Store(nodeID, token)
		return "", nil
	}
	runnerTokenCache.Delete(nodeID)
	if err != nil {
		return "", err
	}
	if revoked {
		return "", errInstallationRevoked
	}
	return incarnation, nil
}

func installationToken(secret []byte, installation, node, incarnation, nonce string) string {
	h := hmac.New(sha256.New, secret)
	raw, _ := json.Marshal([]string{"compose-node-token-v1", installation, node, incarnation, nonce})
	_, _ = h.Write(raw)
	return "rnr_" + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func (h *handler) provisionComposeNode(ctx context.Context, installation bootstrap.Installation, incarnation string) (bootstrap.Credential, error) {
	tx, err := h.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return bootstrap.Credential{}, err
	}
	defer tx.Rollback()
	q := h.deps.Rebind
	// This row serializes setup completion and all enrollment retries. Ordinary
	// SaaS registration cannot select a tenant for this endpoint.
	result, err := tx.ExecContext(ctx, q(`UPDATE platform_meta SET setup_completed=setup_completed WHERE singleton=1 AND setup_completed=TRUE`))
	if err != nil {
		return bootstrap.Credential{}, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return bootstrap.Credential{}, err
	}
	if n != 1 {
		return bootstrap.Credential{}, errInstallationWaiting
	}
	var tenant string
	if err := tx.QueryRowContext(ctx, q(`SELECT t.id FROM tenants t WHERE t.is_default=TRUE AND t.status='active' AND EXISTS(SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=t.id AND m.role='owner' AND m.status='active' AND u.is_platform_admin=TRUE AND u.status='active') ORDER BY t.created_at LIMIT 1`)).Scan(&tenant); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return bootstrap.Credential{}, errInstallationWaiting
		}
		return bootstrap.Credential{}, err
	}
	var storedTenant, node, storedIncarnation, hash, nonce string
	var revoked bool
	err = tx.QueryRowContext(ctx, q(`SELECT tenant_id,node_id,node_incarnation,bootstrap_hash,credential_nonce,revoked FROM node_installations WHERE id=?`), installation.ID).Scan(&storedTenant, &node, &storedIncarnation, &hash, &nonce, &revoked)
	secretHash := sha256.Sum256([]byte(installation.Secret))
	wantHash := hex.EncodeToString(secretHash[:])
	if err == nil {
		if revoked || storedTenant != tenant || storedIncarnation != incarnation || subtle.ConstantTimeCompare([]byte(hash), []byte(wantHash)) != 1 {
			return bootstrap.Credential{}, errInstallationRevoked
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		node, nonce = h.store.id(), rand.Text()
		stamp := runtimeTimeString(h.store.now())
		token := installationToken(h.deps.Secret, installation.ID, node, incarnation, nonce)
		digest := sha256.Sum256([]byte(token))
		if _, err := tx.ExecContext(ctx, q(`INSERT INTO runtime_nodes(id,tenant_id,name,slug,kind,status,storage_root,token_hash,incarnation,created_at,updated_at) VALUES(?,?,? ,?,'server','offline','/workspace-data',?,?,?,?)`), node, tenant, "Compose node", "compose-"+installation.ID, hex.EncodeToString(digest[:]), incarnation, stamp, stamp); err != nil {
			return bootstrap.Credential{}, err
		}
		if _, err := tx.ExecContext(ctx, q(`INSERT INTO node_installations(id,tenant_id,node_id,node_incarnation,bootstrap_hash,credential_nonce,created_at) VALUES(?,?,?,?,?,?,?)`), installation.ID, tenant, node, incarnation, wantHash, nonce, stamp); err != nil {
			return bootstrap.Credential{}, err
		}
	} else {
		return bootstrap.Credential{}, err
	}
	token := installationToken(h.deps.Secret, installation.ID, node, incarnation, nonce)
	digest := sha256.Sum256([]byte(token))
	var currentHash string
	if err := tx.QueryRowContext(ctx, q(`SELECT token_hash FROM runtime_nodes WHERE id=? AND tenant_id=? AND incarnation=? AND kind='server' AND is_shared=FALSE`), node, tenant, incarnation).Scan(&currentHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return bootstrap.Credential{}, errInstallationRevoked
		}
		return bootstrap.Credential{}, err
	}
	if subtle.ConstantTimeCompare([]byte(currentHash), []byte(hex.EncodeToString(digest[:]))) != 1 {
		return bootstrap.Credential{}, errInstallationRevoked
	}
	if err := tx.Commit(); err != nil {
		return bootstrap.Credential{}, err
	}
	return bootstrap.Credential{InstallationID: installation.ID, NodeID: node, NodeIncarnation: incarnation, Token: token}, nil
}
