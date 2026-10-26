// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"path"
	"sort"
	"strings"
)

// Storage identity is shared by protocol startup, manual login and advertised
// terminal authentication. Catalog STATE_DIR maps to the durable artifact
// directory, not a new staging HOME that would hide an existing OAuth login.
func acpProfileStorageEnv(profile, home string) map[string]string {
	env := map[string]string{"HOME": home, "XDG_CONFIG_HOME": home + "/.config", "XDG_DATA_HOME": home + "/.local/share"}
	agent, ok := acpRegistryAgentFor(profile)
	if !ok {
		return env
	}
	state := home
	for _, artifact := range agent.Storage.Artifacts {
		if artifact.Runtime != "" && artifact.Durable != artifact.Runtime && strings.HasSuffix(artifact.Durable, "/"+artifact.Runtime) {
			state = path.Join(home, strings.TrimSuffix(artifact.Durable, "/"+artifact.Runtime))
			break
		}
	}
	for name, value := range agent.Storage.Env {
		value = strings.NewReplacer("${RUNTIME_DIR}", home, "${STATE_DIR}", state).Replace(value)
		if strings.HasPrefix(value, home) && !strings.Contains(value, "${") {
			env[name] = value
		}
	}
	return env
}

// A native OAuth launch must not inherit API-key/provider overrides from image
// defaults or a previous setup. Explicit user overrides are a conflict, not
// something to silently discard. Empty Docker env values shadow image defaults.
func acpNativeOAuthEnv(setup acpSetup) (map[string]string, error) {
	out := map[string]string{}
	if setup.SetupMode != "oauth" || setup.ModelProvider == "zakura" {
		return out, nil
	}
	probe := setup
	probe.SetupMode = "api_key"
	probe.Env = nil
	probe.Managed = map[string]string{"api_key": "probe", "base_url": "probe"}
	profile := acpProfileForSetup(probe)
	keys := resolveACPLaunch(profile, probe).Env
	if agent, ok := acpRegistryAgentFor(setup.ID); ok {
		for _, key := range agent.Auth.APIKeyEnv {
			keys[key] = "probe"
		}
	}
	for _, key := range []string{"ZAKURA_API_KEY", "ZAKURA_BASE_URL", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"} {
		keys[key] = "probe"
	}
	// Env from setup is never copied into the probe, so only generated auth
	// names are considered; unrelated certificates/proxy env remain untouched.
	names := make([]string, 0, len(keys))
	for name := range keys {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.TrimSpace(setup.Env[name]) != "" {
			return nil, errACPOAuthEnvConflict
		}
		out[name] = ""
	}
	return out, nil
}
