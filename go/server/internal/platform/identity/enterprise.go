package identity

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/Moonrend/Zakura/go/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/go/server/internal/platform/httpx"
	"golang.org/x/crypto/scrypt"
)

func registerEnterpriseRoutes(r chi.Router, d *appdeps.Dependencies, s *Service) {
	r.Group(func(g chi.Router) {
		g.Use(httpx.Auth(d))
		g.Get("/api/tenant/identity/mfa", s.getMFAPolicy)
		g.Put("/api/tenant/identity/mfa", s.putMFAPolicy)
		g.Get("/api/tenant/identity/domains", s.listDomains)
		g.Post("/api/tenant/identity/domains", s.addDomain)
		g.Patch("/api/tenant/identity/domains/{id}", s.patchDomain)
		g.Post("/api/tenant/identity/domains/{id}/verify", s.verifyDomain)
		g.Delete("/api/tenant/identity/domains/{id}", s.deleteDomain)
		g.Get("/api/tenant/identity/sso", s.getSSO)
		g.Put("/api/tenant/identity/sso", s.putSSO)
		g.Get("/api/tenant/identity/scim", s.getSCIM)
		g.Post("/api/tenant/identity/scim/tokens", s.createSCIMToken)
		g.Patch("/api/tenant/identity/scim/tokens/{id}", s.patchSCIMToken)
		g.Delete("/api/tenant/identity/scim/tokens/{id}", s.deleteSCIMToken)
		g.Get("/api/tenant/audit", s.listAudit)
		g.Put("/api/tenant/audit/retention", s.putAuditRetention)
	})
	r.Route("/scim/v2", func(sc chi.Router) {
		sc.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(scimResponseWriter{ResponseWriter: w}, r)
			})
		})
		sc.Get("/ServiceProviderConfig", s.scimConfig)
		sc.Group(func(protected chi.Router) {
			protected.Use(s.scimAuth)
			protected.Get("/Users", s.scimUsers)
			protected.Post("/Users", s.scimCreateUser)
			protected.Get("/Users/{id}", s.scimUser)
			protected.Put("/Users/{id}", s.scimPutUser)
			protected.Patch("/Users/{id}", s.scimPatchUser)
			protected.Delete("/Users/{id}", s.scimDeleteUser)
			protected.Get("/Groups", s.scimGroups)
			protected.Patch("/Groups/{id}", s.scimPatchGroup)
		})
	})
}

type scimResponseWriter struct{ http.ResponseWriter }

func (w scimResponseWriter) WriteHeader(status int) {
	w.Header().Set("Content-Type", "application/scim+json")
	w.ResponseWriter.WriteHeader(status)
}
func (w scimResponseWriter) Write(body []byte) (int, error) {
	w.Header().Set("Content-Type", "application/scim+json")
	return w.ResponseWriter.Write(body)
}
func adminPrincipal(r *http.Request) (httpx.Principal, bool) {
	p, ok := httpx.PrincipalFrom(r.Context())
	return p, ok && (p.Role == "owner" || p.Role == "admin" || p.IsPlatformAdmin)
}
func (s *Service) getMFAPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var policy string
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT mfa_policy FROM tenants WHERE id=?`), p.TenantID).Scan(&policy)
	httpx.JSON(w, 200, map[string]any{"policy": policy})
}
func (s *Service) putMFAPolicy(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		Policy string `json:"policy"`
	}
	if httpx.DecodeJSON(r, &b) != nil || (b.Policy != "optional" && b.Policy != "admins" && b.Policy != "all") {
		httpx.Error(w, 400, "policy must be optional, admins, or all")
		return
	}
	_, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenants SET mfa_policy=?,updated_at=? WHERE id=?`), b.Policy, s.now(), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "mfa.policy", p.UserID, "tenant", p.TenantID, map[string]any{"policy": b.Policy})
	httpx.JSON(w, 200, map[string]any{"policy": b.Policy})
}
func (s *Service) listDomains(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,domain,join_mode,verification_token,verified_at,created_at,updated_at FROM tenant_domains WHERE tenant_id=? ORDER BY domain`), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, domain, mode, token, created, updated string
		var verified sql.NullString
		_ = rows.Scan(&id, &domain, &mode, &token, &verified, &created, &updated)
		items = append(items, tenantDomainDTO(id, domain, mode, token, verified, created, updated))
	}
	httpx.JSON(w, 200, map[string]any{"domains": items})
}
func (s *Service) addDomain(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		Domain   string `json:"domain"`
		JoinMode string `json:"joinMode"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	domain := normalizeTenantDomain(b.Domain)
	if !validTenantDomain(domain) {
		httpx.Error(w, 400, "invalid domain")
		return
	}
	if b.JoinMode == "" {
		b.JoinMode = "invite_only"
	}
	if b.JoinMode != "invite_only" && b.JoinMode != "auto_join" && b.JoinMode != "sso_required" {
		httpx.Error(w, 400, "invalid joinMode")
		return
	}
	token, _ := randomToken(18)
	id := s.deps.NewID()
	var existingID, existingTenant, existingMode, existingToken, existingCreated, existingUpdated string
	var existingVerified sql.NullString
	if err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT id,tenant_id,join_mode,verification_token,verified_at,created_at,updated_at FROM tenant_domains WHERE domain=?`), domain).Scan(&existingID, &existingTenant, &existingMode, &existingToken, &existingVerified, &existingCreated, &existingUpdated); err == nil {
		if existingTenant != p.TenantID {
			httpx.Error(w, 400, "domain is already claimed by another team")
			return
		}
		httpx.JSON(w, 201, map[string]any{"domain": tenantDomainDTO(existingID, domain, existingMode, existingToken, existingVerified, existingCreated, existingUpdated)})
		return
	}
	_, err := s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO tenant_domains(id,tenant_id,domain,join_mode,verification_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`), id, p.TenantID, domain, b.JoinMode, token, s.now(), s.now())
	if err != nil {
		httpx.Error(w, 400, "domain already configured")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "domain.add", p.UserID, "domain", id, map[string]any{"domain": domain})
	httpx.JSON(w, 201, map[string]any{"domain": tenantDomainDTO(id, domain, b.JoinMode, token, sql.NullString{}, s.now(), s.now())})
}
func (s *Service) patchDomain(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		JoinMode string `json:"joinMode"`
	}
	if httpx.DecodeJSON(r, &b) != nil || (b.JoinMode != "invite_only" && b.JoinMode != "auto_join" && b.JoinMode != "sso_required") {
		httpx.Error(w, 400, "invalid joinMode")
		return
	}
	var verified sql.NullString
	if err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT verified_at FROM tenant_domains WHERE id=? AND tenant_id=?`), chi.URLParam(r, "id"), p.TenantID).Scan(&verified); err != nil {
		httpx.Error(w, 400, "domain not found")
		return
	}
	if b.JoinMode != "invite_only" && !verified.Valid {
		httpx.Error(w, 400, "verify the domain before enabling this join mode")
		return
	}
	if b.JoinMode == "sso_required" {
		var protocol, clientID, issuer, authorizeURL, idpEntityID, idpSSOURL, idpCert string
		var enabled bool
		err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT protocol,enabled,COALESCE(client_id,''),COALESCE(issuer,''),COALESCE(authorize_url,''),COALESCE(idp_entity_id,''),COALESCE(idp_sso_url,''),COALESCE(idp_certificate_enc,'') FROM tenant_sso_configs WHERE tenant_id=?`), p.TenantID).Scan(&protocol, &enabled, &clientID, &issuer, &authorizeURL, &idpEntityID, &idpSSOURL, &idpCert)
		complete := err == nil && enabled && (protocol == "saml" && idpEntityID != "" && idpSSOURL != "" && idpCert != "" || protocol == "oidc" && clientID != "" && (issuer != "" || authorizeURL != ""))
		if !complete {
			httpx.Error(w, 400, "configure and enable SSO before requiring it")
			return
		}
	}
	res, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenant_domains SET join_mode=?,updated_at=? WHERE id=? AND tenant_id=?`), b.JoinMode, s.now(), chi.URLParam(r, "id"), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		httpx.Error(w, 404, "not found")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "domain.policy", p.UserID, "domain", chi.URLParam(r, "id"), map[string]any{"joinMode": b.JoinMode})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (s *Service) verifyDomain(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var domain, token string
	id := chi.URLParam(r, "id")
	if s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT domain,verification_token FROM tenant_domains WHERE id=? AND tenant_id=?`), id, p.TenantID).Scan(&domain, &token) != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if s.deps.VerifyDomain == nil {
		httpx.Error(w, 503, "DNS verification is not configured")
		return
	}
	if err := s.deps.VerifyDomain(r.Context(), domain, token); err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenant_domains SET verified_at=?,updated_at=? WHERE id=? AND tenant_id=?`), s.now(), s.now(), id, p.TenantID); err != nil {
		httpx.Error(w, 500, "verification update failed")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "domain.verify", p.UserID, "domain", id, nil)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (s *Service) deleteDomain(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(), s.q(`DELETE FROM tenant_domains WHERE id=? AND tenant_id=?`), chi.URLParam(r, "id"), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "delete failed")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		httpx.Error(w, 404, "not found")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "domain.remove", p.UserID, "domain", chi.URLParam(r, "id"), nil)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func normalizeTenantDomain(value string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(value), "."))
}
func validTenantDomain(value string) bool {
	if len(value) == 0 || len(value) > 253 || strings.Contains(value, "..") {
		return false
	}
	labels := strings.Split(value, ".")
	if len(labels) < 2 {
		return false
	}
	nonNumeric := false
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || !regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`).MatchString(label) {
			return false
		}
		if _, err := strconv.Atoi(label); err != nil {
			nonNumeric = true
		}
	}
	return nonNumeric
}
func tenantDomainDTO(id, domain, mode, token string, verified sql.NullString, created, updated string) map[string]any {
	return map[string]any{"id": id, "domain": domain, "joinMode": mode, "verified": verified.Valid, "verifiedAt": nullString(verified), "txtHost": "_zakura-verify." + domain, "txtToken": token, "createdAt": created, "updatedAt": updated}
}

func (s *Service) getSSO(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	stored, err := s.loadTenantSSO(r.Context(), p.TenantID)
	if errors.Is(err, sql.ErrNoRows) {
		stored = tenantSSOStored{Protocol: "oidc", Scopes: "openid email profile", JITEnabled: true, DefaultRole: "member"}
	} else if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"sso": s.publicTenantSSO(r.Context(), p.TenantID, stored)})
}
func (s *Service) putSSO(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var body struct {
		Enabled        *bool   `json:"enabled"`
		Protocol       *string `json:"protocol"`
		Issuer         *string `json:"issuer"`
		ClientID       *string `json:"clientId"`
		ClientSecret   *string `json:"clientSecret"`
		AuthorizeURL   *string `json:"authorizeUrl"`
		TokenURL       *string `json:"tokenUrl"`
		JWKSURL        *string `json:"jwksUrl"`
		UserinfoURL    *string `json:"userinfoUrl"`
		Scopes         *string `json:"scopes"`
		IDPEntityID    *string `json:"idpEntityId"`
		IDPSSOURL      *string `json:"idpSsoUrl"`
		IDPCertificate *string `json:"idpCertificate"`
		JITEnabled     *bool   `json:"jitEnabled"`
		EnforceSSO     *bool   `json:"enforceSso"`
		DefaultRole    *string `json:"defaultRole"`
	}
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	current, err := s.loadTenantSSO(r.Context(), p.TenantID)
	if errors.Is(err, sql.ErrNoRows) {
		current = tenantSSOStored{Protocol: "oidc", Scopes: "openid email profile", JITEnabled: true, DefaultRole: "member"}
	} else if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	setString := func(target *string, value *string) {
		if value != nil {
			*target = strings.TrimSpace(*value)
		}
	}
	if body.Enabled != nil {
		current.Enabled = *body.Enabled
	}
	setString(&current.Protocol, body.Protocol)
	setString(&current.Issuer, body.Issuer)
	setString(&current.ClientID, body.ClientID)
	setString(&current.AuthorizeURL, body.AuthorizeURL)
	setString(&current.TokenURL, body.TokenURL)
	setString(&current.JWKSURL, body.JWKSURL)
	setString(&current.UserinfoURL, body.UserinfoURL)
	setString(&current.Scopes, body.Scopes)
	setString(&current.IDPEntityID, body.IDPEntityID)
	setString(&current.IDPSSOURL, body.IDPSSOURL)
	setString(&current.DefaultRole, body.DefaultRole)
	if body.JITEnabled != nil {
		current.JITEnabled = *body.JITEnabled
	}
	if body.EnforceSSO != nil {
		current.EnforceSSO = *body.EnforceSSO
	}
	if current.Protocol != "oidc" && current.Protocol != "saml" {
		httpx.Error(w, 400, "protocol must be oidc or saml")
		return
	}
	if current.DefaultRole != "member" && current.DefaultRole != "admin" {
		httpx.Error(w, 400, "defaultRole must be member or admin")
		return
	}
	if current.Scopes == "" {
		current.Scopes = "openid email profile"
	}
	if body.ClientSecret != nil {
		current.ClientSecretEnc = ""
		if *body.ClientSecret != "" {
			enc, e := seal(s.deps.Secret, []byte(*body.ClientSecret))
			if e != nil {
				httpx.Error(w, 500, "secret encryption failed")
				return
			}
			current.ClientSecretEnc = enc
		}
	}
	if body.IDPCertificate != nil {
		current.IDPCertificateEnc = ""
		if *body.IDPCertificate != "" {
			enc, e := seal(s.deps.Secret, []byte(*body.IDPCertificate))
			if e != nil {
				httpx.Error(w, 500, "certificate encryption failed")
				return
			}
			current.IDPCertificateEnc = enc
		}
	}
	id := s.deps.NewID()
	publicRaw, _ := json.Marshal(current.publicFields())
	_, err = s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO tenant_sso_configs(id,tenant_id,protocol,enabled,issuer,client_id,client_secret_enc,authorize_url,token_url,jwks_url,userinfo_url,scopes,idp_entity_id,idp_sso_url,idp_certificate_enc,jit_enabled,enforce_sso,default_role,config_json,secret_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',?,?) ON CONFLICT(tenant_id) DO UPDATE SET protocol=excluded.protocol,enabled=excluded.enabled,issuer=excluded.issuer,client_id=excluded.client_id,client_secret_enc=excluded.client_secret_enc,authorize_url=excluded.authorize_url,token_url=excluded.token_url,jwks_url=excluded.jwks_url,userinfo_url=excluded.userinfo_url,scopes=excluded.scopes,idp_entity_id=excluded.idp_entity_id,idp_sso_url=excluded.idp_sso_url,idp_certificate_enc=excluded.idp_certificate_enc,jit_enabled=excluded.jit_enabled,enforce_sso=excluded.enforce_sso,default_role=excluded.default_role,config_json=excluded.config_json,updated_at=excluded.updated_at`), id, p.TenantID, current.Protocol, current.Enabled, nullIfBlank(current.Issuer), nullIfBlank(current.ClientID), nullIfBlank(current.ClientSecretEnc), nullIfBlank(current.AuthorizeURL), nullIfBlank(current.TokenURL), nullIfBlank(current.JWKSURL), nullIfBlank(current.UserinfoURL), current.Scopes, nullIfBlank(current.IDPEntityID), nullIfBlank(current.IDPSSOURL), nullIfBlank(current.IDPCertificateEnc), current.JITEnabled, current.EnforceSSO, current.DefaultRole, string(publicRaw), s.now(), s.now())
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	stored, _ := s.loadTenantSSO(r.Context(), p.TenantID)
	_ = s.Audit(r.Context(), p.TenantID, "sso.config", p.UserID, "sso", stored.ID, map[string]any{"protocol": stored.Protocol, "enabled": stored.Enabled})
	httpx.JSON(w, 200, map[string]any{"sso": s.publicTenantSSO(r.Context(), p.TenantID, stored)})
}

type tenantSSOStored struct {
	ID, Protocol, Issuer, ClientID, ClientSecretEnc, AuthorizeURL, TokenURL, JWKSURL, UserinfoURL, Scopes, IDPEntityID, IDPSSOURL, IDPCertificateEnc, DefaultRole string
	Enabled, JITEnabled, EnforceSSO                                                                                                                               bool
}

func (s *Service) loadTenantSSO(ctx context.Context, tenantID string) (tenantSSOStored, error) {
	var value tenantSSOStored
	err := s.deps.DB.QueryRowContext(ctx, s.q(`SELECT id,protocol,enabled,COALESCE(issuer,''),COALESCE(client_id,''),COALESCE(client_secret_enc,''),COALESCE(authorize_url,''),COALESCE(token_url,''),COALESCE(jwks_url,''),COALESCE(userinfo_url,''),COALESCE(scopes,'openid email profile'),COALESCE(idp_entity_id,''),COALESCE(idp_sso_url,''),COALESCE(idp_certificate_enc,''),jit_enabled,enforce_sso,default_role FROM tenant_sso_configs WHERE tenant_id=?`), tenantID).Scan(&value.ID, &value.Protocol, &value.Enabled, &value.Issuer, &value.ClientID, &value.ClientSecretEnc, &value.AuthorizeURL, &value.TokenURL, &value.JWKSURL, &value.UserinfoURL, &value.Scopes, &value.IDPEntityID, &value.IDPSSOURL, &value.IDPCertificateEnc, &value.JITEnabled, &value.EnforceSSO, &value.DefaultRole)
	return value, err
}

func (value tenantSSOStored) publicFields() map[string]any {
	return map[string]any{"enabled": value.Enabled, "protocol": value.Protocol, "issuer": value.Issuer, "clientId": value.ClientID, "authorizeUrl": value.AuthorizeURL, "tokenUrl": value.TokenURL, "jwksUrl": value.JWKSURL, "userinfoUrl": value.UserinfoURL, "scopes": value.Scopes, "idpEntityId": value.IDPEntityID, "idpSsoUrl": value.IDPSSOURL, "jitEnabled": value.JITEnabled, "enforceSso": value.EnforceSSO, "defaultRole": value.DefaultRole}
}

func (s *Service) publicTenantSSO(ctx context.Context, tenantID string, value tenantSSOStored) map[string]any {
	if value.Protocol != "saml" {
		value.Protocol = "oidc"
	}
	if value.Scopes == "" {
		value.Scopes = "openid email profile"
	}
	if value.DefaultRole != "admin" {
		value.DefaultRole = "member"
	}
	var slug string
	_ = s.deps.DB.QueryRowContext(ctx, s.q(`SELECT slug FROM tenants WHERE id=?`), tenantID).Scan(&slug)
	result := value.publicFields()
	result["hasClientSecret"] = value.ClientSecretEnc != ""
	result["hasIdpCertificate"] = value.IDPCertificateEnc != ""
	result["redirectUri"] = strings.TrimRight(s.deps.WebURL, "/") + "/console/sso/oidc/callback"
	result["acsUrl"] = strings.TrimRight(s.deps.PublicURL, "/") + "/api/auth/sso/saml/" + url.PathEscape(slug) + "/acs"
	result["spEntityId"] = strings.TrimRight(s.deps.WebURL, "/") + "/sso/saml/" + url.PathEscape(slug)
	result["metadataUrl"] = strings.TrimRight(s.deps.PublicURL, "/") + "/api/auth/sso/saml/" + url.PathEscape(slug) + "/metadata"
	return result
}

func nullIfBlank(v string) any {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}

func (s *Service) getSCIM(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,name,token_prefix,group_role_map,last_used_at,revoked_at,created_at FROM tenant_scim_tokens WHERE tenant_id=? AND revoked_at IS NULL ORDER BY created_at DESC`), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, name, prefix, mapRaw, created string
		var last, revoked sql.NullString
		_ = rows.Scan(&id, &name, &prefix, &mapRaw, &last, &revoked, &created)
		items = append(items, map[string]any{"id": id, "name": name, "tokenPrefix": prefix, "groupRoleMap": decodeObject(mapRaw), "lastUsedAt": nullString(last), "revokedAt": nullString(revoked), "createdAt": created})
	}
	httpx.JSON(w, 200, map[string]any{"tokens": items, "endpoint": s.deps.PublicURL + "/scim/v2"})
}
func (s *Service) createSCIMToken(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		Name         string            `json:"name"`
		GroupRoleMap map[string]string `json:"groupRoleMap"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" {
		b.Name = "SCIM"
	}
	b.GroupRoleMap = normalizeSCIMGroupRoleInput(b.GroupRoleMap)
	if len(b.GroupRoleMap) == 0 {
		b.GroupRoleMap = map[string]string{"Admins": "admin"}
	}
	secret, _ := randomToken(32)
	raw := "scim_" + secret
	h := sha256.Sum256([]byte(raw))
	prefix := raw[:12]
	id := s.deps.NewID()
	_, err := s.deps.DB.ExecContext(r.Context(), s.q(`INSERT INTO tenant_scim_tokens(id,tenant_id,name,token_hash,token_prefix,group_role_map,created_at) VALUES(?,?,?,?,?,?,?)`), id, p.TenantID, b.Name, hex.EncodeToString(h[:]), prefix, encodeJSON(b.GroupRoleMap), s.now())
	if err != nil {
		httpx.Error(w, 500, "create failed")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "scim.token_create", p.UserID, "scim_token", id, nil)
	httpx.JSON(w, 201, map[string]any{"id": id, "name": b.Name, "tokenPrefix": prefix, "token": raw})
}
func (s *Service) patchSCIMToken(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		GroupRoleMap map[string]string `json:"groupRoleMap"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	b.GroupRoleMap = normalizeSCIMGroupRoleInput(b.GroupRoleMap)
	res, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenant_scim_tokens SET group_role_map=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL`), encodeJSON(b.GroupRoleMap), chi.URLParam(r, "id"), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		httpx.Error(w, 404, "SCIM token not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (s *Service) deleteSCIMToken(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenant_scim_tokens SET revoked_at=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL`), s.now(), chi.URLParam(r, "id"), p.TenantID)
	if err != nil {
		httpx.Error(w, 500, "revoke failed")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		httpx.Error(w, 404, "SCIM token not found")
		return
	}
	_ = s.Audit(r.Context(), p.TenantID, "scim.token_revoke", p.UserID, "scim_token", chi.URLParam(r, "id"), nil)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

type scimCtxKey struct{}
type scimTokenContext struct {
	ID, TenantID, GroupRoleMap string
}

func (s *Service) scimAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Fields(r.Header.Get("Authorization"))
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			scimError(w, 401, "invalidToken", "Bearer token required")
			return
		}
		h := sha256.Sum256([]byte(parts[1]))
		var token scimTokenContext
		err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT st.id,st.tenant_id,st.group_role_map FROM tenant_scim_tokens st JOIN tenants t ON t.id=st.tenant_id WHERE st.token_hash=? AND st.revoked_at IS NULL AND t.status='active'`), hex.EncodeToString(h[:])).Scan(&token.ID, &token.TenantID, &token.GroupRoleMap)
		if err != nil {
			scimError(w, 401, "invalidToken", "Invalid token")
			return
		}
		_, _ = s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenant_scim_tokens SET last_used_at=? WHERE token_hash=?`), s.now(), hex.EncodeToString(h[:]))
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), scimCtxKey{}, token)))
	})
}
func tenantFromSCIM(r *http.Request) string {
	v, _ := r.Context().Value(scimCtxKey{}).(scimTokenContext)
	return v.TenantID
}
func tokenFromSCIM(r *http.Request) scimTokenContext {
	v, _ := r.Context().Value(scimCtxKey{}).(scimTokenContext)
	return v
}
func scimError(w http.ResponseWriter, status int, typ, detail string) {
	httpx.JSON(w, status, map[string]any{"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:Error"}, "status": strconv.Itoa(status), "scimType": typ, "detail": detail})
}
func (s *Service) scimConfig(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, map[string]any{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"}, "patch": map[string]bool{"supported": true}, "filter": map[string]any{"supported": true, "maxResults": 200}, "authenticationSchemes": []map[string]string{{"type": "oauthbearertoken", "name": "OAuth Bearer Token", "specUri": "https://www.rfc-editor.org/rfc/rfc6750.html"}}})
}
func (s *Service) scimUsers(w http.ResponseWriter, r *http.Request) {
	tid := tenantFromSCIM(r)
	startIndex := boundedInt(r.URL.Query().Get("startIndex"), 1, 1, 1_000_000)
	count := boundedInt(r.URL.Query().Get("count"), 100, 1, 200)
	email := parseSCIMEmailFilter(r.URL.Query().Get("filter"))
	var total int
	if err := s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM scim_user_mappings sm JOIN users u ON u.id=sm.user_id WHERE sm.tenant_id=? AND (?='' OR LOWER(u.email)=?)`), tid, email, email).Scan(&total); err != nil {
		scimError(w, 500, "", "query failed")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT sm.id,sm.external_id,u.email,COALESCE(u.name,''),u.status,COALESCE(m.status,'suspended') FROM scim_user_mappings sm JOIN users u ON u.id=sm.user_id LEFT JOIN tenant_memberships m ON m.tenant_id=sm.tenant_id AND m.user_id=u.id WHERE sm.tenant_id=? AND (?='' OR LOWER(u.email)=?) ORDER BY sm.created_at,sm.id LIMIT ? OFFSET ?`), tid, email, email, count, startIndex-1)
	if err != nil {
		scimError(w, 500, "", "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, externalID, email, name, userStatus, membershipStatus string
		_ = rows.Scan(&id, &externalID, &email, &name, &userStatus, &membershipStatus)
		items = append(items, scimUserObject(id, externalID, email, name, userStatus == "active" && membershipStatus == "active"))
	}
	httpx.JSON(w, 200, map[string]any{"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"}, "totalResults": total, "startIndex": startIndex, "itemsPerPage": len(items), "Resources": items})
}
func (s *Service) scimUser(w http.ResponseWriter, r *http.Request) {
	mapped, err := s.loadSCIMMappedUser(r.Context(), s.deps.DB, tenantFromSCIM(r), chi.URLParam(r, "id"))
	if err != nil {
		scimError(w, 404, "", "User not found")
		return
	}
	httpx.JSON(w, 200, scimUserObject(mapped.MappingID, mapped.ExternalID, mapped.Email, mapped.Name, mapped.Active()))
}
func (s *Service) scimCreateUser(w http.ResponseWriter, r *http.Request) {
	tid := tenantFromSCIM(r)
	var body map[string]any
	if httpx.DecodeJSON(r, &body) != nil {
		scimError(w, 400, "invalidSyntax", "invalid request")
		return
	}
	payload, err := readSCIMUserPayload(body)
	if err != nil {
		scimError(w, 400, "invalidValue", "valid userName required")
		return
	}
	mappingID, userID := s.deps.NewID(), ""
	wasRevoked := false
	err = appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		var exists int
		if e := tx.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM scim_user_mappings WHERE tenant_id=? AND external_id=?`), tid, payload.ExternalID).Scan(&exists); e != nil || exists > 0 {
			return errors.New("User already exists")
		}
		e := tx.QueryRowContext(r.Context(), s.q(`SELECT id FROM users WHERE email=?`), payload.Email).Scan(&userID)
		if errors.Is(e, sql.ErrNoRows) {
			userID = s.deps.NewID()
			if _, e = tx.ExecContext(r.Context(), s.q(`INSERT INTO users(id,email,password_hash,name,status,email_verified_at,created_at,updated_at) VALUES(?,?,NULL,?,'active',?,?,?)`), userID, payload.Email, payload.Name, s.now(), s.now(), s.now()); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		if e = tx.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM scim_user_mappings WHERE tenant_id=? AND user_id=?`), tid, userID).Scan(&exists); e != nil || exists > 0 {
			return errors.New("User already provisioned with another externalId")
		}
		var membershipID, role, status string
		e = tx.QueryRowContext(r.Context(), s.q(`SELECT id,role,status FROM tenant_memberships WHERE tenant_id=? AND user_id=?`), tid, userID).Scan(&membershipID, &role, &status)
		if e == nil {
			if role == "owner" && !payload.Active {
				return errSCIMOwner
			}
			wasRevoked = status == "active" && !payload.Active
			_, e = tx.ExecContext(r.Context(), s.q(`UPDATE tenant_memberships SET status=?,updated_at=? WHERE id=? AND tenant_id=?`), scimMembershipStatus(payload.Active), s.now(), membershipID, tid)
		} else if errors.Is(e, sql.ErrNoRows) {
			_, e = tx.ExecContext(r.Context(), s.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'member',?,?,?)`), s.deps.NewID(), tid, userID, scimMembershipStatus(payload.Active), s.now(), s.now())
		}
		if e != nil {
			return e
		}
		_, e = tx.ExecContext(r.Context(), s.q(`INSERT INTO scim_user_mappings(id,tenant_id,user_id,external_id,created_at) VALUES(?,?,?,?,?)`), mappingID, tid, userID, payload.ExternalID, s.now())
		return e
	})
	if err != nil {
		if errors.Is(err, errSCIMOwner) {
			scimError(w, 409, "mutability", err.Error())
		} else {
			scimError(w, 409, "uniqueness", err.Error())
		}
		return
	}
	if wasRevoked {
		if err = s.notifySCIMRevoked(r.Context(), tid, userID); err != nil {
			scimError(w, 500, "", "runtime member cleanup failed")
			return
		}
	}
	_ = s.auditSCIM(r.Context(), tokenFromSCIM(r), "scim.user_create", "user", mappingID, map[string]any{"userName": payload.Email})
	created, loadErr := s.loadSCIMMappedUser(r.Context(), s.deps.DB, tid, mappingID)
	if loadErr != nil {
		scimError(w, 500, "", "created user unavailable")
		return
	}
	w.Header().Set("Location", s.deps.PublicURL+"/scim/v2/Users/"+mappingID)
	httpx.JSON(w, 201, scimUserObject(mappingID, created.ExternalID, created.Email, created.Name, created.Active()))
}
func (s *Service) scimPutUser(w http.ResponseWriter, r *http.Request) { s.scimUpdateUser(w, r, true) }
func (s *Service) scimPatchUser(w http.ResponseWriter, r *http.Request) {
	s.scimUpdateUser(w, r, false)
}
func (s *Service) scimUpdateUser(w http.ResponseWriter, r *http.Request, replace bool) {
	tid, id := tenantFromSCIM(r), chi.URLParam(r, "id")
	var body map[string]any
	if httpx.DecodeJSON(r, &body) != nil {
		scimError(w, 400, "invalidSyntax", "invalid request")
		return
	}
	var requested *scimUserPayload
	if replace {
		payload, e := readSCIMUserPayload(body)
		if e != nil {
			scimError(w, 400, "invalidValue", e.Error())
			return
		}
		requested = &payload
	}
	var result map[string]any
	revokedUserID := ""
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		mapped, e := s.loadSCIMMappedUser(r.Context(), tx, tid, id)
		if e != nil {
			return sql.ErrNoRows
		}
		next := scimUserPayload{Email: mapped.Email, Name: mapped.Name, Active: mapped.Active(), ExternalID: mapped.ExternalID}
		if requested != nil {
			next = *requested
		} else {
			if e = applySCIMUserOperations(&next, body); e != nil {
				return e
			}
		}
		if !validEmail(next.Email) {
			return errSCIMInvalid
		}
		if mapped.Role == "owner" && !next.Active {
			return errSCIMOwner
		}
		if (next.Email != mapped.Email || next.Name != mapped.Name) && s.scimHasOtherMembership(r.Context(), tx, tid, mapped.UserID) {
			return errSCIMSharedProfile
		}
		if _, e = tx.ExecContext(r.Context(), s.q(`UPDATE users SET email=?,name=?,updated_at=? WHERE id=?`), next.Email, next.Name, s.now(), mapped.UserID); e != nil {
			return e
		}
		if _, e = tx.ExecContext(r.Context(), s.q(`UPDATE tenant_memberships SET status=?,updated_at=? WHERE tenant_id=? AND user_id=?`), scimMembershipStatus(next.Active), s.now(), tid, mapped.UserID); e != nil {
			return e
		}
		if next.ExternalID != mapped.ExternalID {
			if _, e = tx.ExecContext(r.Context(), s.q(`UPDATE scim_user_mappings SET external_id=? WHERE id=? AND tenant_id=?`), next.ExternalID, id, tid); e != nil {
				return e
			}
		}
		if mapped.Active() && !next.Active {
			revokedUserID = mapped.UserID
			_, _ = tx.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`), s.now(), tid, mapped.UserID)
		}
		result = scimUserObject(id, next.ExternalID, next.Email, next.Name, next.Active)
		return nil
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			scimError(w, 404, "", "User not found")
		case errors.Is(err, errSCIMOwner), errors.Is(err, errSCIMSharedProfile):
			scimError(w, 409, "mutability", err.Error())
		case errors.Is(err, errSCIMInvalid):
			scimError(w, 400, "invalidValue", err.Error())
		default:
			scimError(w, 409, "uniqueness", err.Error())
		}
		return
	}
	if revokedUserID != "" {
		if err = s.notifySCIMRevoked(r.Context(), tid, revokedUserID); err != nil {
			scimError(w, 500, "", "runtime member cleanup failed")
			return
		}
	}
	action := "scim.user_patch"
	if replace {
		action = "scim.user_replace"
	}
	_ = s.auditSCIM(r.Context(), tokenFromSCIM(r), action, "user", id, nil)
	httpx.JSON(w, 200, result)
}
func (s *Service) scimDeleteUser(w http.ResponseWriter, r *http.Request) {
	tid, id := tenantFromSCIM(r), chi.URLParam(r, "id")
	userID := ""
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		mapped, e := s.loadSCIMMappedUser(r.Context(), tx, tid, id)
		if e != nil {
			return sql.ErrNoRows
		}
		if mapped.Role == "owner" {
			return errSCIMOwner
		}
		userID = mapped.UserID
		if mapped.MembershipStatus != "active" {
			return nil
		}
		if _, e = tx.ExecContext(r.Context(), s.q(`UPDATE tenant_memberships SET status='suspended',updated_at=? WHERE tenant_id=? AND user_id=?`), s.now(), tid, userID); e != nil {
			return e
		}
		_, e = tx.ExecContext(r.Context(), s.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`), s.now(), tid, userID)
		return e
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			scimError(w, 404, "", "User not found")
			return
		}
		scimError(w, 409, "mutability", "Owner cannot be removed or user not found")
		return
	}
	if userID != "" {
		if err = s.notifySCIMRevoked(r.Context(), tid, userID); err != nil {
			scimError(w, 500, "", "runtime member cleanup failed")
			return
		}
	}
	_ = s.auditSCIM(r.Context(), tokenFromSCIM(r), "scim.user_delete", "user", id, nil)
	w.WriteHeader(204)
}
func (s *Service) scimGroups(w http.ResponseWriter, r *http.Request) {
	token := tokenFromSCIM(r)
	roleMap := normalizeSCIMGroupRoleMap(token.GroupRoleMap)
	groups := []map[string]any{}
	names := make([]string, 0, len(roleMap))
	for name := range roleMap {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		groups = append(groups, scimGroupObject(name))
	}
	httpx.JSON(w, 200, map[string]any{"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"}, "totalResults": len(groups), "startIndex": 1, "itemsPerPage": len(groups), "Resources": groups})
}
func (s *Service) scimPatchGroup(w http.ResponseWriter, r *http.Request) {
	token, groupID := tokenFromSCIM(r), chi.URLParam(r, "id")
	roleMap := normalizeSCIMGroupRoleMap(token.GroupRoleMap)
	groupName, role := "", ""
	for name, candidateRole := range roleMap {
		if scimGroupID(name) == groupID {
			groupName, role = name, candidateRole
			break
		}
	}
	if groupName == "" {
		scimError(w, 404, "", "Group not found")
		return
	}
	var body map[string]any
	if httpx.DecodeJSON(r, &body) != nil {
		scimError(w, 400, "invalidSyntax", "invalid request")
		return
	}
	ops, ok := scimOperations(body)
	if !ok {
		scimError(w, 400, "invalidSyntax", "Operations required")
		return
	}
	type groupOperation struct {
		Operation string
		Replace   bool
		Values    []string
	}
	parsed := make([]groupOperation, 0, len(ops))
	for _, op := range ops {
		opName, opOK := op["op"].(string)
		if !opOK && op["op"] != nil {
			scimError(w, 400, "invalidSyntax", "Invalid group operation")
			return
		}
		if opName == "" {
			opName = "replace"
		}
		opName = strings.ToLower(opName)
		if opName != "add" && opName != "replace" && opName != "remove" {
			scimError(w, 400, "invalidSyntax", "Invalid group operation")
			return
		}
		path, pathOK := op["path"].(string)
		if !pathOK && op["path"] != nil {
			scimError(w, 400, "invalidSyntax", "Invalid group operation")
			return
		}
		values := scimMemberValues(op["value"])
		if matches := scimMemberPathRx.FindStringSubmatch(path); len(matches) == 2 {
			values = append(values, matches[1])
		} else if !strings.EqualFold(strings.TrimSpace(path), "members") {
			continue
		}
		parsed = append(parsed, groupOperation{Operation: opName, Replace: opName == "replace", Values: values})
	}
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		for _, op := range parsed {
			if op.Replace && role == "admin" {
				retained := map[string]bool{}
				for _, id := range op.Values {
					retained[id] = true
				}
				rows, e := tx.QueryContext(r.Context(), s.q(`SELECT id,user_id FROM scim_user_mappings WHERE tenant_id=?`), token.TenantID)
				if e != nil {
					return e
				}
				for rows.Next() {
					var mappingID, userID string
					_ = rows.Scan(&mappingID, &userID)
					if !retained[mappingID] {
						_, e = tx.ExecContext(r.Context(), s.q(`UPDATE tenant_memberships SET role='member',updated_at=? WHERE tenant_id=? AND user_id=? AND role='admin'`), s.now(), token.TenantID, userID)
						if e != nil {
							rows.Close()
							return e
						}
					}
				}
				rows.Close()
			}
			for _, mappingID := range op.Values {
				var userID string
				if e := tx.QueryRowContext(r.Context(), s.q(`SELECT user_id FROM scim_user_mappings WHERE tenant_id=? AND id=?`), token.TenantID, mappingID).Scan(&userID); e != nil {
					if errors.Is(e, sql.ErrNoRows) {
						continue
					}
					return e
				}
				nextRole := role
				whereRole := `role<>'owner'`
				if op.Operation == "remove" {
					if role != "admin" {
						continue
					}
					nextRole, whereRole = "member", `role='admin'`
				}
				if _, e := tx.ExecContext(r.Context(), s.q(`UPDATE tenant_memberships SET role=?,updated_at=? WHERE tenant_id=? AND user_id=? AND `+whereRole), nextRole, s.now(), token.TenantID, userID); e != nil {
					return e
				}
			}
		}
		return nil
	})
	if err != nil {
		scimError(w, 400, "invalidSyntax", err.Error())
		return
	}
	_ = s.auditSCIM(r.Context(), token, "scim.group_patch", "group", groupID, nil)
	httpx.JSON(w, 200, scimGroupObject(groupName))
}
func scimUserObject(id, externalID, email, name string, active bool) map[string]any {
	if name == "" {
		name = email
	}
	return map[string]any{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:User"}, "id": id, "externalId": externalID, "userName": email, "name": map[string]string{"formatted": name}, "displayName": name, "active": active, "emails": []map[string]any{{"value": email, "primary": true}}, "meta": map[string]string{"resourceType": "User"}}
}

var (
	errSCIMOwner         = errors.New("SCIM cannot deactivate a tenant owner")
	errSCIMSharedProfile = errors.New("SCIM cannot change the global profile of a user shared with another tenant")
	errSCIMInvalid       = errors.New("valid userName required")
	scimFilterRx         = regexp.MustCompile(`(?i)(?:userName|emails\.value)\s+eq\s+"([^"]+)"`)
	scimMemberPathRx     = regexp.MustCompile(`(?i)members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]`)
)

type scimUserPayload struct {
	Email, Name, ExternalID string
	Active                  bool
}
type scimMappedUser struct {
	MappingID, ExternalID, UserID, Email, Name, UserStatus, MembershipStatus, Role string
}

func (u scimMappedUser) Active() bool {
	return u.UserStatus == "active" && u.MembershipStatus == "active"
}

type scimQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Service) loadSCIMMappedUser(ctx context.Context, db scimQueryer, tenantID, mappingID string) (scimMappedUser, error) {
	var out scimMappedUser
	err := db.QueryRowContext(ctx, s.q(`SELECT sm.id,sm.external_id,u.id,u.email,COALESCE(u.name,''),u.status,COALESCE(m.status,'suspended'),COALESCE(m.role,'member') FROM scim_user_mappings sm JOIN users u ON u.id=sm.user_id LEFT JOIN tenant_memberships m ON m.tenant_id=sm.tenant_id AND m.user_id=u.id WHERE sm.tenant_id=? AND sm.id=?`), tenantID, mappingID).Scan(&out.MappingID, &out.ExternalID, &out.UserID, &out.Email, &out.Name, &out.UserStatus, &out.MembershipStatus, &out.Role)
	return out, err
}

func readSCIMUserPayload(body map[string]any) (scimUserPayload, error) {
	email := strings.ToLower(strings.TrimSpace(stringAny(body["userName"])))
	if values, ok := body["emails"].([]any); ok && len(values) > 0 {
		if first, ok := values[0].(map[string]any); ok {
			if candidate := strings.ToLower(strings.TrimSpace(stringAny(first["value"]))); candidate != "" {
				email = candidate
			}
		}
	}
	if !validEmail(email) {
		return scimUserPayload{}, errSCIMInvalid
	}
	name := strings.TrimSpace(stringAny(body["displayName"]))
	if name == "" {
		if value, ok := body["name"].(map[string]any); ok {
			name = strings.TrimSpace(firstText(stringAny(value["formatted"]), strings.TrimSpace(stringAny(value["givenName"])+" "+stringAny(value["familyName"]))))
		}
	}
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	active := true
	if value, ok := body["active"].(bool); ok {
		active = value
	}
	externalID := strings.TrimSpace(stringAny(body["externalId"]))
	if externalID == "" {
		externalID = email
	}
	return scimUserPayload{Email: email, Name: name, ExternalID: externalID, Active: active}, nil
}

func applySCIMUserOperations(next *scimUserPayload, body map[string]any) error {
	ops, ok := scimOperations(body)
	if !ok {
		payload, err := readSCIMUserPayload(body)
		if err != nil {
			return err
		}
		*next = payload
		return nil
	}
	for _, op := range ops {
		opName, valid := op["op"].(string)
		if !valid && op["op"] != nil {
			return errSCIMInvalid
		}
		if opName == "" {
			opName = "replace"
		}
		if opName = strings.ToLower(opName); opName != "replace" && opName != "add" {
			continue
		}
		path, valid := op["path"].(string)
		if !valid && op["path"] != nil {
			return errSCIMInvalid
		}
		switch strings.ToLower(strings.TrimSpace(path)) {
		case "active":
			if value, ok := op["value"].(bool); ok {
				next.Active = value
			}
		case "displayname":
			if value, ok := op["value"].(string); ok {
				next.Name = strings.TrimSpace(value)
			}
		case "username":
			if value, ok := op["value"].(string); ok {
				next.Email = strings.ToLower(strings.TrimSpace(value))
			}
		case "":
			if value, ok := op["value"].(map[string]any); ok {
				if active, ok := value["active"].(bool); ok {
					next.Active = active
				}
				if display, ok := value["displayName"].(string); ok {
					next.Name = strings.TrimSpace(display)
				}
				if userName, ok := value["userName"].(string); ok {
					next.Email = strings.ToLower(strings.TrimSpace(userName))
				}
			}
		}
	}
	return nil
}

func scimOperations(body map[string]any) ([]map[string]any, bool) {
	raw, ok := body["Operations"]
	if !ok {
		raw, ok = body["operations"]
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	ops := make([]map[string]any, 0, len(items))
	for _, item := range items {
		op, ok := item.(map[string]any)
		if !ok {
			return nil, false
		}
		ops = append(ops, op)
	}
	return ops, true
}

func (s *Service) scimHasOtherMembership(ctx context.Context, db scimQueryer, tenantID, userID string) bool {
	var count int
	return db.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM tenant_memberships WHERE user_id=? AND tenant_id<>?`), userID, tenantID).Scan(&count) != nil || count > 0
}

func (s *Service) notifySCIMRevoked(ctx context.Context, tenantID, userID string) error {
	if s.deps.AfterMemberRemoved != nil {
		return s.deps.AfterMemberRemoved(ctx, tenantID, userID)
	}
	return nil
}

func (s *Service) auditSCIM(ctx context.Context, token scimTokenContext, action, targetType, targetID string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	raw, _ := json.Marshal(detail)
	_, err := s.deps.DB.ExecContext(ctx, s.q(`INSERT INTO security_audit_logs(id,tenant_id,action,actor_type,actor_id,target_type,target_id,detail_json,created_at) VALUES(?,?,?,'scim',?,?,?, ?,?)`), s.deps.NewID(), token.TenantID, action, token.ID, targetType, targetID, string(raw), s.now())
	return err
}

func scimMembershipStatus(active bool) string {
	if active {
		return "active"
	}
	return "suspended"
}

func parseSCIMEmailFilter(value string) string {
	match := scimFilterRx.FindStringSubmatch(value)
	if len(match) != 2 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(match[1]))
}

func normalizeSCIMGroupRoleMap(raw string) map[string]string {
	input := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &input)
	out := map[string]string{}
	for rawName, rawRole := range input {
		name := strings.TrimSpace(rawName)
		if name == "" || len(name) > 120 {
			continue
		}
		role := "member"
		if value, _ := rawRole.(string); value == "admin" {
			role = "admin"
		}
		out[name] = role
	}
	return out
}
func normalizeSCIMGroupRoleInput(input map[string]string) map[string]string {
	out := map[string]string{}
	for rawName, rawRole := range input {
		name := strings.TrimSpace(rawName)
		if name == "" || len(name) > 120 {
			continue
		}
		role := "member"
		if rawRole == "admin" {
			role = "admin"
		}
		out[name] = role
	}
	return out
}

func scimGroupID(name string) string {
	digest := sha256.Sum256([]byte("group:" + name))
	return hex.EncodeToString(digest[:])[:24]
}
func scimGroupObject(name string) map[string]any {
	return map[string]any{"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:Group"}, "id": scimGroupID(name), "displayName": name, "meta": map[string]string{"resourceType": "Group"}}
}
func scimMemberValues(raw any) []string {
	items, _ := raw.([]any)
	values := []string{}
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			if value := strings.TrimSpace(stringAny(object["value"])); value != "" {
				values = append(values, value)
			}
		}
	}
	return values
}

func (s *Service) listAudit(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	limit := boundedInt(r.URL.Query().Get("limit"), 50, 1, 5000)
	offset := boundedInt(r.URL.Query().Get("offset"), 0, 0, 1_000_000)
	tenantID := p.TenantID
	if p.IsPlatformAdmin && r.URL.Query().Get("tenantId") != "" {
		tenantID = r.URL.Query().Get("tenantId")
	}
	action := r.URL.Query().Get("action")
	rows, err := s.deps.DB.QueryContext(r.Context(), s.q(`SELECT id,action,actor_type,COALESCE(actor_id,''),COALESCE(ip,''),COALESCE(target_type,''),COALESCE(target_id,''),detail_json,created_at FROM security_audit_logs WHERE tenant_id=? AND (?='' OR action=?) ORDER BY created_at DESC LIMIT ? OFFSET ?`), tenantID, action, action, limit, offset)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, act, actorType, actorID, ip, targetType, targetID, detail, created string
		_ = rows.Scan(&id, &act, &actorType, &actorID, &ip, &targetType, &targetID, &detail, &created)
		items = append(items, map[string]any{"id": id, "action": act, "actor": map[string]string{"type": actorType, "id": actorID, "ip": ip}, "targetType": targetType, "targetId": targetID, "detail": decodeObject(detail), "createdAt": created})
	}
	var total, retention int
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT COUNT(*) FROM security_audit_logs WHERE tenant_id=? AND (?='' OR action=?)`), tenantID, action, action).Scan(&total)
	_ = s.deps.DB.QueryRowContext(r.Context(), s.q(`SELECT audit_retention_days FROM tenants WHERE id=?`), tenantID).Scan(&retention)
	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="audit.csv"`)
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"id", "action", "actor_id", "target_type", "target_id", "created_at"})
		for _, it := range items {
			actor := it["actor"].(map[string]string)
			_ = cw.Write([]string{it["id"].(string), it["action"].(string), actor["id"], it["targetType"].(string), it["targetId"].(string), it["createdAt"].(string)})
		}
		cw.Flush()
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": total, "limit": limit, "offset": offset, "truncated": offset+len(items) < total, "retentionDays": retention})
}
func (s *Service) putAuditRetention(w http.ResponseWriter, r *http.Request) {
	p, ok := adminPrincipal(r)
	if !ok {
		httpx.Error(w, 403, "Admin only")
		return
	}
	var b struct {
		RetentionDays int `json:"retentionDays"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.RetentionDays < 1 || b.RetentionDays > 3650 {
		httpx.Error(w, 400, "retentionDays must be between 1 and 3650")
		return
	}
	tenantID := p.TenantID
	if p.IsPlatformAdmin && r.URL.Query().Get("tenantId") != "" {
		tenantID = r.URL.Query().Get("tenantId")
	}
	_, err := s.deps.DB.ExecContext(r.Context(), s.q(`UPDATE tenants SET audit_retention_days=?,updated_at=? WHERE id=?`), b.RetentionDays, s.now(), tenantID)
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"retentionDays": b.RetentionDays})
}
func boundedInt(raw string, def, min, max int) int {
	v, e := strconv.Atoi(raw)
	if e != nil {
		v = def
	}
	if v < min {
		v = min
	}
	if v > max {
		v = max
	}
	return v
}
func seal(secret, plain []byte) (string, error) {
	key, err := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, plain, nil)
	ciphertext, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	payload := append(append(append([]byte{}, nonce...), tag...), ciphertext...)
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

var _ = fmt.Sprintf
var _ = time.Second
