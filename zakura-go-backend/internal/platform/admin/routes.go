package admin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/appdeps"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/httpx"
)

type routes struct{ d *appdeps.Dependencies }

func RegisterRoutes(r chi.Router, d *appdeps.Dependencies) {
	a := &routes{d: d}
	r.Group(func(ar chi.Router) {
		ar.Use(httpx.Auth(d))
		ar.Use(httpx.RequirePlatformAdmin)
		ar.Get("/api/admin/stats", a.stats)
		ar.Get("/api/admin/users", a.users)
		ar.Post("/api/admin/users", a.createUser)
		ar.Get("/api/admin/users/{id}", a.user)
		ar.Patch("/api/admin/users/{id}", a.patchUser)
		ar.Post("/api/admin/users/{id}/suspend", a.suspendUser)
		ar.Post("/api/admin/users/{id}/unsuspend", a.unsuspendUser)
		ar.Post("/api/admin/users/{id}/agent-defaults/apply", a.applyAgentDefaults)
		ar.Delete("/api/admin/users/{id}", a.deleteUser)
		ar.Get("/api/admin/tenants", a.tenants)
		ar.Post("/api/admin/tenants", a.createTenant)
		ar.Get("/api/admin/tenants/{id}", a.tenant)
		ar.Patch("/api/admin/tenants/{id}", a.patchTenant)
		ar.Post("/api/admin/tenants/{id}/suspend", a.suspendTenant)
		ar.Post("/api/admin/tenants/{id}/unsuspend", a.unsuspendTenant)
		ar.Delete("/api/admin/tenants/{id}", a.deleteTenant)
		ar.Post("/api/admin/tenants/{id}/members", a.addMember)
		ar.Patch("/api/admin/tenants/{id}/members/{membershipId}", a.patchMember)
		ar.Delete("/api/admin/tenants/{id}/members/{membershipId}", a.deleteMember)
		ar.Get("/api/admin/runners", a.runners)
		ar.Patch("/api/admin/runners/{id}", a.patchRunner)
		ar.Get("/api/admin/platform", a.platform)
		ar.Patch("/api/admin/platform", a.patchPlatform)
		ar.Get("/api/admin/agent-defaults", a.agentDefaults)
		ar.Put("/api/admin/agent-defaults", a.putAgentDefaults)
		ar.Get("/api/admin/oauth-clients", a.oauthClients)
		ar.Delete("/api/admin/oauth-clients/{direction}/{id}", a.deleteOAuthClient)
		ar.Get("/api/admin/oauth/providers", a.oauthProviders)
		ar.Put("/api/admin/oauth/login-policy", a.putLoginPolicy)
		ar.Get("/api/admin/oauth/{provider}", a.oauthProvider)
		ar.Put("/api/admin/oauth/{provider}", a.putOAuthProvider)
	})
}

func (a *routes) q(v string) string { return a.d.Rebind(v) }
func (a *routes) now() string       { return a.d.Clock().UTC().Format("2006-01-02T15:04:05.999999999Z07:00") }
func page(r *http.Request) (int, int) {
	p, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if p < 1 {
		p = 1
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if n < 1 {
		n = 20
	}
	if n > 100 {
		n = 100
	}
	return p, n
}
func listOrder(r *http.Request, allowed map[string]string, fallback string) string {
	column := allowed[r.URL.Query().Get("sort")]
	if column == "" {
		column = allowed[fallback]
	}
	direction := "DESC"
	if strings.EqualFold(r.URL.Query().Get("order"), "asc") {
		direction = "ASC"
	}
	return column + " " + direction
}

func likePattern(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	value = strings.ReplaceAll(value, `_`, `\_`)
	return "%" + strings.ToLower(value) + "%"
}
func (a *routes) stats(w http.ResponseWriter, r *http.Request) {
	since := a.d.Clock().UTC().Add(-7 * 24 * time.Hour).Format(time.RFC3339Nano)
	var userTotal, userSuspended, userAdmins, userNew int
	var tenantTotal, tenantSuspended, tenantNew int
	var runnerTotal, runnerShared, runnerOnline int
	_ = a.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users`).Scan(&userTotal)
	_ = a.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users WHERE suspended_at IS NOT NULL`).Scan(&userSuspended)
	_ = a.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users WHERE is_platform_admin=TRUE`).Scan(&userAdmins)
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE created_at>=?`), since).Scan(&userNew)
	_ = a.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM tenants`).Scan(&tenantTotal)
	_ = a.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM tenants WHERE suspended_at IS NOT NULL`).Scan(&tenantSuspended)
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenants WHERE created_at>=?`), since).Scan(&tenantNew)
	_ = a.d.DB.QueryRowContext(r.Context(), `SELECT COUNT(*),COALESCE(SUM(CASE WHEN is_shared THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN status IN ('online','ready') THEN 1 ELSE 0 END),0) FROM runtime_nodes WHERE kind<>'local'`).Scan(&runnerTotal, &runnerShared, &runnerOnline)
	httpx.JSON(w, 200, map[string]any{
		"users":   map[string]int{"total": userTotal, "suspended": userSuspended, "admins": userAdmins, "newLast7d": userNew},
		"tenants": map[string]int{"total": tenantTotal, "suspended": tenantSuspended, "newLast7d": tenantNew},
		"runners": map[string]int{"total": runnerTotal, "shared": runnerShared, "online": runnerOnline},
	})
}
func (a *routes) users(w http.ResponseWriter, r *http.Request) {
	p, n := page(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pattern := likePattern(q)
	statusFilter := r.URL.Query().Get("status")
	roleFilter := r.URL.Query().Get("role")
	where := ` WHERE (?='' OR LOWER(email) LIKE ? ESCAPE '\' OR LOWER(COALESCE(name,'')) LIKE ? ESCAPE '\')`
	args := []any{q, pattern, pattern}
	if statusFilter == "suspended" {
		where += ` AND suspended_at IS NOT NULL`
	} else if statusFilter == "active" {
		where += ` AND suspended_at IS NULL`
	}
	if roleFilter == "admin" {
		where += ` AND is_platform_admin=TRUE`
	} else if roleFilter == "user" {
		where += ` AND is_platform_admin=FALSE`
	}
	if tenantID := strings.TrimSpace(r.URL.Query().Get("tenantId")); tenantID != "" {
		where += ` AND EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=users.id AND tm.tenant_id=? AND tm.status='active')`
		args = append(args, tenantID)
	}
	var total int
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users`+where), args...).Scan(&total)
	listArgs := append(append([]any{}, args...), n, (p-1)*n)
	order := listOrder(r, map[string]string{"email": "email", "name": "name", "createdAt": "created_at"}, "createdAt")
	rows, err := a.d.DB.QueryContext(r.Context(), a.q(`SELECT id,email,COALESCE(name,''),is_platform_admin,can_use_local_runner,COALESCE(password_hash,''),suspended_at,suspended_reason,suspended_by_user_id,created_at FROM users`+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`), listArgs...)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	type userRow struct {
		id, email, name, password, created string
		admin, runner                      bool
		suspendedAt, reason, suspendedBy   sql.NullString
	}
	userRows := []userRow{}
	for rows.Next() {
		var item userRow
		if rows.Scan(&item.id, &item.email, &item.name, &item.admin, &item.runner, &item.password, &item.suspendedAt, &item.reason, &item.suspendedBy, &item.created) == nil {
			userRows = append(userRows, item)
		}
	}
	rows.Close()
	items := []map[string]any{}
	for _, item := range userRows {
		tenantRows, _ := a.d.DB.QueryContext(r.Context(), a.q(`SELECT t.id,t.slug,t.name,m.role FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' ORDER BY m.created_at`), item.id)
		tenants := []map[string]any{}
		if tenantRows != nil {
			for tenantRows.Next() {
				var tid, slug, tenantName, role string
				if tenantRows.Scan(&tid, &slug, &tenantName, &role) == nil {
					tenants = append(tenants, map[string]any{"tenantId": tid, "slug": slug, "name": tenantName, "role": role})
				}
			}
			tenantRows.Close()
		}
		items = append(items, map[string]any{"id": item.id, "email": item.email, "name": nullIfBlank(item.name), "isPlatformAdmin": item.admin, "canUseLocalRunner": item.runner || item.admin, "hasPassword": item.password != "", "tenants": tenants, "createdAt": item.created, "suspended": item.suspendedAt.Valid, "suspendedAt": nullString(item.suspendedAt), "suspendedReason": nullString(item.reason), "suspendedByUserId": nullString(item.suspendedBy)})
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": total, "page": p, "pageSize": n})
}
func (a *routes) createUser(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Email             string `json:"email"`
		Password          string `json:"password"`
		Name              string `json:"name"`
		TenantName        string `json:"tenantName"`
		IsPlatformAdmin   bool   `json:"isPlatformAdmin"`
		CanUseLocalRunner bool   `json:"canUseLocalRunner"`
	}
	if httpx.DecodeJSON(r, &b) != nil || b.Email == "" || len(b.Password) < 10 {
		httpx.Error(w, 400, "email and password (10+ characters) required")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(b.Password), 12)
	id, tenantID, membershipID := a.d.NewID(), a.d.NewID(), a.d.NewID()
	email := strings.ToLower(strings.TrimSpace(b.Email))
	name := strings.TrimSpace(b.Name)
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	tenantName := strings.TrimSpace(b.TenantName)
	if tenantName == "" {
		tenantName = "My Workspace"
	}
	slug := adminSlug(tenantName) + "-" + strings.ToLower(tenantID[:6])
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(r.Context(), a.q(`INSERT INTO users(id,email,password_hash,name,is_platform_admin,can_use_local_runner,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?)`), id, email, string(hash), name, boolInt(b.IsPlatformAdmin), boolInt(b.IsPlatformAdmin || b.CanUseLocalRunner), a.now(), a.now()); e != nil {
			return e
		}
		if _, e := tx.ExecContext(r.Context(), a.q(`INSERT INTO tenants(id,slug,name,is_default,onboarding_completed,onboarding_steps,status,created_at,updated_at) VALUES(?,?,?,FALSE,FALSE,'{}','active',?,?)`), tenantID, slug, tenantName, a.now(), a.now()); e != nil {
			return e
		}
		_, e := tx.ExecContext(r.Context(), a.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)`), membershipID, tenantID, id, a.now(), a.now())
		return e
	})
	if err != nil {
		httpx.Error(w, 409, "email already registered")
		return
	}
	httpx.JSON(w, 201, map[string]any{"user": map[string]any{"id": id, "email": email, "name": name, "isPlatformAdmin": b.IsPlatformAdmin}, "tenant": map[string]any{"id": tenantID, "slug": slug, "name": tenantName}})
}
func (a *routes) user(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var email, name, password, created, updated string
	var admin, runner bool
	var suspendedAt, reason, suspendedByID sql.NullString
	if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT email,COALESCE(name,''),is_platform_admin,can_use_local_runner,COALESCE(password_hash,''),created_at,updated_at,suspended_at,suspended_reason,suspended_by_user_id FROM users WHERE id=?`), id).Scan(&email, &name, &admin, &runner, &password, &created, &updated, &suspendedAt, &reason, &suspendedByID) != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	rows, _ := a.d.DB.QueryContext(r.Context(), a.q(`SELECT m.id,m.role,m.status,m.created_at,t.id,t.slug,t.name,t.suspended_at FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? ORDER BY m.created_at`), id)
	memberships := []map[string]any{}
	if rows != nil {
		for rows.Next() {
			var mid, role, status, joined, tid, slug, tenantName string
			var tenantSuspended sql.NullString
			if rows.Scan(&mid, &role, &status, &joined, &tid, &slug, &tenantName, &tenantSuspended) == nil {
				memberships = append(memberships, map[string]any{"membershipId": mid, "role": role, "status": status, "joinedAt": joined, "tenantId": tid, "slug": slug, "name": tenantName, "tenantSuspended": tenantSuspended.Valid})
			}
		}
		rows.Close()
	}
	identities := []map[string]any{}
	identityRows, _ := a.d.DB.QueryContext(r.Context(), a.q(`SELECT provider,created_at FROM oauth_identities WHERE user_id=? ORDER BY created_at`), id)
	if identityRows != nil {
		for identityRows.Next() {
			var provider, at string
			if identityRows.Scan(&provider, &at) == nil {
				identities = append(identities, map[string]any{"provider": provider, "createdAt": at})
			}
		}
		identityRows.Close()
	}
	runners := []map[string]any{}
	runnerRows, _ := a.d.DB.QueryContext(r.Context(), a.q(`SELECT id,name,status,is_shared FROM runtime_nodes WHERE created_by_user_id=? ORDER BY created_at`), id)
	if runnerRows != nil {
		for runnerRows.Next() {
			var rid, runnerName, status string
			var shared bool
			if runnerRows.Scan(&rid, &runnerName, &status, &shared) == nil {
				runners = append(runners, map[string]any{"id": rid, "name": runnerName, "status": status, "isShared": shared})
			}
		}
		runnerRows.Close()
	}
	var suspendedBy any
	if suspendedByID.Valid {
		var actorEmail string
		if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT email FROM users WHERE id=?`), suspendedByID.String).Scan(&actorEmail) == nil {
			suspendedBy = map[string]any{"id": suspendedByID.String, "email": actorEmail}
		}
	}
	httpx.JSON(w, 200, map[string]any{"user": map[string]any{"id": id, "email": email, "name": nullIfBlank(name), "isPlatformAdmin": admin, "canUseLocalRunner": runner || admin, "hasPassword": password != "", "createdAt": created, "updatedAt": updated, "suspended": suspendedAt.Valid, "suspendedAt": nullString(suspendedAt), "suspendedReason": nullString(reason), "suspendedByUserId": nullString(suspendedByID), "suspendedBy": suspendedBy}, "memberships": memberships, "identities": identities, "runners": runners})
}
func (a *routes) patchUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var b struct {
		Name              *string `json:"name"`
		Email             *string `json:"email"`
		Password          *string `json:"password"`
		IsPlatformAdmin   *bool   `json:"isPlatformAdmin"`
		CanUseLocalRunner *bool   `json:"canUseLocalRunner"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	var name, email, password string
	var admin, runner bool
	if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COALESCE(name,''),email,is_platform_admin,can_use_local_runner,COALESCE(password_hash,'') FROM users WHERE id=?`), id).Scan(&name, &email, &admin, &runner, &password) != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if b.Name != nil {
		name = strings.TrimSpace(*b.Name)
	}
	if b.Email != nil {
		email = strings.ToLower(strings.TrimSpace(*b.Email))
		if !strings.Contains(email, "@") {
			httpx.Error(w, 400, "invalid email")
			return
		}
	}
	p, _ := httpx.PrincipalFrom(r.Context())
	if b.IsPlatformAdmin != nil {
		if !*b.IsPlatformAdmin && id == p.UserID {
			httpx.Error(w, 400, "cannot remove your own platform administrator role")
			return
		}
		if !*b.IsPlatformAdmin && admin {
			var others int
			_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE is_platform_admin=TRUE AND suspended_at IS NULL AND id<>?`), id).Scan(&others)
			if others == 0 {
				httpx.Error(w, 400, "at least one platform administrator is required")
				return
			}
		}
		admin = *b.IsPlatformAdmin
	}
	if b.CanUseLocalRunner != nil {
		runner = *b.CanUseLocalRunner
	}
	if admin {
		runner = true
	}
	passwordChanged := false
	if b.Password != nil {
		if len(*b.Password) < 8 {
			httpx.Error(w, 400, "password must contain at least 8 characters")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(*b.Password), 12)
		if err != nil {
			httpx.Error(w, 500, "password hashing failed")
			return
		}
		password = string(hash)
		passwordChanged = true
	}
	_, err := a.d.DB.ExecContext(r.Context(), a.q(`UPDATE users SET name=?,email=?,password_hash=?,is_platform_admin=?,can_use_local_runner=?,updated_at=? WHERE id=?`), name, email, password, boolInt(admin), boolInt(runner), a.now(), id)
	if err != nil {
		httpx.Error(w, 409, "update conflict")
		return
	}
	if passwordChanged {
		_, _ = a.d.DB.ExecContext(r.Context(), a.q(`UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`), a.now(), id)
	}
	httpx.JSON(w, 200, map[string]any{"user": map[string]any{"id": id, "email": email, "name": nullIfBlank(name), "isPlatformAdmin": admin, "canUseLocalRunner": runner || admin, "hasPassword": password != ""}})
}
func (a *routes) suspendUser(w http.ResponseWriter, r *http.Request) {
	a.setUserStatus(w, r, "suspended")
}
func (a *routes) unsuspendUser(w http.ResponseWriter, r *http.Request) {
	a.setUserStatus(w, r, "active")
}
func (a *routes) setUserStatus(w http.ResponseWriter, r *http.Request, status string) {
	id := chi.URLParam(r, "id")
	p, _ := httpx.PrincipalFrom(r.Context())
	if id == p.UserID && status == "suspended" {
		httpx.Error(w, 409, "cannot suspend yourself")
		return
	}
	reason := ""
	if status == "suspended" {
		var body struct {
			Reason string `json:"reason"`
		}
		if r.Body != nil {
			_ = httpx.DecodeJSON(r, &body)
		}
		reason = strings.TrimSpace(body.Reason)
	}
	now := a.now()
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		if status == "suspended" {
			var targetAdmin bool
			if e := tx.QueryRowContext(r.Context(), a.q(`SELECT is_platform_admin FROM users WHERE id=?`), id).Scan(&targetAdmin); e != nil {
				return e
			}
			if targetAdmin {
				var others int
				if e := tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE is_platform_admin=TRUE AND suspended_at IS NULL AND id<>?`), id).Scan(&others); e != nil || others == 0 {
					return errors.New("at least one active platform administrator is required")
				}
			}
			var soleOwners int
			if e := tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenant_memberships m WHERE m.user_id=? AND m.role='owner' AND m.status='active' AND NOT EXISTS(SELECT 1 FROM tenant_memberships x JOIN users u ON u.id=x.user_id WHERE x.tenant_id=m.tenant_id AND x.role='owner' AND x.status='active' AND x.user_id<>m.user_id AND u.suspended_at IS NULL)`), id).Scan(&soleOwners); e != nil || soleOwners > 0 {
				return errors.New("assign another active tenant owner before suspension")
			}
		}
		res, e := tx.ExecContext(r.Context(), a.q(`UPDATE users SET status=?,suspended_at=?,suspended_reason=?,suspended_by_user_id=?,updated_at=? WHERE id=?`), status, nullIfActive(status, now), nullIfBlank(reason), map[bool]any{true: nil, false: p.UserID}[status == "active"], now, id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return sql.ErrNoRows
		}
		if status == "suspended" {
			_, e = tx.ExecContext(r.Context(), a.q(`UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`), now, id)
		}
		return e
	})
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if status == "suspended" && a.d.AfterMemberRemoved != nil {
		rows, queryErr := a.d.DB.QueryContext(r.Context(), a.q(`SELECT tenant_id FROM tenant_memberships WHERE user_id=? AND status='active'`), id)
		if queryErr != nil {
			httpx.Error(w, 503, "user suspended but runtime cleanup query failed")
			return
		}
		tenantIDs := []string{}
		for rows.Next() {
			var tenantID string
			if rows.Scan(&tenantID) == nil {
				tenantIDs = append(tenantIDs, tenantID)
			}
		}
		rows.Close()
		for _, tenantID := range tenantIDs {
			if hookErr := a.d.AfterMemberRemoved(r.Context(), tenantID, id); hookErr != nil {
				httpx.Error(w, 503, "user suspended but runtime cleanup failed")
				return
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"user": map[string]any{"id": id, "suspended": status == "suspended", "suspendedAt": nullIfActive(status, now), "suspendedReason": nullIfBlank(reason), "suspendedByUserId": map[bool]any{true: nil, false: p.UserID}[status == "active"]}})
}
func (a *routes) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	p, _ := httpx.PrincipalFrom(r.Context())
	if id == p.UserID {
		httpx.Error(w, 409, "cannot delete yourself")
		return
	}
	if a.d.BeforeTenantDelete != nil {
		rows, queryErr := a.d.DB.QueryContext(r.Context(), a.q(`SELECT m.tenant_id FROM tenant_memberships m WHERE m.user_id=? AND m.role='owner' AND m.status='active' AND NOT EXISTS(SELECT 1 FROM tenant_memberships x WHERE x.tenant_id=m.tenant_id AND x.user_id<>m.user_id)`), id)
		if queryErr != nil {
			httpx.Error(w, 500, "tenant cleanup query failed")
			return
		}
		orphanCandidates := []string{}
		for rows.Next() {
			var tenantID string
			if rows.Scan(&tenantID) == nil {
				orphanCandidates = append(orphanCandidates, tenantID)
			}
		}
		rows.Close()
		for _, tenantID := range orphanCandidates {
			if hookErr := a.d.BeforeTenantDelete(r.Context(), tenantID); hookErr != nil {
				httpx.Error(w, 503, "runtime tenant cleanup failed")
				return
			}
		}
	}
	deletedTenants := 0
	deletedTenantIDs := map[string]bool{}
	removedTenantIDs := []string{}
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		var targetAdmin bool
		if e := tx.QueryRowContext(r.Context(), a.q(`SELECT is_platform_admin FROM users WHERE id=?`), id).Scan(&targetAdmin); e != nil {
			return e
		}
		if targetAdmin {
			var otherAdmins int
			if e := tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE is_platform_admin=TRUE AND suspended_at IS NULL AND id<>?`), id).Scan(&otherAdmins); e != nil || otherAdmins == 0 {
				return errors.New("at least one platform administrator is required")
			}
		}
		membershipRows, e := tx.QueryContext(r.Context(), a.q(`SELECT tenant_id FROM tenant_memberships WHERE user_id=?`), id)
		if e != nil {
			return e
		}
		for membershipRows.Next() {
			var tenantID string
			if membershipRows.Scan(&tenantID) == nil {
				removedTenantIDs = append(removedTenantIDs, tenantID)
			}
		}
		membershipRows.Close()
		ownerRows, e := tx.QueryContext(r.Context(), a.q(`SELECT tenant_id FROM tenant_memberships WHERE user_id=? AND role='owner' AND status='active'`), id)
		if e != nil {
			return e
		}
		owned := []string{}
		for ownerRows.Next() {
			var tenantID string
			if ownerRows.Scan(&tenantID) == nil {
				owned = append(owned, tenantID)
			}
		}
		ownerRows.Close()
		for _, tenantID := range owned {
			var otherMembers, otherOwners int
			if e = tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=? AND user_id<>?`), tenantID, id).Scan(&otherMembers); e != nil {
				return e
			}
			if e = tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenant_memberships x JOIN users u ON u.id=x.user_id WHERE x.tenant_id=? AND x.user_id<>? AND x.role='owner' AND x.status='active' AND u.suspended_at IS NULL`), tenantID, id).Scan(&otherOwners); e != nil {
				return e
			}
			if otherOwners == 0 && otherMembers > 0 {
				return errors.New("assign another active tenant owner before deletion")
			}
			if otherMembers == 0 {
				if e = a.deleteTenantAggregateTx(r.Context(), tx, tenantID, false); e != nil {
					return e
				}
				deletedTenants++
				deletedTenantIDs[tenantID] = true
			}
		}
		res, e := tx.ExecContext(r.Context(), a.q(`DELETE FROM users WHERE id=?`), id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return sql.ErrNoRows
		}
		return nil
	})
	if err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	if a.d.AfterMemberRemoved != nil {
		for _, tenantID := range removedTenantIDs {
			if deletedTenantIDs[tenantID] {
				continue
			}
			if hookErr := a.d.AfterMemberRemoved(r.Context(), tenantID, id); hookErr != nil {
				httpx.Error(w, 503, "user deleted but runtime membership cleanup failed")
				return
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "deletedTenants": deletedTenants})
}

func (a *routes) tenants(w http.ResponseWriter, r *http.Request) {
	p, n := page(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pattern := likePattern(q)
	where := ` WHERE (?='' OR LOWER(t.name) LIKE ? ESCAPE '\' OR LOWER(t.slug) LIKE ? ESCAPE '\')`
	args := []any{q, pattern, pattern}
	if status := r.URL.Query().Get("status"); status == "suspended" {
		where += ` AND t.suspended_at IS NOT NULL`
	} else if status == "active" {
		where += ` AND t.suspended_at IS NULL`
	}
	if onboarding := r.URL.Query().Get("onboarding"); onboarding == "completed" {
		where += ` AND t.onboarding_completed=TRUE`
	} else if onboarding == "pending" {
		where += ` AND t.onboarding_completed=FALSE`
	}
	var total int
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenants t`+where), args...).Scan(&total)
	listArgs := append(append([]any{}, args...), n, (p-1)*n)
	order := listOrder(r, map[string]string{"name": "t.name", "slug": "t.slug", "createdAt": "t.created_at"}, "createdAt")
	rows, err := a.d.DB.QueryContext(r.Context(), a.q(`SELECT t.id,t.slug,t.name,t.is_default,t.onboarding_completed,t.suspended_at,t.suspended_reason,t.suspended_by_user_id,t.created_at,(SELECT COUNT(*) FROM tenant_memberships m WHERE m.tenant_id=t.id AND m.status='active') FROM tenants t`+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`), listArgs...)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, slug, name, created string
		var def, onboard bool
		var suspendedAt, reason, suspendedBy sql.NullString
		var members int
		_ = rows.Scan(&id, &slug, &name, &def, &onboard, &suspendedAt, &reason, &suspendedBy, &created, &members)
		items = append(items, map[string]any{"id": id, "slug": slug, "name": name, "isDefault": def, "onboardingCompleted": onboard, "memberCount": members, "createdAt": created, "suspended": suspendedAt.Valid, "suspendedAt": nullString(suspendedAt), "suspendedReason": nullString(reason), "suspendedByUserId": nullString(suspendedBy)})
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": total, "page": p, "pageSize": n})
}
func (a *routes) createTenant(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name        string `json:"name"`
		Slug        string `json:"slug"`
		OwnerUserID string `json:"ownerUserId"`
		OwnerEmail  string `json:"ownerEmail"`
	}
	if httpx.DecodeJSON(r, &b) != nil || strings.TrimSpace(b.Name) == "" {
		httpx.Error(w, 400, "name required")
		return
	}
	p, _ := httpx.PrincipalFrom(r.Context())
	ownerID := strings.TrimSpace(b.OwnerUserID)
	if ownerID == "" && strings.TrimSpace(b.OwnerEmail) != "" {
		if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT id FROM users WHERE email=?`), strings.ToLower(strings.TrimSpace(b.OwnerEmail))).Scan(&ownerID) != nil {
			httpx.Error(w, 404, "owner email not found")
			return
		}
	}
	if ownerID == "" {
		ownerID = p.UserID
	}
	var ownerCount int
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE id=?`), ownerID).Scan(&ownerCount)
	if ownerCount != 1 {
		httpx.Error(w, 404, "owner user not found")
		return
	}
	tid := a.d.NewID()
	slug := adminSlug(b.Slug)
	if strings.TrimSpace(b.Slug) == "" {
		slug = adminSlug(b.Name)
	}
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(r.Context(), a.q(`INSERT INTO tenants(id,slug,name,onboarding_steps,status,created_at,updated_at) VALUES(?,?,?,'{}','active',?,?)`), tid, slug, strings.TrimSpace(b.Name), a.now(), a.now()); e != nil {
			return e
		}
		_, e := tx.ExecContext(r.Context(), a.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)`), a.d.NewID(), tid, ownerID, a.now(), a.now())
		return e
	})
	if err != nil {
		httpx.Error(w, 409, "tenant conflict")
		return
	}
	httpx.JSON(w, 201, map[string]any{"tenant": map[string]any{"id": tid, "slug": slug, "name": strings.TrimSpace(b.Name), "isDefault": false, "onboardingCompleted": false}})
}
func (a *routes) tenant(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var slug, name, created string
	var def, onboard bool
	var suspendedAt, reason, suspendedByID sql.NullString
	if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT slug,name,is_default,onboarding_completed,created_at,suspended_at,suspended_reason,suspended_by_user_id FROM tenants WHERE id=?`), id).Scan(&slug, &name, &def, &onboard, &created, &suspendedAt, &reason, &suspendedByID) != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	rows, _ := a.d.DB.QueryContext(r.Context(), a.q(`SELECT m.id,m.role,m.status,m.created_at,u.id,u.email,COALESCE(u.name,''),u.suspended_at,u.is_platform_admin FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.created_at`), id)
	members := []map[string]any{}
	if rows != nil {
		for rows.Next() {
			var mid, role, status, joined, uid, email, userName string
			var userSuspended sql.NullString
			var platformAdmin bool
			if rows.Scan(&mid, &role, &status, &joined, &uid, &email, &userName, &userSuspended, &platformAdmin) == nil {
				members = append(members, map[string]any{"membershipId": mid, "role": role, "status": status, "joinedAt": joined, "user": map[string]any{"id": uid, "email": email, "name": nullIfBlank(userName), "suspended": userSuspended.Valid, "isPlatformAdmin": platformAdmin}})
			}
		}
		rows.Close()
	}
	runners := []map[string]any{}
	runnerRows, _ := a.d.DB.QueryContext(r.Context(), a.q(`SELECT id,name,status,is_shared FROM runtime_nodes WHERE tenant_id=? ORDER BY created_at`), id)
	if runnerRows != nil {
		for runnerRows.Next() {
			var rid, runnerName, status string
			var shared bool
			if runnerRows.Scan(&rid, &runnerName, &status, &shared) == nil {
				runners = append(runners, map[string]any{"id": rid, "name": runnerName, "status": status, "isShared": shared})
			}
		}
		runnerRows.Close()
	}
	var suspendedBy any
	if suspendedByID.Valid {
		var actorEmail string
		if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT email FROM users WHERE id=?`), suspendedByID.String).Scan(&actorEmail) == nil {
			suspendedBy = map[string]any{"id": suspendedByID.String, "email": actorEmail}
		}
	}
	httpx.JSON(w, 200, map[string]any{"tenant": map[string]any{"id": id, "slug": slug, "name": name, "isDefault": def, "onboardingCompleted": onboard, "createdAt": created, "suspended": suspendedAt.Valid, "suspendedAt": nullString(suspendedAt), "suspendedReason": nullString(reason), "suspendedByUserId": nullString(suspendedByID), "suspendedBy": suspendedBy}, "members": members, "runners": runners})
}
func (a *routes) patchTenant(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var b struct {
		Name *string `json:"name"`
		Slug *string `json:"slug"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	var name, slug string
	if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT name,slug FROM tenants WHERE id=?`), id).Scan(&name, &slug) != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if b.Name != nil {
		name = strings.TrimSpace(*b.Name)
	}
	if b.Slug != nil {
		slug = strings.TrimSpace(*b.Slug)
	}
	_, err := a.d.DB.ExecContext(r.Context(), a.q(`UPDATE tenants SET name=?,slug=?,updated_at=? WHERE id=?`), name, slug, a.now(), id)
	if err != nil {
		httpx.Error(w, 409, "update conflict")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
func (a *routes) suspendTenant(w http.ResponseWriter, r *http.Request) {
	a.setTenantStatus(w, r, "suspended")
}
func (a *routes) unsuspendTenant(w http.ResponseWriter, r *http.Request) {
	a.setTenantStatus(w, r, "active")
}
func (a *routes) setTenantStatus(w http.ResponseWriter, r *http.Request, status string) {
	id := chi.URLParam(r, "id")
	p, _ := httpx.PrincipalFrom(r.Context())
	reason := ""
	if status == "suspended" {
		var body struct {
			Reason string `json:"reason"`
		}
		if r.Body != nil {
			_ = httpx.DecodeJSON(r, &body)
		}
		reason = strings.TrimSpace(body.Reason)
	}
	if status == "suspended" {
		var isDefault bool
		if err := a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT is_default FROM tenants WHERE id=?`), id).Scan(&isDefault); err != nil {
			httpx.Error(w, 404, "Not found")
			return
		}
		if isDefault {
			httpx.Error(w, 409, "default tenant cannot be suspended")
			return
		}
		if a.d.BeforeTenantDelete != nil {
			if err := a.d.BeforeTenantDelete(r.Context(), id); err != nil {
				httpx.Error(w, 503, "runtime tenant cleanup failed")
				return
			}
		}
	}
	now := a.now()
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		res, e := tx.ExecContext(r.Context(), a.q(`UPDATE tenants SET status=?,suspended_at=?,suspended_reason=?,suspended_by_user_id=?,updated_at=? WHERE id=? AND is_default=FALSE`), status, nullIfActive(status, now), nullIfBlank(reason), map[bool]any{true: nil, false: p.UserID}[status == "active"], now, id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return errors.New("default tenant cannot be suspended")
		}
		if status == "suspended" {
			_, e = tx.ExecContext(r.Context(), a.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND revoked_at IS NULL`), now, id)
		}
		return e
	})
	if err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"tenant": map[string]any{"id": id, "suspended": status == "suspended", "suspendedAt": nullIfActive(status, now), "suspendedReason": nullIfBlank(reason), "suspendedByUserId": map[bool]any{true: nil, false: p.UserID}[status == "active"]}})
}
func (a *routes) deleteTenant(w http.ResponseWriter, r *http.Request) {
	tenantID := chi.URLParam(r, "id")
	var isDefault bool
	if err := a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT is_default FROM tenants WHERE id=?`), tenantID).Scan(&isDefault); err != nil {
		httpx.Error(w, 404, "Not found")
		return
	}
	if isDefault {
		httpx.Error(w, 409, "default tenant cannot be deleted")
		return
	}
	if a.d.BeforeTenantDelete != nil {
		if err := a.d.BeforeTenantDelete(r.Context(), tenantID); err != nil {
			httpx.Error(w, 503, "runtime tenant cleanup failed")
			return
		}
	}
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		return a.deleteTenantAggregateTx(r.Context(), tx, tenantID, true)
	})
	if err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (a *routes) deleteTenantAggregateTx(ctx context.Context, tx *sql.Tx, tenantID string, protectDefault bool) error {
	for _, query := range []string{
		`DELETE FROM connector_auth_profiles WHERE scope_key=?`,
		`DELETE FROM connector_settings WHERE scope_key=?`,
		`DELETE FROM skill_source_tokens WHERE scope_key=?`,
		`DELETE FROM platform_service_quotas WHERE scope_key=?`,
		`DELETE FROM settings WHERE owner_key=? OR owner_key=?`,
	} {
		args := []any{tenantID}
		if strings.Contains(query, "owner_key") {
			args = append(args, "tenant:"+tenantID)
		}
		if _, err := tx.ExecContext(ctx, a.q(query), args...); err != nil {
			return err
		}
	}
	query := `DELETE FROM tenants WHERE id=?`
	if protectDefault {
		query += ` AND is_default=FALSE`
	}
	res, err := tx.ExecContext(ctx, a.q(query), tenantID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return errors.New("default tenant cannot be deleted")
	}
	return nil
}
func (a *routes) addMember(w http.ResponseWriter, r *http.Request) {
	var b struct {
		UserID string `json:"userId"`
		Email  string `json:"email"`
		Role   string `json:"role"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	tenantID := chi.URLParam(r, "id")
	var tenantStatus string
	if err := a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT status FROM tenants WHERE id=?`), tenantID).Scan(&tenantStatus); err != nil {
		httpx.Error(w, 404, "Not found")
		return
	}
	if tenantStatus != "active" {
		httpx.Error(w, 403, "tenant is suspended")
		return
	}
	b.UserID = strings.TrimSpace(b.UserID)
	if b.UserID == "" && strings.TrimSpace(b.Email) != "" {
		_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT id FROM users WHERE email=?`), strings.ToLower(strings.TrimSpace(b.Email))).Scan(&b.UserID)
	}
	if b.UserID == "" {
		httpx.Error(w, 404, "user not found")
		return
	}
	var userExists int
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE id=?`), b.UserID).Scan(&userExists)
	if userExists != 1 {
		httpx.Error(w, 404, "user not found")
		return
	}
	if b.Role == "" {
		b.Role = "member"
	}
	if b.Role != "owner" && b.Role != "admin" && b.Role != "member" {
		httpx.Error(w, 400, "invalid role")
		return
	}
	id := a.d.NewID()
	_, err := a.d.DB.ExecContext(r.Context(), a.q(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)`), id, tenantID, b.UserID, b.Role, a.now(), a.now())
	if err != nil {
		httpx.Error(w, 409, "membership conflict")
		return
	}
	httpx.JSON(w, 201, map[string]any{"ok": true})
}
func (a *routes) patchMember(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	if b.Role != nil && *b.Role != "owner" && *b.Role != "admin" && *b.Role != "member" {
		httpx.Error(w, 400, "invalid role")
		return
	}
	if b.Status != nil && *b.Status != "active" && *b.Status != "suspended" {
		httpx.Error(w, 400, "invalid status")
		return
	}
	if b.Role == nil && b.Status == nil {
		httpx.Error(w, 400, "no membership fields to update")
		return
	}
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "membershipId")
	var role, status, userID string
	var revoked bool
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		if e := tx.QueryRowContext(r.Context(), a.q(`SELECT role,status,user_id FROM tenant_memberships WHERE id=? AND tenant_id=?`), mid, tid).Scan(&role, &status, &userID); e != nil {
			return e
		}
		previousStatus := status
		nextRole, nextStatus := role, status
		if b.Role != nil {
			nextRole = *b.Role
		}
		if b.Status != nil {
			nextStatus = *b.Status
		}
		if role == "owner" && status == "active" && (nextRole != "owner" || nextStatus != "active") {
			var others int
			if e := tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.role='owner' AND m.status='active' AND m.id<>? AND u.suspended_at IS NULL`), tid, mid).Scan(&others); e != nil || others == 0 {
				return errors.New("tenant must keep an active owner")
			}
		}
		res, e := tx.ExecContext(r.Context(), a.q(`UPDATE tenant_memberships SET role=?,status=?,updated_at=? WHERE id=? AND tenant_id=?`), nextRole, nextStatus, a.now(), mid, tid)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return sql.ErrNoRows
		}
		role, status = nextRole, nextStatus
		revoked = previousStatus == "active" && status == "suspended"
		if revoked {
			_, e = tx.ExecContext(r.Context(), a.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`), a.now(), tid, userID)
		}
		return e
	})
	if err != nil {
		statusCode := 409
		if errors.Is(err, sql.ErrNoRows) {
			statusCode = 404
		}
		httpx.Error(w, statusCode, err.Error())
		return
	}
	if revoked && a.d.AfterMemberRemoved != nil {
		if err = a.d.AfterMemberRemoved(r.Context(), tid, userID); err != nil {
			httpx.Error(w, 503, "membership updated but runtime cleanup failed")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"membership": map[string]any{"id": mid, "role": role, "status": status}})
}
func (a *routes) deleteMember(w http.ResponseWriter, r *http.Request) {
	tid, mid := chi.URLParam(r, "id"), chi.URLParam(r, "membershipId")
	var userID string
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		var role, status string
		if e := tx.QueryRowContext(r.Context(), a.q(`SELECT role,status,user_id FROM tenant_memberships WHERE id=? AND tenant_id=?`), mid, tid).Scan(&role, &status, &userID); e != nil {
			return e
		}
		if role == "owner" && status == "active" {
			var n int
			if e := tx.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.role='owner' AND m.status='active' AND m.id<>? AND u.suspended_at IS NULL`), tid, mid).Scan(&n); e != nil {
				return e
			}
			if n == 0 {
				return errors.New("tenant must keep an owner")
			}
		}
		res, e := tx.ExecContext(r.Context(), a.q(`DELETE FROM tenant_memberships WHERE id=? AND tenant_id=?`), mid, tid)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return sql.ErrNoRows
		}
		_, e = tx.ExecContext(r.Context(), a.q(`UPDATE user_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL`), a.now(), tid, userID)
		return e
	})
	if err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	if a.d.AfterMemberRemoved != nil {
		if err = a.d.AfterMemberRemoved(r.Context(), tid, userID); err != nil {
			httpx.Error(w, 503, "member removed but runtime cleanup failed")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (a *routes) applyAgentDefaults(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")
	rows, err := a.d.DB.QueryContext(r.Context(), a.q(`SELECT m.tenant_id FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' AND t.suspended_at IS NULL ORDER BY m.tenant_id`), userID)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	tenants := []string{}
	for rows.Next() {
		var tenantID string
		if rows.Scan(&tenantID) == nil {
			tenants = append(tenants, tenantID)
		}
	}
	rows.Close()
	if len(tenants) == 0 {
		var exists int
		_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM users WHERE id=?`), userID).Scan(&exists)
		if exists == 0 {
			httpx.Error(w, 404, "user not found")
			return
		}
	}
	updated := 0
	for _, tenantID := range tenants {
		agentRows, e := a.d.DB.QueryContext(r.Context(), a.q(`SELECT id,config_json FROM agents WHERE tenant_id=?`), tenantID)
		if e != nil {
			httpx.Error(w, 400, e.Error())
			return
		}
		type agentConfig struct{ id, raw string }
		agents := []agentConfig{}
		for agentRows.Next() {
			var agent agentConfig
			if agentRows.Scan(&agent.id, &agent.raw) == nil {
				agents = append(agents, agent)
			}
		}
		agentRows.Close()
		for _, agent := range agents {
			bag := map[string]any{}
			_ = json.Unmarshal([]byte(agent.raw), &bag)
			providers, _ := bag["providers"].(map[string]any)
			if providers == nil {
				providers = map[string]any{}
			}
			for _, key := range []string{"webSearch", "webFetch"} {
				value, _ := providers[key].(map[string]any)
				if value == nil {
					value = map[string]any{}
				}
				value["enabled"] = true
				providers[key] = value
			}
			bag["providers"] = providers
			next, _ := json.Marshal(bag)
			if string(next) == agent.raw {
				continue
			}
			if _, e = a.d.DB.ExecContext(r.Context(), a.q(`UPDATE agents SET config_json=?,updated_at=? WHERE id=? AND tenant_id=?`), string(next), a.now(), agent.id, tenantID); e != nil {
				httpx.Error(w, 400, e.Error())
				return
			}
			updated++
		}
	}
	httpx.JSON(w, 200, map[string]any{"updated": updated, "tenants": len(tenants)})
}

func (a *routes) runners(w http.ResponseWriter, r *http.Request) {
	p, n := page(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pattern := likePattern(q)
	where := ` WHERE rn.kind<>'local' AND (?='' OR LOWER(rn.name) LIKE ? ESCAPE '\' OR LOWER(rn.slug) LIKE ? ESCAPE '\' OR LOWER(COALESCE(t.name,'')) LIKE ? ESCAPE '\' OR LOWER(COALESCE(t.slug,'')) LIKE ? ESCAPE '\' OR LOWER(COALESCE(u.email,'')) LIKE ? ESCAPE '\')`
	args := []any{q, pattern, pattern, pattern, pattern, pattern}
	if status := r.URL.Query().Get("status"); status != "" && status != "all" {
		where += ` AND rn.status=?`
		args = append(args, status)
	}
	if shared := r.URL.Query().Get("shared"); shared == "shared" {
		where += ` AND rn.is_shared=TRUE`
	} else if shared == "private" {
		where += ` AND rn.is_shared=FALSE`
	}
	var total int
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM runtime_nodes rn LEFT JOIN tenants t ON t.id=rn.tenant_id LEFT JOIN users u ON u.id=rn.created_by_user_id`+where), args...).Scan(&total)
	listArgs := append(append([]any{}, args...), n, (p-1)*n)
	order := listOrder(r, map[string]string{"name": "rn.name", "status": "rn.status", "createdAt": "rn.created_at", "lastSeenAt": "rn.last_seen_at"}, "createdAt")
	rows, err := a.d.DB.QueryContext(r.Context(), a.q(`SELECT rn.id,rn.name,rn.slug,rn.status,rn.is_shared,rn.tenant_id,t.slug,t.name,rn.created_by_user_id,u.email,COALESCE(u.is_platform_admin,FALSE),rn.last_seen_at,rn.created_at FROM runtime_nodes rn LEFT JOIN tenants t ON t.id=rn.tenant_id LEFT JOIN users u ON u.id=rn.created_by_user_id`+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`), listArgs...)
	if err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, name, slug, status, tenantID, created string
		var shared, ownerAdmin bool
		var tenantSlug, tenantName, creatorID, creatorEmail, lastSeen sql.NullString
		if rows.Scan(&id, &name, &slug, &status, &shared, &tenantID, &tenantSlug, &tenantName, &creatorID, &creatorEmail, &ownerAdmin, &lastSeen, &created) == nil {
			items = append(items, map[string]any{"id": id, "name": name, "slug": slug, "status": status, "isShared": shared, "tenantId": tenantID, "tenantSlug": nullString(tenantSlug), "tenantName": nullString(tenantName), "createdByUserId": nullString(creatorID), "createdByEmail": nullString(creatorEmail), "ownerIsPlatformAdmin": ownerAdmin, "lastSeenAt": nullString(lastSeen), "createdAt": created})
		}
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": total, "page": p, "pageSize": n, "limits": map[string]any{"maxActiveWorkspacesPerTenant": 1, "maxActiveWorkspacesTotal": 40, "allowPortExposure": true, "allowContainerAllocate": false, "allowArchive": false}})
}

func (a *routes) patchRunner(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IsShared *bool `json:"isShared"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.IsShared == nil {
		httpx.Error(w, 400, "isShared boolean required")
		return
	}
	id := chi.URLParam(r, "id")
	res, err := a.d.DB.ExecContext(r.Context(), a.q(`UPDATE runtime_nodes SET is_shared=?,updated_at=? WHERE id=? AND kind<>'local'`), *body.IsShared, a.now(), id)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	count, _ := res.RowsAffected()
	if count != 1 {
		httpx.Error(w, 404, "runner not found")
		return
	}
	var name, tenantID string
	var creator sql.NullString
	_ = a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT name,tenant_id,created_by_user_id FROM runtime_nodes WHERE id=?`), id).Scan(&name, &tenantID, &creator)
	httpx.JSON(w, 200, map[string]any{"runner": map[string]any{"id": id, "name": name, "tenantId": tenantID, "isShared": *body.IsShared, "createdByUserId": nullString(creator)}})
}

func (a *routes) platform(w http.ResponseWriter, r *http.Request) {
	var setup bool
	var mode, version string
	if a.d.DB.QueryRowContext(r.Context(), `SELECT setup_completed,mode,version FROM platform_meta WHERE singleton=1`).Scan(&setup, &mode, &version) != nil {
		mode = map[bool]string{true: "multi-tenant", false: "single-tenant"}[a.d.MultiTenant]
		version = "go-rewrite"
	}
	httpx.JSON(w, 200, map[string]any{"setupCompleted": setup, "mode": mode, "multiTenant": a.d.MultiTenant, "edition": a.d.Edition, "version": version})
}
func (a *routes) patchPlatform(w http.ResponseWriter, r *http.Request) {
	httpx.Error(w, 400, "Deployment mode is set by environment (ZAKURA_EDITION)")
}
func (a *routes) agentDefaults(w http.ResponseWriter, r *http.Request) {
	a.setting(w, r, "agent_defaults", nil)
}
func (a *routes) putAgentDefaults(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if httpx.DecodeJSON(r, &body) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	a.setting(w, r, "agent_defaults", body)
}
func (a *routes) setting(w http.ResponseWriter, r *http.Request, key string, value map[string]any) {
	if value != nil {
		raw, _ := json.Marshal(value)
		_, err := a.d.DB.ExecContext(r.Context(), a.q(`INSERT INTO settings(id,owner_key,key,value) VALUES(?,'platform',?,?) ON CONFLICT(owner_key,key) DO UPDATE SET value=excluded.value`), a.d.NewID(), key, string(raw))
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
	}
	var raw string
	if a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT value FROM settings WHERE owner_key='platform' AND key=?`), key).Scan(&raw) != nil {
		raw = "{}"
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	httpx.JSON(w, 200, out)
}
func (a *routes) oauthClients(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	tenantID := strings.TrimSpace(r.URL.Query().Get("tenantId"))
	if tenantID == "" {
		tenantID = p.TenantID
	}
	var exists int
	if err := a.d.DB.QueryRowContext(r.Context(), a.q(`SELECT COUNT(*) FROM tenants WHERE id=?`), tenantID).Scan(&exists); err != nil || exists == 0 {
		httpx.Error(w, 404, "Tenant not found")
		return
	}
	direction := r.URL.Query().Get("direction")
	if direction == "" {
		direction = "all"
	}
	if direction != "all" && direction != "inbound" && direction != "outbound" {
		httpx.Error(w, 400, "direction must be all, inbound or outbound")
		return
	}
	adminPage, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if adminPage < 1 {
		adminPage = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	needle := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	items := []map[string]any{}
	if direction != "outbound" {
		rows, err := a.d.DB.QueryContext(r.Context(), a.q(`SELECT DISTINCT c.id,c.client_id,c.client_name,c.token_endpoint_auth_method,c.registration_type,c.redirect_uris_json,c.scope,c.tenant_id,c.created_at
			FROM oauth_clients c
			WHERE c.tenant_id=? OR (c.tenant_id IS NULL AND (EXISTS(SELECT 1 FROM oauth_refresh_tokens rt WHERE rt.tenant_id=? AND rt.client_id=c.client_id) OR EXISTS(SELECT 1 FROM oauth_auth_codes ac WHERE ac.tenant_id=? AND ac.client_id=c.client_id)))`), tenantID, tenantID, tenantID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		for rows.Next() {
			var id, clientID, name, authMethod, registrationType, redirects, scope, created string
			var boundTenant sql.NullString
			if rows.Scan(&id, &clientID, &name, &authMethod, &registrationType, &redirects, &scope, &boundTenant, &created) == nil {
				items = append(items, map[string]any{"id": id, "clientId": clientID, "clientName": name, "tokenEndpointAuthMethod": authMethod, "registrationType": registrationType, "redirectUris": decodeArray(redirects), "scope": scope, "tenantBound": boundTenant.Valid && boundTenant.String == tenantID, "createdAt": created, "direction": "inbound"})
			}
		}
		rows.Close()
	}
	if direction != "inbound" {
		rows, err := a.d.DB.QueryContext(r.Context(), a.q(`SELECT id,mcp_url,host,client_id,client_name,source,secret_enc,registration_endpoint,scope,instance_id,created_at,updated_at FROM upstream_oauth_clients WHERE tenant_id=?`), tenantID)
		if err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		for rows.Next() {
			var id, mcpURL, host, clientID, name, source, secret, scope, created, updated string
			var registrationEndpoint, instanceID sql.NullString
			if rows.Scan(&id, &mcpURL, &host, &clientID, &name, &source, &secret, &registrationEndpoint, &scope, &instanceID, &created, &updated) == nil {
				items = append(items, map[string]any{"id": id, "mcpUrl": mcpURL, "host": host, "clientId": clientID, "clientName": name, "source": source, "hasSecret": secret != "", "registrationEndpoint": nullString(registrationEndpoint), "scope": scope, "instanceId": nullString(instanceID), "createdAt": created, "updatedAt": updated, "direction": "outbound"})
			}
		}
		rows.Close()
	}
	if needle != "" {
		filtered := items[:0]
		for _, item := range items {
			matched := false
			for _, value := range item {
				if text, ok := value.(string); ok && strings.Contains(strings.ToLower(text), needle) {
					matched = true
					break
				}
			}
			if matched {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	sort.SliceStable(items, func(i, j int) bool {
		left := strings.TrimSpace(asString(items[i]["createdAt"]))
		if left == "" {
			left = asString(items[i]["id"])
		}
		right := strings.TrimSpace(asString(items[j]["createdAt"]))
		if right == "" {
			right = asString(items[j]["id"])
		}
		return left > right
	})
	total := len(items)
	start := (adminPage - 1) * pageSize
	if start > total {
		start = total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	httpx.JSON(w, 200, map[string]any{"items": items[start:end], "total": total, "page": adminPage, "pageSize": pageSize, "tenantId": tenantID})
}
func (a *routes) deleteOAuthClient(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	tenantID := strings.TrimSpace(r.URL.Query().Get("tenantId"))
	if tenantID == "" {
		tenantID = p.TenantID
	}
	direction := chi.URLParam(r, "direction")
	if direction != "inbound" && direction != "outbound" {
		httpx.Error(w, 400, "direction must be inbound or outbound")
		return
	}
	id := chi.URLParam(r, "id")
	var removed bool
	err := appdeps.InTx(r.Context(), a.d.DB, func(tx *sql.Tx) error {
		if direction == "outbound" {
			res, e := tx.ExecContext(r.Context(), a.q(`DELETE FROM upstream_oauth_clients WHERE id=? AND tenant_id=?`), id, tenantID)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			removed = n > 0
			return nil
		}
		var clientID string
		var boundTenant sql.NullString
		if e := tx.QueryRowContext(r.Context(), a.q(`SELECT client_id,tenant_id FROM oauth_clients WHERE id=?`), id).Scan(&clientID, &boundTenant); e != nil {
			if errors.Is(e, sql.ErrNoRows) {
				return nil
			}
			return e
		}
		if boundTenant.Valid {
			if boundTenant.String != tenantID {
				return nil
			}
			res, e := tx.ExecContext(r.Context(), a.q(`DELETE FROM oauth_clients WHERE id=? AND tenant_id=?`), id, tenantID)
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			removed = n > 0
			return nil
		}
		refresh, e := tx.ExecContext(r.Context(), a.q(`DELETE FROM oauth_refresh_tokens WHERE tenant_id=? AND client_id=?`), tenantID, clientID)
		if e != nil {
			return e
		}
		codes, e := tx.ExecContext(r.Context(), a.q(`DELETE FROM oauth_auth_codes WHERE tenant_id=? AND client_id=?`), tenantID, clientID)
		if e != nil {
			return e
		}
		n1, _ := refresh.RowsAffected()
		n2, _ := codes.RowsAffected()
		removed = n1+n2 > 0
		return nil
	})
	if err != nil {
		httpx.Error(w, 500, "revoke failed")
		return
	}
	if !removed {
		httpx.Error(w, 404, "OAuth client not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func boolInt(v bool) bool { return v }
func nullIfActive(status, now string) any {
	if status == "active" {
		return nil
	}
	return now
}
func nullIfBlank(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
func adminSlug(value string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		return "workspace"
	}
	return result
}
func nullString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
func decodeArray(raw string) []any {
	var v []any
	_ = json.Unmarshal([]byte(raw), &v)
	if v == nil {
		v = []any{}
	}
	return v
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}
