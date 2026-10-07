package computers

import (
	"bytes"
	"testing"
)

func TestCredentialsIdentityAndTampering(t *testing.T) {
	key := []byte("test-only-encryption-key")
	plain := []byte(`{"apiKey":"secret"}`)
	sealed, err := SealCredentials(key, "tenant", "space", "computer", plain)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := OpenCredentials(key, "tenant", "space", "computer", sealed)
	if err != nil || !bytes.Equal(opened, plain) {
		t.Fatalf("roundtrip: %v", err)
	}
	for _, ids := range [][3]string{{"other", "space", "computer"}, {"tenant", "other", "computer"}, {"tenant", "space", "other"}, {"", "space", "computer"}} {
		if _, err := OpenCredentials(key, ids[0], ids[1], ids[2], sealed); err == nil {
			t.Fatalf("identity substitution accepted: %v", ids)
		}
	}
	for _, value := range []string{"legacy", "computer-v1.AA", sealed[:len(sealed)-4] + "AAAA"} {
		if _, err := OpenCredentials(key, "tenant", "space", "computer", value); err == nil {
			t.Fatal("corrupt envelope accepted")
		}
	}
	if _, err := OpenCredentials([]byte("wrong"), "tenant", "space", "computer", sealed); err == nil {
		t.Fatal("wrong key accepted")
	}
	second, err := SealCredentials(key, "tenant", "space", "computer", plain)
	if err != nil || second == sealed {
		t.Fatal("nonce not randomized")
	}
	if _, err := SealCredentials(nil, "tenant", "space", "computer", plain); err == nil {
		t.Fatal("empty key accepted")
	}
}
