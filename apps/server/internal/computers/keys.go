package computers

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
)

// GenerateSSHPrivateKey returns a fresh ed25519 identity as PKCS#8 PEM, the form
// ssh.ParsePrivateKey consumes. Key material is returned, never logged.
func GenerateSSHPrivateKey() (string, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}
