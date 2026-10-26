// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Registry metadata is translated into the same installer input as a manual
// import; it is never persisted as a supposedly-ready runtime configuration.
func decodeMCPProbeResult(raw []byte) (json.RawMessage, error) {
	var response struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	decode := func(data []byte) (json.RawMessage, error) {
		if json.Unmarshal(data, &response) != nil || len(response.Error) > 0 && !bytes.Equal(response.Error, []byte("null")) || len(response.Result) == 0 || bytes.Equal(response.Result, []byte("null")) {
			return nil, errors.New("invalid MCP probe response")
		}
		return response.Result, nil
	}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		return decode(raw)
	}
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if data, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			if result, err := decode(bytes.TrimSpace(data)); err == nil {
				return result, nil
			}
		}
	}
	return nil, errors.New("invalid MCP probe response")
}

func mcpStoreInstallBody(cfg map[string]any, prefer, remoteURL string, index *int) (stdioImportBody, error) {
	raw, _ := json.Marshal(cfg)
	var body stdioImportBody
	_ = json.Unmarshal(raw, &body)
	if nested, ok := cfg["config"].(map[string]any); ok {
		raw, _ = json.Marshal(nested)
		_ = json.Unmarshal(raw, &body)
	}
	if body.Command != "" || body.URL != "" {
		return body, nil
	}
	if prefer != "stdio" {
		remotes, _ := cfg["remotes"].([]any)
		for _, rawRemote := range remotes {
			remote, _ := rawRemote.(map[string]any)
			u, _ := remote["url"].(string)
			if u != "" && (remoteURL == "" || remoteURL == u) {
				body.URL = u
				return body, nil
			}
		}
	}
	packages, _ := cfg["packages"].([]any)
	i := 0
	if index != nil {
		i = *index
	}
	if i < 0 || i >= len(packages) {
		return body, errors.New("store entry has no supported install target")
	}
	pkg, _ := packages[i].(map[string]any)
	registry, _ := pkg["registryType"].(string)
	identifier, _ := pkg["identifier"].(string)
	version, _ := pkg["version"].(string)
	if identifier == "" {
		return body, errors.New("store package identifier required")
	}
	switch registry {
	case "npm":
		body.PackageManager = "npm"
		body.Command = "npx"
		if version != "" {
			identifier += "@" + version
		}
		body.Args = []string{"-y", identifier}
	case "pypi":
		body.PackageManager = "pypi"
		body.Command = "uvx"
		if version != "" {
			identifier += "==" + version
		}
		body.Args = []string{identifier}
	case "oci":
		body.PackageManager = "oci"
		body.Command = "docker"
		if version != "" {
			identifier += ":" + version
		}
		body.Args = []string{"run", "-i", "--rm", identifier}
	default:
		return body, errors.New("unsupported store package registry")
	}
	if args, ok := pkg["packageArguments"].([]any); ok {
		for _, rawArg := range args {
			arg, _ := rawArg.(map[string]any)
			if value, ok := arg["value"].(string); ok {
				body.Args = append(body.Args, value)
			}
		}
	}
	return body, nil
}
