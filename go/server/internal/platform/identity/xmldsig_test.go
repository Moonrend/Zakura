package identity

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestVerifySAMLSignatureRejectsTampering(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	certDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fake IdP"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fake IdP"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature}, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}))
	assertion := `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assert"><saml:Issuer>https://idp.example</saml:Issuer><saml:Subject><saml:NameID>user@example.com</saml:NameID></saml:Subject></saml:Assertion>`
	digest := sha256.Sum256([]byte(assertion))
	signedInfo := fmt.Sprintf(`<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod><ds:Reference URI="#_assert"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>%s</ds:DigestValue></ds:Reference></ds:SignedInfo>`, base64.StdEncoding.EncodeToString(digest[:]))
	signedHash := sha256.Sum256([]byte(signedInfo))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, signedHash[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` + signedInfo + `<ds:SignatureValue>` + base64.StdEncoding.EncodeToString(signature) + `</ds:SignatureValue></ds:Signature>`
	signedAssertion := `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assert"><saml:Issuer>https://idp.example</saml:Issuer>` + sig + `<saml:Subject><saml:NameID>user@example.com</saml:NameID></saml:Subject></saml:Assertion>`
	doc := `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response">` + signedAssertion + `</samlp:Response>`
	root, err := parseXMLDocument([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	target, err := verifySAMLSignature(root, cert)
	if err != nil {
		t.Fatal(err)
	}
	if target.Local != "Assertion" {
		t.Fatalf("signed target=%s", target.Local)
	}
	tampered := strings.Replace(doc, "user@example.com", "attacker@example.com", 1)
	root, err = parseXMLDocument([]byte(tampered))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = verifySAMLSignature(root, cert); err == nil {
		t.Fatal("tampered assertion accepted")
	}
}
