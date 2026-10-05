package identity

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math/big"
	"sort"
	"strings"
)

type xmlAttr struct{ Prefix, Local, URI, Value string }
type xmlNode struct {
	Prefix, Local, URI string
	Attrs              []xmlAttr
	Children           []*xmlNode
	Parts              []any
	Parent             *xmlNode
	InScope            map[string]string
}

func parseXMLDocument(raw []byte) (*xmlNode, error) {
	d := xml.NewDecoder(bytes.NewReader(raw))
	d.Strict = true
	var root, current *xmlNode
	for {
		tok, err := d.RawToken()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			scope := map[string]string{}
			if current != nil {
				for k, v := range current.InScope {
					scope[k] = v
				}
			}
			for _, a := range t.Attr {
				if a.Name.Space == "xmlns" {
					scope[a.Name.Local] = a.Value
				} else if a.Name.Space == "" && a.Name.Local == "xmlns" {
					scope[""] = a.Value
				}
			}
			n := &xmlNode{Prefix: t.Name.Space, Local: t.Name.Local, Parent: current, InScope: scope}
			n.URI = scope[n.Prefix]
			for _, a := range t.Attr {
				if a.Name.Space == "xmlns" || a.Name.Space == "" && a.Name.Local == "xmlns" {
					continue
				}
				n.Attrs = append(n.Attrs, xmlAttr{Prefix: a.Name.Space, Local: a.Name.Local, URI: scope[a.Name.Space], Value: a.Value})
			}
			if current != nil {
				current.Children = append(current.Children, n)
				current.Parts = append(current.Parts, n)
			} else if root == nil {
				root = n
			} else {
				return nil, errors.New("multiple XML roots")
			}
			current = n
		case xml.EndElement:
			if current == nil || current.Local != t.Name.Local {
				return nil, errors.New("malformed XML nesting")
			}
			current = current.Parent
		case xml.CharData:
			if current != nil {
				current.Parts = append(current.Parts, string(t))
			}
		case xml.ProcInst:
			if current != nil {
				return nil, errors.New("processing instructions in signed XML are unsupported")
			}
		}
	}
	if root == nil || current != nil {
		return nil, errors.New("incomplete XML document")
	}
	return root, nil
}
func (n *xmlNode) attr(name string) string {
	for _, a := range n.Attrs {
		if a.Local == name {
			return a.Value
		}
	}
	return ""
}
func (n *xmlNode) first(local string) *xmlNode {
	for _, c := range n.Children {
		if c.Local == local {
			return c
		}
	}
	return nil
}
func (n *xmlNode) find(local string) *xmlNode {
	if n.Local == local {
		return n
	}
	for _, c := range n.Children {
		if x := c.find(local); x != nil {
			return x
		}
	}
	return nil
}
func (n *xmlNode) findID(id string) *xmlNode {
	if n.attr("ID") == id || n.attr("Id") == id {
		return n
	}
	for _, c := range n.Children {
		if x := c.findID(id); x != nil {
			return x
		}
	}
	return nil
}
func (n *xmlNode) text() string {
	var b strings.Builder
	for _, part := range n.Parts {
		switch v := part.(type) {
		case string:
			b.WriteString(v)
		case *xmlNode:
			b.WriteString(v.text())
		}
	}
	return strings.TrimSpace(b.String())
}

func canonicalXML(root, skip *xmlNode) ([]byte, error) {
	var b strings.Builder
	if err := renderCanonical(&b, root, map[string]string{}, skip); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}
func renderCanonical(b *strings.Builder, n *xmlNode, rendered map[string]string, skip *xmlNode) error {
	if n == skip {
		return nil
	}
	next := map[string]string{}
	for k, v := range rendered {
		next[k] = v
	}
	visible := map[string]bool{n.Prefix: true}
	if n.Prefix == "" {
		visible[""] = true
	}
	for _, a := range n.Attrs {
		if a.Prefix != "" && a.Prefix != "xml" {
			visible[a.Prefix] = true
		}
	}
	prefixes := make([]string, 0, len(visible))
	for p := range visible {
		prefixes = append(prefixes, p)
	}
	sort.Strings(prefixes)
	type orderedAttr struct{ xmlAttr }
	attrs := make([]orderedAttr, len(n.Attrs))
	for i, a := range n.Attrs {
		attrs[i] = orderedAttr{a}
	}
	sort.Slice(attrs, func(i, j int) bool {
		if attrs[i].URI == attrs[j].URI {
			return attrs[i].Local < attrs[j].Local
		}
		return attrs[i].URI < attrs[j].URI
	})
	b.WriteByte('<')
	writeQName(b, n.Prefix, n.Local)
	for _, p := range prefixes {
		uri := n.InScope[p]
		if next[p] == uri {
			continue
		}
		b.WriteByte(' ')
		if p == "" {
			b.WriteString("xmlns")
		} else {
			b.WriteString("xmlns:")
			b.WriteString(p)
		}
		b.WriteString(`="`)
		b.WriteString(escapeAttr(uri))
		b.WriteByte('"')
		next[p] = uri
	}
	for _, item := range attrs {
		a := item.xmlAttr
		b.WriteByte(' ')
		writeQName(b, a.Prefix, a.Local)
		b.WriteString(`="`)
		b.WriteString(escapeAttr(a.Value))
		b.WriteByte('"')
	}
	b.WriteByte('>')
	for _, part := range n.Parts {
		switch v := part.(type) {
		case string:
			b.WriteString(escapeText(v))
		case *xmlNode:
			if err := renderCanonical(b, v, next, skip); err != nil {
				return err
			}
		}
	}
	b.WriteString("</")
	writeQName(b, n.Prefix, n.Local)
	b.WriteByte('>')
	return nil
}
func writeQName(b *strings.Builder, prefix, local string) {
	if prefix != "" {
		b.WriteString(prefix)
		b.WriteByte(':')
	}
	b.WriteString(local)
}
func escapeAttr(v string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", "\"", "&quot;", "\t", "&#x9;", "\n", "&#xA;", "\r", "&#xD;")
	return r.Replace(v)
}
func escapeText(v string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", "\r", "&#xD;")
	return r.Replace(v)
}

func verifySAMLSignature(root *xmlNode, certificate string) (*xmlNode, error) {
	sig := root.find("Signature")
	if sig == nil {
		return nil, errors.New("SAML response is unsigned")
	}
	signedInfo := sig.first("SignedInfo")
	signatureValue := sig.first("SignatureValue")
	if signedInfo == nil || signatureValue == nil {
		return nil, errors.New("invalid XML signature")
	}
	canonMethod := signedInfo.first("CanonicalizationMethod")
	sigMethod := signedInfo.first("SignatureMethod")
	ref := signedInfo.first("Reference")
	if canonMethod == nil || sigMethod == nil || ref == nil {
		return nil, errors.New("incomplete XML signature")
	}
	if !strings.Contains(canonMethod.attr("Algorithm"), "xml-exc-c14n") {
		return nil, errors.New("only exclusive XML canonicalization is accepted")
	}
	uri := ref.attr("URI")
	if !strings.HasPrefix(uri, "#") || len(uri) < 2 {
		return nil, errors.New("signature reference must be a local ID")
	}
	target := root.findID(uri[1:])
	if target == nil {
		return nil, errors.New("signature target not found")
	}
	transforms := ref.first("Transforms")
	if transforms == nil {
		return nil, errors.New("signature transforms missing")
	}
	enveloped, exclusive := false, false
	for _, tr := range transforms.Children {
		if tr.Local != "Transform" {
			continue
		}
		alg := tr.attr("Algorithm")
		enveloped = enveloped || strings.Contains(alg, "enveloped-signature")
		exclusive = exclusive || strings.Contains(alg, "xml-exc-c14n")
	}
	if !enveloped || !exclusive {
		return nil, errors.New("unsafe XML signature transforms")
	}
	digestMethod, digestValue := ref.first("DigestMethod"), ref.first("DigestValue")
	if digestMethod == nil || digestValue == nil || !strings.Contains(digestMethod.attr("Algorithm"), "sha256") {
		return nil, errors.New("only SHA-256 SAML digests are accepted")
	}
	canonicalTarget, err := canonicalXML(target, sig)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(canonicalTarget)
	expected, err := base64.StdEncoding.DecodeString(removeSpace(digestValue.text()))
	if err != nil || subtle.ConstantTimeCompare(digest[:], expected) != 1 {
		return nil, errors.New("SAML digest mismatch")
	}
	canonicalInfo, err := canonicalXML(signedInfo, nil)
	if err != nil {
		return nil, err
	}
	signature, err := base64.StdEncoding.DecodeString(removeSpace(signatureValue.text()))
	if err != nil {
		return nil, errors.New("invalid SAML signature encoding")
	}
	cert, err := parseCertificate(certificate)
	if err != nil {
		return nil, err
	}
	alg := sigMethod.attr("Algorithm")
	var hash crypto.Hash
	var sum []byte
	switch {
	case strings.Contains(alg, "rsa-sha256") || strings.Contains(alg, "ecdsa-sha256"):
		d := sha256.Sum256(canonicalInfo)
		hash = crypto.SHA256
		sum = d[:]
	case strings.Contains(alg, "rsa-sha384") || strings.Contains(alg, "ecdsa-sha384"):
		d := sha512.Sum384(canonicalInfo)
		hash = crypto.SHA384
		sum = d[:]
	case strings.Contains(alg, "rsa-sha512") || strings.Contains(alg, "ecdsa-sha512"):
		d := sha512.Sum512(canonicalInfo)
		hash = crypto.SHA512
		sum = d[:]
	default:
		return nil, errors.New("weak or unsupported SAML signature algorithm")
	}
	switch pub := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		if err = rsa.VerifyPKCS1v15(pub, hash, sum, signature); err != nil {
			return nil, errors.New("SAML signature verification failed")
		}
	case *ecdsa.PublicKey:
		var rs struct{ R, S *big.Int }
		if _, err = asn1.Unmarshal(signature, &rs); err != nil || rs.R == nil || rs.S == nil || !ecdsa.Verify(pub, sum, rs.R, rs.S) {
			return nil, errors.New("SAML signature verification failed")
		}
	default:
		return nil, errors.New("unsupported SAML certificate key")
	}
	if target != root && target.Local != "Assertion" {
		return nil, errors.New("signature target must be Response or Assertion")
	}
	return target, nil
}
func parseCertificate(raw string) (*x509.Certificate, error) {
	data := []byte(strings.TrimSpace(raw))
	if block, _ := pem.Decode(data); block != nil {
		data = block.Bytes
	} else {
		decoded, err := base64.StdEncoding.DecodeString(removeSpace(raw))
		if err == nil {
			data = decoded
		}
	}
	cert, err := x509.ParseCertificate(data)
	if err != nil {
		return nil, fmt.Errorf("invalid SAML certificate: %w", err)
	}
	return cert, nil
}
func removeSpace(v string) string {
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, v)
}
