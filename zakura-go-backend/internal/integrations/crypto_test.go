// SPDX-License-Identifier: AGPL-3.0-or-later
package integrations

import (
	"strings"
	"testing"
)

func TestCryptoReadsPinnedTypeScriptVector(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	const fixture = "AAECAwQFBgcICQoL3xct12k2olZPFCbojnfGskr6xzige57j35GKrtdKHFwFofOPiABvDDK1l9R79ijeuxH4"
	plain, err := decrypt(secret, "connector:any", fixture)
	if err != nil || string(plain) != `{"apiKey":"sk-test","enabled":true}` {
		t.Fatalf("decrypt vector: %q %v", plain, err)
	}
	encoded, err := encrypt(secret, "connector:any", []byte(`{"ok":true}`))
	if err != nil || strings.HasPrefix(encoded, "v1.") {
		t.Fatalf("pinned write: %q %v", encoded, err)
	}
	plain, err = decrypt(secret, "different-scope", encoded)
	if err != nil || string(plain) != `{"ok":true}` {
		t.Fatalf("round trip: %q %v", plain, err)
	}
}
