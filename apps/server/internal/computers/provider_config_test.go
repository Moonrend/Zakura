package computers

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
)

func TestProviderConfiguration(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	private := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	valid := map[string]string{"host": "example.com", "user": "runner", "privateKey": private, "hostKeyFingerprint": "SHA256:" + strings.Repeat("A", 43)}
	if err := ValidateConfiguration(SSH, valid); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ key, value string }{
		{"host", "https://example.com"}, {"host", "-bad"}, {"host", "foo..com"}, {"host", "foo\nbar"},
		{"user", "-root"}, {"user", "root@host"}, {"port", "0"}, {"port", "65536"}, {"port", "abc"},
		{"privateKey", "secret-invalid"}, {"hostKeyFingerprint", "SHA256:bad"}, {"unexpected", "secret"},
	} {
		t.Run(tc.key+tc.value, func(t *testing.T) {
			config := map[string]string{}
			for k, v := range valid {
				config[k] = v
			}
			config[tc.key] = tc.value
			if err := ValidateConfiguration(SSH, config); err == nil {
				t.Fatal("accepted invalid configuration")
			} else if strings.Contains(err.Error(), "secret-invalid") {
				t.Fatal("leaked credential")
			}
		})
	}
	for _, p := range []Provider{Server, RemoteAgent, Temporary} {
		if err := ValidateConfiguration(p, nil); err != nil {
			t.Fatal(err)
		}
		if err := ValidateConfiguration(p, map[string]string{"apiKey": "secret"}); err == nil {
			t.Fatal("accepted unused secret")
		}
	}
	if err := ValidateConfiguration(E2B, map[string]string{"apiKey": "key", "template": "base"}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateConfiguration(E2B, map[string]string{"apiKey": "key"}); err == nil {
		t.Fatal("missing template accepted")
	}
	if err := ValidateConfiguration(Railway, map[string]string{"privateKey": private, "hostKeyFingerprint": valid["hostKeyFingerprint"]}); err != nil {
		t.Fatal(err)
	}
}
