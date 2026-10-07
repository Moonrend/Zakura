package identity

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
)

func (s *Service) changeMyEmail(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	if p.APIKey {
		httpx.Error(w, 403, "API keys cannot change email")
		return
	}
	var b struct {
		NewEmail        string `json:"newEmail"`
		CurrentPassword string `json:"currentPassword"`
	}
	if httpx.DecodeJSON(r, &b) != nil {
		httpx.Error(w, 400, "invalid request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(b.NewEmail))
	if !validEmail(email) {
		httpx.Error(w, 400, "invalid email")
		return
	}
	var account models.User
	if err := s.gdb(r.Context()).Select("email,password_hash").Where("id = ?", p.UserID).Take(&account).Error; err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	if hash := derefString(account.PasswordHash); hash != "" {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(b.CurrentPassword)) != nil {
			httpx.Error(w, 400, "current password is incorrect")
			return
		}
	}
	if strings.EqualFold(email, account.Email) {
		httpx.Error(w, 400, "email unchanged")
		return
	}
	var taken int64
	if err := s.gdb(r.Context()).Model(&models.User{}).Where("email = ? AND id <> ?", email, p.UserID).Count(&taken).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	if taken > 0 {
		httpx.Error(w, 400, "email already in use")
		return
	}
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(r.Context(), s.q(`UPDATE users SET email=?,email_verified_at=NULL,updated_at=? WHERE id=?`), email, s.now(), p.UserID); e != nil {
			return e
		}
		return s.appendAuditTx(r.Context(), tx, p.TenantID, "auth.email_change", p.UserID, "user", p.UserID, nil)
	})
	if err != nil {
		httpx.Error(w, 500, "update failed")
		return
	}
	sent, _ := s.sendVerificationEmail(r.Context(), p.UserID, email)
	httpx.JSON(w, 200, map[string]any{"ok": true, "sent": sent})
}

func (s *Service) listMyOAuthIdentities(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	var rows []struct {
		ID             string  `gorm:"column:id"`
		Provider       string  `gorm:"column:provider"`
		ProviderUserID string  `gorm:"column:provider_user_id"`
		ProfileJSON    *string `gorm:"column:profile_json"`
		CreatedAt      string  `gorm:"column:created_at"`
	}
	if err := s.gdb(r.Context()).Table("oauth_identities").
		Select("id,provider,provider_user_id,profile_json,created_at").
		Where("user_id = ?", p.UserID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	items := []map[string]any{}
	for _, row := range rows {
		var emailValue, nameValue *string
		if row.ProfileJSON != nil && strings.TrimSpace(*row.ProfileJSON) != "" {
			var profile map[string]any
			if json.Unmarshal([]byte(*row.ProfileJSON), &profile) == nil {
				if v := strings.TrimSpace(stringAny(profile["email"])); v != "" {
					emailValue = &v
				}
				if v := firstText(stringAny(profile["name"]), stringAny(profile["login"])); v != "" {
					nameValue = &v
				}
			}
		}
		items = append(items, map[string]any{"id": row.ID, "provider": row.Provider, "providerUserId": row.ProviderUserID, "email": nullableString(emailValue), "name": nullableString(nameValue), "createdAt": row.CreatedAt})
	}
	httpx.JSON(w, 200, map[string]any{"identities": items})
}

func (s *Service) unlinkMyOAuthIdentity(w http.ResponseWriter, r *http.Request) {
	p, _ := httpx.PrincipalFrom(r.Context())
	id := httpx.Param(r, "id")
	var identity models.OauthIdentity
	if err := s.gdb(r.Context()).Where("id = ? AND user_id = ?", id, p.UserID).Take(&identity).Error; err != nil {
		httpx.Error(w, 404, "not found")
		return
	}
	var account models.User
	var passwordHash *string
	if err := s.gdb(r.Context()).Select("password_hash").Where("id = ?", p.UserID).Take(&account).Error; err == nil {
		passwordHash = account.PasswordHash
	}
	var others int64
	if err := s.gdb(r.Context()).Model(&models.OauthIdentity{}).Where("user_id = ? AND id <> ?", p.UserID, id).Count(&others).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	var credentials int64
	if err := s.gdb(r.Context()).Model(&models.UserWebauthnCredential{}).Where("user_id = ?", p.UserID).Count(&credentials).Error; err != nil {
		httpx.Error(w, 500, "query failed")
		return
	}
	if derefString(passwordHash) == "" && others == 0 && credentials == 0 {
		httpx.Error(w, 400, "set a password before unlinking your last login method")
		return
	}
	err := appdeps.InTx(r.Context(), s.deps.DB, func(tx *sql.Tx) error {
		res, e := tx.ExecContext(r.Context(), s.q(`DELETE FROM oauth_identities WHERE id=? AND user_id=?`), id, p.UserID)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return sql.ErrNoRows
		}
		return s.appendAuditTx(r.Context(), tx, p.TenantID, "auth.oauth_unlink", p.UserID, "user", p.UserID, nil)
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, 404, "not found")
			return
		}
		httpx.Error(w, 500, "delete failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
