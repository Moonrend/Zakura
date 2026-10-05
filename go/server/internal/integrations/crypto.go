// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"golang.org/x/crypto/scrypt"
)

func encrypt(secret []byte, scope string, plain []byte) (string, error) {
	_ = scope
	key, e := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if e != nil {
		return "", e
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return "", e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, e = io.ReadFull(rand.Reader, nonce); e != nil {
		return "", e
	}
	jsonPlain := plain
	if !json.Valid(jsonPlain) {
		jsonPlain, _ = json.Marshal(string(plain))
	}
	sealed := gcm.Seal(nil, nonce, jsonPlain, nil)
	ciphertext, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	payload := append(append(append([]byte{}, nonce...), tag...), ciphertext...)
	return base64.RawURLEncoding.EncodeToString(payload), nil
}
func decrypt(secret []byte, scope, value string) ([]byte, error) {
	if strings.HasPrefix(value, "v1.") {
		return decryptEarlyGo(secret, scope, value)
	}
	payload, e := base64.RawURLEncoding.DecodeString(value)
	if e != nil || len(payload) < 28 {
		return nil, errors.New("truncated encrypted value")
	}
	key, e := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if e != nil {
		return nil, e
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	nonce, tag, ciphertext := payload[:12], payload[12:28], payload[28:]
	sealed := append(append([]byte{}, ciphertext...), tag...)
	plain, e := gcm.Open(nil, nonce, sealed, nil)
	if e != nil {
		return nil, e
	}
	var stringValue string
	if json.Unmarshal(plain, &stringValue) == nil {
		return []byte(stringValue), nil
	}
	return plain, nil
}

func decryptEarlyGo(secret []byte, scope, value string) ([]byte, error) {
	raw, e := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, "v1."))
	if e != nil {
		return nil, e
	}
	key := sha256.Sum256(append(append([]byte{}, secret...), []byte(scope)...))
	block, e := aes.NewCipher(key[:])
	if e != nil {
		return nil, e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	if len(raw) < gcm.NonceSize() {
		return nil, errors.New("truncated encrypted value")
	}
	return gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], []byte(scope))
}
