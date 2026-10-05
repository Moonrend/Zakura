package identity

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"testing"

	"golang.org/x/crypto/scrypt"
)

func TestPinnedTypeScriptSecretCompatibility(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	legacy := pinnedCiphertext(t, secret, []byte(`"provider-secret"`), []byte("123456789012"))
	plain, err := open(secret, legacy)
	if err != nil || string(plain) != "provider-secret" {
		t.Fatalf("read pinned ciphertext: plain=%q err=%v", plain, err)
	}
	written, err := seal(secret, []byte(`{"secret":"provider-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := pinnedPlaintext(secret, written)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err = json.Unmarshal(raw, &decoded); err != nil || decoded["secret"] != "provider-secret" {
		t.Fatalf("ciphertext is not TypeScript-compatible JSON: %q err=%v", raw, err)
	}
}

func pinnedCiphertext(t *testing.T, secret, plain, nonce []byte) string {
	t.Helper()
	key, err := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	sealed := gcm.Seal(nil, nonce, plain, nil)
	ciphertext, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	return base64.RawURLEncoding.EncodeToString(append(append(append([]byte{}, nonce...), tag...), ciphertext...))
}

func pinnedPlaintext(secret []byte, encoded string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	key, err := scrypt.Key(secret, []byte("zakura-v1"), 16384, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, raw[:12], append(append([]byte{}, raw[28:]...), raw[12:28]...), nil)
}
