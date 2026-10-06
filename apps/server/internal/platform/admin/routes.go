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
	"gorm.io/gorm/clause"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
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
	ctx := r.Context()
	since := a.d.Clock().UTC().Add(-7 * 24 * time.Hour).Format(time.RFC3339Nano)
	var userTotal, userSuspended, userAdmins, userNew int64
	var tenantTotal, tenantSuspended, tenantNew int64
	var runnerTotal, runnerShared, runnerOnline int
	_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Count(&userTotal)
	_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Where("suspended_at IS NOT NULL").Count(&userSuspended)
	_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Where("is_platform_admin=TRUE").Count(&userAdmins)
	_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Where("created_at>=?", since).Count(&userNew)
	_ = a.d.Gorm.WithContext(ctx).Model(&models.Tenant{}).Count(&tenantTotal)
	_ = a.d.Gorm.WithContext(ctx).Model(&models.Tenant{}).Where("suspended_at IS NOT NULL").Count(&tenantSuspended)
	_ = a.d.Gorm.WithContext(ctx).Model(&models.Tenant{}).Where("created_at>=?", since).Count(&tenantNew)
	_ = a.d.Gorm.WithContext(ctx).Raw(`SELECT COUNT(*),COALESCE(SUM(CASE WHEN is_shared THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN status IN ('online','ready') THEN 1 ELSE 0 END),0) FROM runtime_nodes WHERE kind<>'local'`).Row().Scan(&runnerTotal, &runnerShared, &runnerOnline)
	httpx.JSON(w, 200, map[string]any{
		"users":   map[string]int{"total": int(userTotal), "suspended": int(userSuspended), "admins": int(userAdmins), "newLast7d": int(userNew)},
		"tenants": map[string]int{"total": int(tenantTotal), "suspended": int(tenantSuspended), "newLast7d": int(tenantNew)},
		"runners": map[string]int{"total": runnerTotal, "shared": runnerShared, "online": runnerOnline},
	})
}
func (a *routes) users(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, n := page(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pattern := likePattern(q)
	statusFilter := r.URL.Query().Get("status")
	roleFilter := r.URL.Query().Get("role")
	clauses := []string{`(?='' OR LOWER(email) LIKE ? ESCAPE '\' OR LOWER(COALESCE(name,'')) LIKE ? ESCAPE '\')`}
	args := []any{q, pattern, pattern}
	if statusFilter == "suspended" {
		clauses = append(clauses, `suspended_at IS NOT NULL`)
	} else if statusFilter == "active" {
		clauses = append(clauses, `suspended_at IS NULL`)
	}
	if roleFilter == "admin" {
		clauses = append(clauses, `is_platform_admin=TRUE`)
	} else if roleFilter == "user" {
		clauses = append(clauses, `is_platform_admin=FALSE`)
	}
	if tenantID := strings.TrimSpace(r.URL.Query().Get("tenantId")); tenantID != "" {
		clauses = append(clauses, `EXISTS(SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=users.id AND tm.tenant_id=? AND tm.status='active')`)
		args = append(args, tenantID)
	}
	where := strings.Join(clauses, " AND ")
	var total int64
	_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Where(where, args...).Count(&total)
	order := listOrder(r, map[string]string{"email": "email", "name": "name", "createdAt": "created_at"}, "createdAt")
	var rows []models.User
	_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Where(where, args...).Select("id,email,name,is_platform_admin,can_use_local_runner,password_hash,suspended_at,suspended_reason,suspended_by_user_id,created_at").Order(order).Limit(n).Offset((p - 1) * n).Find(&rows)
	items := []map[string]any{}
	for _, item := range rows {
		var memberships []struct {
			TenantID string `gorm:"column:tid"`
			Slug     string `gorm:"column:slug"`
			Name     string `gorm:"column:tname"`
			Role     string `gorm:"column:role"`
		}
		_ = a.d.Gorm.WithContext(ctx).Raw(`SELECT t.id AS tid,t.slug AS slug,t.name AS tname,m.role AS role FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' ORDER BY m.created_at`, deref(item.ID)).Scan(&memberships)
		tenants := []map[string]any{}
		for _, m := range memberships {
			tenants = append(tenants, map[string]any{"tenantId": m.TenantID, "slug": m.Slug, "name": m.Name, "role": m.Role})
		}
		name := ""
		if item.Name != nil {
			name = *item.Name
		}
		password := ""
		if item.PasswordHash != nil {
			password = *item.PasswordHash
		}
		items = append(items, map[string]any{"id": deref(item.ID), "email": item.Email, "name": nullIfBlank(name), "isPlatformAdmin": item.IsPlatformAdmin, "canUseLocalRunner": item.CanUseLocalRunner || item.IsPlatformAdmin, "hasPassword": password != "", "tenants": tenants, "createdAt": item.CreatedAt, "suspended": item.SuspendedAt != nil, "suspendedAt": nullStringPtr(item.SuspendedAt), "suspendedReason": nullStringPtr(item.SuspendedReason), "suspendedByUserId": nullStringPtr(item.SuspendedByUserID)})
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": int(total), "page": p, "pageSize": n})
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
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	var u models.User
	if a.d.Gorm.WithContext(ctx).Where("id=?", id).Take(&u).Error != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	var membershipRows []struct {
		MembershipID    string  `gorm:"column:mid"`
		Role            string  `gorm:"column:mrole"`
		Status          string  `gorm:"column:mstatus"`
		Joined          string  `gorm:"column:joined"`
		TenantID        string  `gorm:"column:tid"`
		Slug            string  `gorm:"column:slug"`
		Name            string  `gorm:"column:tname"`
		TenantSuspended *string `gorm:"column:tenant_suspended"`
	}
	_ = a.d.Gorm.WithContext(ctx).Raw(`SELECT m.id AS mid,m.role AS mrole,m.status AS mstatus,m.created_at AS joined,t.id AS tid,t.slug AS slug,t.name AS tname,t.suspended_at AS tenant_suspended FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? ORDER BY m.created_at`, id).Scan(&membershipRows)
	memberships := []map[string]any{}
	for _, m := range membershipRows {
		memberships = append(memberships, map[string]any{"membershipId": m.MembershipID, "role": m.Role, "status": m.Status, "joinedAt": m.Joined, "tenantId": m.TenantID, "slug": m.Slug, "name": m.Name, "tenantSuspended": m.TenantSuspended != nil})
	}
	identities := []map[string]any{}
	var identityRows []models.OauthIdentity
	_ = a.d.Gorm.WithContext(ctx).Where("user_id=?", id).Order("created_at").Find(&identityRows)
	for _, row := range identityRows {
		identities = append(identities, map[string]any{"provider": row.Provider, "createdAt": row.CreatedAt})
	}
	runners := []map[string]any{}
	var runnerRows []models.RuntimeNode
	_ = a.d.Gorm.WithContext(ctx).Where("created_by_user_id=?", id).Order("created_at").Find(&runnerRows)
	for _, row := range runnerRows {
		runners = append(runners, map[string]any{"id": deref(row.ID), "name": row.Name, "status": row.Status, "isShared": row.IsShared})
	}
	var suspendedBy any
	if u.SuspendedByUserID != nil {
		var actor models.User
		if a.d.Gorm.WithContext(ctx).Select("email").Where("id=?", *u.SuspendedByUserID).Take(&actor).Error == nil {
			suspendedBy = map[string]any{"id": *u.SuspendedByUserID, "email": actor.Email}
		}
	}
	name := ""
	if u.Name != nil {
		name = *u.Name
	}
	password := ""
	if u.PasswordHash != nil {
		password = *u.PasswordHash
	}
	httpx.JSON(w, 200, map[string]any{"user": map[string]any{"id": id, "email": u.Email, "name": nullIfBlank(name), "isPlatformAdmin": u.IsPlatformAdmin, "canUseLocalRunner": u.CanUseLocalRunner || u.IsPlatformAdmin, "hasPassword": password != "", "createdAt": u.CreatedAt, "updatedAt": u.UpdatedAt, "suspended": u.SuspendedAt != nil, "suspendedAt": nullStringPtr(u.SuspendedAt), "suspendedReason": nullStringPtr(u.SuspendedReason), "suspendedByUserId": nullStringPtr(u.SuspendedByUserID), "suspendedBy": suspendedBy}, "memberships": memberships, "identities": identities, "runners": runners})
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
	var current models.User
	if a.d.Gorm.WithContext(r.Context()).Select("name,email,is_platform_admin,can_use_local_runner,password_hash").Where("id=?", id).Take(&current).Error != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	name, email := "", current.Email
	if current.Name != nil {
		name = *current.Name
	}
	admin, runner := current.IsPlatformAdmin, current.CanUseLocalRunner
	password := ""
	if current.PasswordHash != nil {
		password = *current.PasswordHash
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
			var others int64
			_ = a.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Where("is_platform_admin=TRUE AND suspended_at IS NULL AND id<>?", id).Count(&others)
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
	err := a.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Where("id=?", id).Updates(map[string]any{"name": name, "email": email, "password_hash": password, "is_platform_admin": admin, "can_use_local_runner": runner, "updated_at": a.now()}).Error
	if err != nil {
		httpx.Error(w, 409, "update conflict")
		return
	}
	if passwordChanged {
		_ = a.d.Gorm.WithContext(r.Context()).Model(&models.UserSession{}).Where("user_id=? AND revoked_at IS NULL", id).Update("revoked_at", a.now()).Error
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
		tenantIDs := []string{}
		if queryErr := a.d.Gorm.WithContext(r.Context()).Model(&models.TenantMembership{}).Where("user_id=? AND status='active'", id).Pluck("tenant_id", &tenantIDs).Error; queryErr != nil {
			httpx.Error(w, 503, "user suspended but runtime cleanup query failed")
			return
		}
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
		orphanCandidates := []string{}
		queryErr := a.d.Gorm.WithContext(r.Context()).Model(&models.TenantMembership{}).Where("user_id=? AND role='owner' AND status='active' AND NOT EXISTS(SELECT 1 FROM tenant_memberships x WHERE x.tenant_id=tenant_memberships.tenant_id AND x.user_id<>?)", id, id).Pluck("tenant_id", &orphanCandidates).Error
		if queryErr != nil {
			httpx.Error(w, 500, "tenant cleanup query failed")
			return
		}
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
	ctx := r.Context()
	p, n := page(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pattern := likePattern(q)
	clauses := []string{`(?='' OR LOWER(t.name) LIKE ? ESCAPE '\' OR LOWER(t.slug) LIKE ? ESCAPE '\')`}
	args := []any{q, pattern, pattern}
	if status := r.URL.Query().Get("status"); status == "suspended" {
		clauses = append(clauses, `t.suspended_at IS NOT NULL`)
	} else if status == "active" {
		clauses = append(clauses, `t.suspended_at IS NULL`)
	}
	if onboarding := r.URL.Query().Get("onboarding"); onboarding == "completed" {
		clauses = append(clauses, `t.onboarding_completed=TRUE`)
	} else if onboarding == "pending" {
		clauses = append(clauses, `t.onboarding_completed=FALSE`)
	}
	where := strings.Join(clauses, " AND ")
	var total int64
	_ = a.d.Gorm.WithContext(ctx).Table("tenants t").Where(where, args...).Count(&total)
	order := listOrder(r, map[string]string{"name": "t.name", "slug": "t.slug", "createdAt": "t.created_at"}, "createdAt")
	type tenantListRow struct {
		ID                  string  `gorm:"column:id"`
		Slug                string  `gorm:"column:slug"`
		Name                string  `gorm:"column:name"`
		IsDefault           bool    `gorm:"column:is_default"`
		OnboardingCompleted bool    `gorm:"column:onboarding_completed"`
		SuspendedAt         *string `gorm:"column:suspended_at"`
		SuspendedReason     *string `gorm:"column:suspended_reason"`
		SuspendedByUserID   *string `gorm:"column:suspended_by_user_id"`
		CreatedAt           string  `gorm:"column:created_at"`
		MemberCount         int     `gorm:"column:member_count"`
	}
	var rows []tenantListRow
	listArgs := append(append([]any{}, args...), n, (p-1)*n)
	_ = a.d.Gorm.WithContext(ctx).Raw(`SELECT t.id,t.slug,t.name,t.is_default,t.onboarding_completed,t.suspended_at,t.suspended_reason,t.suspended_by_user_id,t.created_at,(SELECT COUNT(*) FROM tenant_memberships m WHERE m.tenant_id=t.id AND m.status='active') AS member_count FROM tenants t WHERE `+where+` ORDER BY `+order+` LIMIT ? OFFSET ?`, listArgs...).Scan(&rows)
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, map[string]any{"id": row.ID, "slug": row.Slug, "name": row.Name, "isDefault": row.IsDefault, "onboardingCompleted": row.OnboardingCompleted, "memberCount": row.MemberCount, "createdAt": row.CreatedAt, "suspended": row.SuspendedAt != nil, "suspendedAt": nullStringPtr(row.SuspendedAt), "suspendedReason": nullStringPtr(row.SuspendedReason), "suspendedByUserId": nullStringPtr(row.SuspendedByUserID)})
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": int(total), "page": p, "pageSize": n})
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
		var owner models.User
		if a.d.Gorm.WithContext(r.Context()).Select("id").Where("email=?", strings.ToLower(strings.TrimSpace(b.OwnerEmail))).Take(&owner).Error != nil {
			httpx.Error(w, 404, "owner email not found")
			return
		}
		ownerID = deref(owner.ID)
	}
	if ownerID == "" {
		ownerID = p.UserID
	}
	var ownerCount int64
	_ = a.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Where("id=?", ownerID).Count(&ownerCount)
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
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	var t models.Tenant
	if a.d.Gorm.WithContext(ctx).Where("id=?", id).Take(&t).Error != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	var memberRows []struct {
		MembershipID  string  `gorm:"column:mid"`
		Role          string  `gorm:"column:mrole"`
		Status        string  `gorm:"column:mstatus"`
		Joined        string  `gorm:"column:joined"`
		UserID        string  `gorm:"column:uid"`
		Email         string  `gorm:"column:email"`
		UserName      string  `gorm:"column:uname"`
		UserSuspended *string `gorm:"column:ususpended"`
		PlatformAdmin bool    `gorm:"column:platform_admin"`
	}
	_ = a.d.Gorm.WithContext(ctx).Raw(`SELECT m.id AS mid,m.role AS mrole,m.status AS mstatus,m.created_at AS joined,u.id AS uid,u.email AS email,COALESCE(u.name,'') AS uname,u.suspended_at AS ususpended,u.is_platform_admin AS platform_admin FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.created_at`, id).Scan(&memberRows)
	members := []map[string]any{}
	for _, m := range memberRows {
		members = append(members, map[string]any{"membershipId": m.MembershipID, "role": m.Role, "status": m.Status, "joinedAt": m.Joined, "user": map[string]any{"id": m.UserID, "email": m.Email, "name": nullIfBlank(m.UserName), "suspended": m.UserSuspended != nil, "isPlatformAdmin": m.PlatformAdmin}})
	}
	runners := []map[string]any{}
	var runnerRows []models.RuntimeNode
	_ = a.d.Gorm.WithContext(ctx).Where("tenant_id=?", id).Order("created_at").Find(&runnerRows)
	for _, row := range runnerRows {
		runners = append(runners, map[string]any{"id": deref(row.ID), "name": row.Name, "status": row.Status, "isShared": row.IsShared})
	}
	var suspendedBy any
	if t.SuspendedByUserID != nil {
		var actor models.User
		if a.d.Gorm.WithContext(ctx).Select("email").Where("id=?", *t.SuspendedByUserID).Take(&actor).Error == nil {
			suspendedBy = map[string]any{"id": *t.SuspendedByUserID, "email": actor.Email}
		}
	}
	httpx.JSON(w, 200, map[string]any{"tenant": map[string]any{"id": id, "slug": t.Slug, "name": t.Name, "isDefault": t.IsDefault, "onboardingCompleted": t.OnboardingCompleted, "createdAt": t.CreatedAt, "suspended": t.SuspendedAt != nil, "suspendedAt": nullStringPtr(t.SuspendedAt), "suspendedReason": nullStringPtr(t.SuspendedReason), "suspendedByUserId": nullStringPtr(t.SuspendedByUserID), "suspendedBy": suspendedBy}, "members": members, "runners": runners})
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
	var current models.Tenant
	if a.d.Gorm.WithContext(r.Context()).Select("name,slug").Where("id=?", id).Take(&current).Error != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	name, slug := current.Name, current.Slug
	if b.Name != nil {
		name = strings.TrimSpace(*b.Name)
	}
	if b.Slug != nil {
		slug = strings.TrimSpace(*b.Slug)
	}
	err := a.d.Gorm.WithContext(r.Context()).Model(&models.Tenant{}).Where("id=?", id).Updates(map[string]any{"name": name, "slug": slug, "updated_at": a.now()}).Error
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
		var current models.Tenant
		if err := a.d.Gorm.WithContext(r.Context()).Select("is_default").Where("id=?", id).Take(&current).Error; err != nil {
			httpx.Error(w, 404, "Not found")
			return
		}
		if current.IsDefault {
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
	var current models.Tenant
	if err := a.d.Gorm.WithContext(r.Context()).Select("is_default").Where("id=?", tenantID).Take(&current).Error; err != nil {
		httpx.Error(w, 404, "Not found")
		return
	}
	if current.IsDefault {
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
	var currentTenant models.Tenant
	if err := a.d.Gorm.WithContext(r.Context()).Select("status").Where("id=?", tenantID).Take(&currentTenant).Error; err != nil {
		httpx.Error(w, 404, "Not found")
		return
	}
	if currentTenant.Status != "active" {
		httpx.Error(w, 403, "tenant is suspended")
		return
	}
	b.UserID = strings.TrimSpace(b.UserID)
	if b.UserID == "" && strings.TrimSpace(b.Email) != "" {
		var owner models.User
		if err := a.d.Gorm.WithContext(r.Context()).Select("id").Where("email=?", strings.ToLower(strings.TrimSpace(b.Email))).Take(&owner).Error; err == nil {
			b.UserID = deref(owner.ID)
		}
	}
	if b.UserID == "" {
		httpx.Error(w, 404, "user not found")
		return
	}
	var userExists int64
	_ = a.d.Gorm.WithContext(r.Context()).Model(&models.User{}).Where("id=?", b.UserID).Count(&userExists)
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
	err := a.d.Gorm.WithContext(r.Context()).Create(&models.TenantMembership{ID: &id, TenantID: tenantID, UserID: b.UserID, Role: b.Role, Status: "active", CreatedAt: a.now(), UpdatedAt: a.now()}).Error
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
	ctx := r.Context()
	userID := chi.URLParam(r, "id")
	var tenantRows []struct {
		TenantID string `gorm:"column:tenant_id"`
	}
	if err := a.d.Gorm.WithContext(ctx).Raw(`SELECT m.tenant_id AS tenant_id FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' AND t.suspended_at IS NULL ORDER BY m.tenant_id`, userID).Scan(&tenantRows).Error; err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	tenants := []string{}
	for _, row := range tenantRows {
		tenants = append(tenants, row.TenantID)
	}
	if len(tenants) == 0 {
		var exists int64
		_ = a.d.Gorm.WithContext(ctx).Model(&models.User{}).Where("id=?", userID).Count(&exists)
		if exists == 0 {
			httpx.Error(w, 404, "user not found")
			return
		}
	}
	updated := 0
	for _, tenantID := range tenants {
		var agents []models.Agent
		if e := a.d.Gorm.WithContext(ctx).Select("id,config_json").Where("tenant_id=?", tenantID).Find(&agents).Error; e != nil {
			httpx.Error(w, 400, e.Error())
			return
		}
		for _, agent := range agents {
			bag := map[string]any{}
			_ = json.Unmarshal([]byte(agent.ConfigJSON), &bag)
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
			if string(next) == agent.ConfigJSON {
				continue
			}
			if e := a.d.Gorm.WithContext(ctx).Model(&models.Agent{}).Where("id=? AND tenant_id=?", deref(agent.ID), tenantID).Updates(map[string]any{"config_json": string(next), "updated_at": a.now()}).Error; e != nil {
				httpx.Error(w, 400, e.Error())
				return
			}
			updated++
		}
	}
	httpx.JSON(w, 200, map[string]any{"updated": updated, "tenants": len(tenants)})
}

func (a *routes) runners(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, n := page(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	pattern := likePattern(q)
	clauses := []string{`rn.kind<>'local'`, `(?='' OR LOWER(rn.name) LIKE ? ESCAPE '\' OR LOWER(rn.slug) LIKE ? ESCAPE '\' OR LOWER(COALESCE(t.name,'')) LIKE ? ESCAPE '\' OR LOWER(COALESCE(t.slug,'')) LIKE ? ESCAPE '\' OR LOWER(COALESCE(u.email,'')) LIKE ? ESCAPE '\')`}
	args := []any{q, pattern, pattern, pattern, pattern, pattern}
	if status := r.URL.Query().Get("status"); status != "" && status != "all" {
		clauses = append(clauses, `rn.status=?`)
		args = append(args, status)
	}
	if shared := r.URL.Query().Get("shared"); shared == "shared" {
		clauses = append(clauses, `rn.is_shared=TRUE`)
	} else if shared == "private" {
		clauses = append(clauses, `rn.is_shared=FALSE`)
	}
	where := strings.Join(clauses, " AND ")
	query := a.d.Gorm.WithContext(ctx).Table("runtime_nodes rn").Joins("LEFT JOIN tenants t ON t.id=rn.tenant_id").Joins("LEFT JOIN users u ON u.id=rn.created_by_user_id").Where(where, args...)
	var total int64
	_ = query.Count(&total)
	order := listOrder(r, map[string]string{"name": "rn.name", "status": "rn.status", "createdAt": "rn.created_at", "lastSeenAt": "rn.last_seen_at"}, "createdAt")
	type runnerRow struct {
		ID                   string  `gorm:"column:id"`
		Name                 string  `gorm:"column:name"`
		Slug                 string  `gorm:"column:slug"`
		Status               string  `gorm:"column:status"`
		IsShared             bool    `gorm:"column:is_shared"`
		TenantID             string  `gorm:"column:tenant_id"`
		TenantSlug           *string `gorm:"column:tenant_slug"`
		TenantName           *string `gorm:"column:tenant_name"`
		CreatedByUserID      *string `gorm:"column:created_by_user_id"`
		CreatedByEmail       *string `gorm:"column:creator_email"`
		OwnerIsPlatformAdmin bool    `gorm:"column:owner_admin"`
		LastSeenAt           *string `gorm:"column:last_seen_at"`
		CreatedAt            string  `gorm:"column:created_at"`
	}
	var rows []runnerRow
	_ = query.Select("rn.id,rn.name,rn.slug,rn.status,rn.is_shared,rn.tenant_id,t.slug AS tenant_slug,t.name AS tenant_name,rn.created_by_user_id,u.email AS creator_email,COALESCE(u.is_platform_admin,FALSE) AS owner_admin,rn.last_seen_at,rn.created_at").Order(order).Limit(n).Offset((p - 1) * n).Find(&rows)
	items := []map[string]any{}
	for _, row := range rows {
		items = append(items, map[string]any{"id": row.ID, "name": row.Name, "slug": row.Slug, "status": row.Status, "isShared": row.IsShared, "tenantId": row.TenantID, "tenantSlug": nullStringPtr(row.TenantSlug), "tenantName": nullStringPtr(row.TenantName), "createdByUserId": nullStringPtr(row.CreatedByUserID), "createdByEmail": nullStringPtr(row.CreatedByEmail), "ownerIsPlatformAdmin": row.OwnerIsPlatformAdmin, "lastSeenAt": nullStringPtr(row.LastSeenAt), "createdAt": row.CreatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": int(total), "page": p, "pageSize": n, "limits": map[string]any{"maxActiveWorkspacesPerTenant": 1, "maxActiveWorkspacesTotal": 40, "allowPortExposure": true, "allowContainerAllocate": false, "allowArchive": false}})
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
	res := a.d.Gorm.WithContext(r.Context()).Model(&models.RuntimeNode{}).Where("id=? AND kind<>'local'", id).Updates(map[string]any{"is_shared": *body.IsShared, "updated_at": a.now()})
	if res.Error != nil {
		httpx.Error(w, 400, res.Error.Error())
		return
	}
	if res.RowsAffected != 1 {
		httpx.Error(w, 404, "runner not found")
		return
	}
	var runner models.RuntimeNode
	_ = a.d.Gorm.WithContext(r.Context()).Select("name,tenant_id,created_by_user_id").Where("id=?", id).Take(&runner).Error
	httpx.JSON(w, 200, map[string]any{"runner": map[string]any{"id": id, "name": runner.Name, "tenantId": runner.TenantID, "isShared": *body.IsShared, "createdByUserId": nullStringPtr(runner.CreatedByUserID)}})
}

func (a *routes) platform(w http.ResponseWriter, r *http.Request) {
	var meta models.PlatformMetum
	var setup bool
	var mode, version string
	if a.d.Gorm.WithContext(r.Context()).Where("singleton=1").Take(&meta).Error != nil {
		mode = map[bool]string{true: "multi-tenant", false: "single-tenant"}[a.d.MultiTenant]
		version = "go-rewrite"
	} else {
		setup = meta.SetupCompleted
		mode = meta.Mode
		version = meta.Version
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
		id := a.d.NewID()
		err := a.d.Gorm.WithContext(r.Context()).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "owner_key"}, {Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value"})}).Create(&models.Setting{ID: &id, OwnerKey: "platform", Key: key, Value: string(raw)}).Error
		if err != nil {
			httpx.Error(w, 500, "update failed")
			return
		}
	}
	var row models.Setting
	raw := "{}"
	if a.d.Gorm.WithContext(r.Context()).Where("owner_key='platform' AND key=?", key).Take(&row).Error == nil {
		raw = row.Value
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
	var exists int64
	if err := a.d.Gorm.WithContext(r.Context()).Model(&models.Tenant{}).Where("id=?", tenantID).Count(&exists).Error; err != nil || exists == 0 {
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
		type inboundClientRow struct {
			ID                      string  `gorm:"column:id"`
			ClientID                string  `gorm:"column:client_id"`
			ClientName              string  `gorm:"column:client_name"`
			TokenEndpointAuthMethod string  `gorm:"column:token_endpoint_auth_method"`
			RegistrationType        string  `gorm:"column:registration_type"`
			RedirectUrisJSON        string  `gorm:"column:redirect_uris_json"`
			Scope                   string  `gorm:"column:scope"`
			TenantID                *string `gorm:"column:tenant_id"`
			CreatedAt               string  `gorm:"column:created_at"`
		}
		var rows []inboundClientRow
		if err := a.d.Gorm.WithContext(r.Context()).Raw(`SELECT DISTINCT c.id,c.client_id,c.client_name,c.token_endpoint_auth_method,c.registration_type,c.redirect_uris_json,c.scope,c.tenant_id,c.created_at
			FROM oauth_clients c
			WHERE c.tenant_id=? OR (c.tenant_id IS NULL AND (EXISTS(SELECT 1 FROM oauth_refresh_tokens rt WHERE rt.tenant_id=? AND rt.client_id=c.client_id) OR EXISTS(SELECT 1 FROM oauth_auth_codes ac WHERE ac.tenant_id=? AND ac.client_id=c.client_id)))`, tenantID, tenantID, tenantID).Scan(&rows).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		for _, row := range rows {
			items = append(items, map[string]any{"id": row.ID, "clientId": row.ClientID, "clientName": row.ClientName, "tokenEndpointAuthMethod": row.TokenEndpointAuthMethod, "registrationType": row.RegistrationType, "redirectUris": decodeArray(row.RedirectUrisJSON), "scope": row.Scope, "tenantBound": row.TenantID != nil && *row.TenantID == tenantID, "createdAt": row.CreatedAt, "direction": "inbound"})
		}
	}
	if direction != "inbound" {
		var rows []models.UpstreamOauthClient
		if err := a.d.Gorm.WithContext(r.Context()).Where("tenant_id=?", tenantID).Find(&rows).Error; err != nil {
			httpx.Error(w, 500, "query failed")
			return
		}
		for _, row := range rows {
			secret := ""
			if row.SecretEnc != nil {
				secret = *row.SecretEnc
			}
			items = append(items, map[string]any{"id": deref(row.ID), "mcpUrl": row.McpURL, "host": row.Host, "clientId": row.ClientID, "clientName": row.ClientName, "source": row.Source, "hasSecret": secret != "", "registrationEndpoint": nullStringPtr(row.RegistrationEndpoint), "scope": row.Scope, "instanceId": nullStringPtr(row.InstanceID), "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt, "direction": "outbound"})
		}
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
func nullStringPtr(value *string) any {
	if value != nil {
		return *value
	}
	return nil
}
func deref(value *string) string {
	if value != nil {
		return *value
	}
	return ""
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
