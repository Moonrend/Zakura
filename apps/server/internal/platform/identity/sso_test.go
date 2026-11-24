package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestOIDCSSOIdentityScopesSubjectToTenantAndTrust(t *testing.T) {
	cfg := ssoConfig{TenantID: "tenant-a", Issuer: "https://idp.example", ClientID: "client-a", JWKSURL: "https://idp.example/keys"}
	claims := jwt.MapClaims{"sub": "immutable-subject"}
	identity, err := oidcSSOIdentity(cfg, claims)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Subject != "immutable-subject" || !strings.HasPrefix(identity.Provider, "enterprise-sso:") {
		t.Fatalf("unexpected identity: %+v", identity)
	}

	otherTenant := cfg
	otherTenant.TenantID = "tenant-b"
	tenantIdentity, err := oidcSSOIdentity(otherTenant, claims)
	if err != nil {
		t.Fatal(err)
	}
	rotatedTrust := cfg
	rotatedTrust.JWKSURL = "https://rotated.example/keys"
	trustIdentity, err := oidcSSOIdentity(rotatedTrust, claims)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Provider == tenantIdentity.Provider || identity.Provider == trustIdentity.Provider {
		t.Fatal("OIDC provider namespace did not change with tenant or trust root")
	}
	if _, err = oidcSSOIdentity(cfg, jwt.MapClaims{}); err == nil {
		t.Fatal("OIDC identity without a subject was accepted")
	}
}

func TestSAMLIdentityUsesNameIDAndCertificateScope(t *testing.T) {
	assertion, err := parseXMLDocument([]byte(`<Assertion><Subject><NameID>immutable-name-id</NameID></Subject><Attribute Name="email"><AttributeValue>member@corp.example</AttributeValue></Attribute></Assertion>`))
	if err != nil {
		t.Fatal(err)
	}
	cfg := ssoConfig{TenantID: "tenant-a", IDPEntityID: "https://idp.example"}
	identity, email, _, err := samlAssertionIdentity(cfg, assertion, testSSOCertificate(t, 1))
	if err != nil {
		t.Fatal(err)
	}
	if identity.Subject != "immutable-name-id" || email != "member@corp.example" {
		t.Fatalf("SAML email replaced immutable subject: identity=%+v email=%q", identity, email)
	}

	rotated, _, _, err := samlAssertionIdentity(cfg, assertion, testSSOCertificate(t, 2))
	if err != nil {
		t.Fatal(err)
	}
	if identity.Provider == rotated.Provider {
		t.Fatal("SAML provider namespace survived certificate rotation")
	}

	withoutNameID, err := parseXMLDocument([]byte(`<Assertion><Subject></Subject><Attribute Name="email"><AttributeValue>member@corp.example</AttributeValue></Attribute></Assertion>`))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = samlAssertionIdentity(cfg, withoutNameID, nil); err == nil {
		t.Fatal("SAML email without an immutable NameID was accepted")
	}
}

func testSSOCertificate(t *testing.T, serial int64) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "SSO Test IdP"},
		NotBefore:    time.Unix(1, 0),
		NotAfter:     time.Unix(4102444800, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
