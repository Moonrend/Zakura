package computers

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const credentialVersion = "computer-v1."

// credentialCipher is deliberately independent from legacy unscoped envelopes.
func credentialCipher(key []byte) (cipher.AEAD, error) {
	if len(key) == 0 {
		return nil, errors.New("computer encryption key is missing")
	}
	derived, err := scrypt.Key(key, []byte("zakura-computer-credentials-v1"), 16384, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func credentialIdentity(tenant, space, computer string) ([]byte, error) {
	if tenant == "" || space == "" || computer == "" {
		return nil, errors.New("credential identity is incomplete")
	}
	return json.Marshal([]string{tenant, space, computer})
}

// SealCredentials binds write-only configuration to its complete ownership identity.
func SealCredentials(key []byte, tenant, space, computer string, plain []byte) (string, error) {
	aad, err := credentialIdentity(tenant, space, computer)
	if err != nil {
		return "", err
	}
	if !json.Valid(plain) {
		return "", errors.New("configuration must be JSON")
	}
	g, err := credentialCipher(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	payload := g.Seal(nonce, nonce, plain, aad)
	return credentialVersion + base64.RawURLEncoding.EncodeToString(payload), nil
}

// OpenCredentials never falls back to legacy encryption or a different identity.
func OpenCredentials(key []byte, tenant, space, computer, envelope string) ([]byte, error) {
	aad, err := credentialIdentity(tenant, space, computer)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(envelope, credentialVersion) {
		return nil, errors.New("unsupported computer credential envelope")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(envelope, credentialVersion))
	if err != nil {
		return nil, errors.New("invalid computer credential envelope")
	}
	g, err := credentialCipher(key)
	if err != nil {
		return nil, err
	}
	if len(payload) < g.NonceSize()+g.Overhead() {
		return nil, errors.New("invalid computer credential envelope")
	}
	return g.Open(nil, payload[:g.NonceSize()], payload[g.NonceSize():], aad)
}
