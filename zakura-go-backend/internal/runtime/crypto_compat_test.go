// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"strings"
	"testing"
)

func TestSecretBoxReadsPinnedTypeScriptVectorsAndWritesCompatibleFormat(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	vectors := []struct {
		encoded string
		want    string
	}{
		{"AAECAwQFBgcICQoL3xct12k2olZPFCbojnfGskr6xzige57j35GKrtdKHFwFofOPiABvDDK1l9R79ijeuxH4", `{"apiKey":"sk-test","enabled":true}`},
		{"AAECAwQFBgcICQoLbJrHnN74c3tS0ZI5AC9E-hOsySOsXtbsnMfduJ4", "token-value"},
	}
	for _, vector := range vectors {
		got, err := openSecretBox(secret, "ignored-by-ts-format", vector.encoded)
		if err != nil || string(got) != vector.want {
			t.Fatalf("decrypt vector: %q %v", got, err)
		}
	}
	encoded, err := secretBox(secret, "model:any", []byte("token-value"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(encoded, "v1.") {
		t.Fatalf("new writes must use pinned TS format: %s", encoded)
	}
	decoded, err := openSecretBox(secret, "different-scope", encoded)
	if err != nil || !bytes.Equal(decoded, []byte("token-value")) {
		t.Fatalf("round trip: %q %v", decoded, err)
	}
}
