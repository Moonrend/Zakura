package identity

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"

	"gorm.io/gorm"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
)

type oauthSigningKey struct {
	Kid     string          `json:"kid"`
	PEM     string          `json:"privateKeyPem"`
	Private *rsa.PrivateKey `json:"-"`
}

func (s *Service) signingKey(ctx context.Context) (*oauthSigningKey, error) {
	s.oauthKeyOnce.Do(func() { s.oauthKey, s.oauthKeyErr = s.loadOrCreateSigningKey(ctx) })
	return s.oauthKey, s.oauthKeyErr
}

func (s *Service) loadOrCreateSigningKey(ctx context.Context) (*oauthSigningKey, error) {
	var setting models.Setting
	if err := s.gdb(ctx).Where("owner_key = ? AND key = ?", "platform", "oauth_signing_key").Take(&setting).Error; err == nil {
		opened, openErr := open(s.deps.Secret, setting.Value)
		if openErr != nil {
			return nil, openErr
		}
		return parseStoredSigningKey(opened)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	var candidate *oauthSigningKey
	// Import the pinned TypeScript key on first Go startup so already-issued
	// RS256 tokens and external JWKS caches survive the backend migration.
	if s.deps.DataDir != "" {
		raw, err := os.ReadFile(filepath.Join(s.deps.DataDir, "oauth-signing.json"))
		if err == nil {
			candidate, err = parseStoredSigningKey(raw)
			if err != nil {
				return nil, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	if candidate == nil {
		privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		kidRaw := make([]byte, 8)
		if _, err = rand.Read(kidRaw); err != nil {
			return nil, err
		}
		privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
		if err != nil {
			return nil, err
		}
		candidate = &oauthSigningKey{Kid: "zakura-" + hex.EncodeToString(kidRaw), PEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})), Private: privateKey}
	}
	plain, _ := json.Marshal(map[string]string{"kid": candidate.Kid, "privateKeyPem": candidate.PEM})
	enc, err := seal(s.deps.Secret, plain)
	if err != nil {
		return nil, err
	}
	var stored string
	err = appdepsInIdentityTx(ctx, s.deps.DB, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, s.q(`INSERT INTO settings(id,owner_key,key,value) VALUES(?,'platform','oauth_signing_key',?) ON CONFLICT(owner_key,key) DO NOTHING`), s.deps.NewID(), enc); e != nil {
			return e
		}
		return tx.QueryRowContext(ctx, s.q(`SELECT value FROM settings WHERE owner_key='platform' AND key='oauth_signing_key'`)).Scan(&stored)
	})
	if err != nil {
		return nil, err
	}
	opened, err := open(s.deps.Secret, stored)
	if err != nil {
		return nil, err
	}
	return parseStoredSigningKey(opened)
}

// Kept local to avoid introducing another package edge in the key loader.
func appdepsInIdentityTx(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err = fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func parseStoredSigningKey(raw []byte) (*oauthSigningKey, error) {
	var stored struct {
		Kid           string `json:"kid"`
		PrivateKeyPEM string `json:"privateKeyPem"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil || strings.TrimSpace(stored.Kid) == "" || strings.TrimSpace(stored.PrivateKeyPEM) == "" {
		return nil, errors.New("invalid OAuth signing-key document")
	}
	block, _ := pem.Decode([]byte(stored.PrivateKeyPEM))
	if block == nil {
		return nil, errors.New("invalid OAuth private key PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		if pkcs1, pkcs1Err := x509.ParsePKCS1PrivateKey(block.Bytes); pkcs1Err == nil {
			return &oauthSigningKey{Kid: stored.Kid, PEM: stored.PrivateKeyPEM, Private: pkcs1}, nil
		}
		return nil, err
	}
	privateKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("OAuth signing key is not RSA")
	}
	return &oauthSigningKey{Kid: stored.Kid, PEM: stored.PrivateKeyPEM, Private: privateKey}, nil
}

func rsaPublicJWK(key *oauthSigningKey) map[string]any {
	e := big.NewInt(int64(key.Private.PublicKey.E)).Bytes()
	return map[string]any{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": key.Kid,
		"n": base64.RawURLEncoding.EncodeToString(key.Private.PublicKey.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(e),
	}
}
