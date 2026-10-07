package computers

import (
	"encoding/base64"
	"fmt"
	"net"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

// ValidateConfiguration rejects misspelled or unsupported fields rather than
// storing credentials that a provider would silently ignore. Errors never echo secrets.
func ValidateConfiguration(provider Provider, config map[string]string) error {
	required := map[Provider][]string{
		E2B: {"apiKey", "template"}, SSH: {"host", "user", "privateKey", "hostKeyFingerprint"},
		Railway: {"privateKey", "hostKeyFingerprint"},
	}
	allowed := map[string]bool{}
	for _, key := range required[provider] {
		allowed[key] = true
		if strings.TrimSpace(config[key]) == "" {
			return fmt.Errorf("missing provider configuration: %s", key)
		}
	}
	if provider == SSH {
		allowed["port"] = true
	}
	switch provider {
	case Server, RemoteAgent, Temporary, E2B, SSH, Railway:
	default:
		return fmt.Errorf("unsupported computer provider")
	}
	for key := range config {
		if !allowed[key] {
			return fmt.Errorf("unsupported provider configuration field")
		}
	}
	if provider == SSH || provider == Railway {
		if _, err := ssh.ParsePrivateKey([]byte(config["privateKey"])); err != nil {
			return fmt.Errorf("invalid or encrypted SSH private key")
		}
		fingerprint := config["hostKeyFingerprint"]
		digest, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(fingerprint, "SHA256:"))
		if !strings.HasPrefix(fingerprint, "SHA256:") || err != nil || len(digest) != 32 {
			return fmt.Errorf("host key fingerprint must be an OpenSSH SHA256 fingerprint")
		}
	}
	if provider == SSH {
		host := config["host"]
		if host != strings.TrimSpace(host) || strings.ContainsAny(host, "/\\@ \t\r\n") || strings.HasPrefix(host, "-") {
			return fmt.Errorf("invalid SSH host")
		}
		if net.ParseIP(host) == nil {
			if len(host) > 253 {
				return fmt.Errorf("invalid SSH host")
			}
			for _, label := range strings.Split(host, ".") {
				if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
					return fmt.Errorf("invalid SSH host")
				}
				for _, c := range label {
					if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
						return fmt.Errorf("invalid SSH host")
					}
				}
			}
		}
		user := config["user"]
		if strings.HasPrefix(user, "-") || strings.ContainsAny(user, "@: /\\\t\r\n\x00") {
			return fmt.Errorf("invalid SSH user")
		}
		if port, ok := config["port"]; ok {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				return fmt.Errorf("invalid SSH port")
			}
		}
	}
	return nil
}
