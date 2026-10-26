// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

const acpManagedManifest = ".zakura-managed-files.json"
const acpManagedMax = 2 << 20

type acpManagedRecord struct {
	Version int                 `json:"version"`
	Files   map[string][]string `json:"files"`
	MAC     string              `json:"mac"`
}

type acpManagedFS struct {
	call               func(context.Context, string, any, any) error
	space, home, scope string
	secret             []byte
}

func acpManagedDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (f acpManagedFS) params(target string) map[string]any {
	return map[string]any{"spaceId": f.space, "path": strings.TrimPrefix(target, "/workspace")}
}

var errACPManagedConflict = errors.New("ACP profile HOME contains an unmanaged or modified authentication/configuration file; preserve your login and move the conflicting file aside manually before changing authentication mode")
var errACPOAuthEnvConflict = errors.New("ACP native OAuth conflicts with an explicit API-key/provider environment override; remove the override in profile settings")

func acpManagedConflict() error {
	return errACPManagedConflict
}

// Only known local conflicts may cross the terminal boundary. Runner errors can
// include commands or credentials and must retain the generic startup message.
func acpLoginStartMessage(err error, fallback string) string {
	for _, conflict := range []error{errACPManagedConflict, errACPOAuthEnvConflict} {
		if errors.Is(err, conflict) {
			return conflict.Error()
		}
	}
	return fallback
}

// Inspect each component rather than following a final or intermediate link.
// A profile writer lease is required by the caller; generic filesystem RPC is
// not a compare-and-swap transaction against unrelated external writers.
func (f acpManagedFS) inspect(ctx context.Context, target string) (runnerFSEntry, bool, error) {
	if target != path.Clean(target) || !strings.HasPrefix(target, f.home+"/") {
		return runnerFSEntry{}, false, errors.New("invalid ACP managed file path")
	}
	current := "/workspace"
	parts := strings.Split(strings.TrimPrefix(target, "/workspace/"), "/")
	for i, component := range parts {
		var listing struct {
			Entries []runnerFSEntry `json:"entries"`
		}
		if err := f.call(ctx, "host.fs.list", f.params(current), &listing); err != nil {
			return runnerFSEntry{}, false, errors.New("cannot inspect ACP profile HOME")
		}
		found := false
		for _, entry := range listing.Entries {
			if entry.Name == component {
				found = true
				break
			}
		}
		if !found {
			return runnerFSEntry{}, false, nil
		}
		current = path.Join(current, component)
		params := f.params(current)
		params["noFollow"] = true
		var entry runnerFSEntry
		if err := f.call(ctx, "host.fs.stat", params, &entry); err != nil {
			return runnerFSEntry{}, false, errors.New("cannot inspect ACP profile HOME")
		}
		if i < len(parts)-1 {
			if !entry.IsDir || !strings.HasPrefix(entry.Mode, "d") {
				return runnerFSEntry{}, false, acpManagedConflict()
			}
		} else {
			if entry.IsDir || !strings.HasPrefix(entry.Mode, "-") || entry.Size < 0 || entry.Size > acpManagedMax {
				return runnerFSEntry{}, false, acpManagedConflict()
			}
			return entry, true, nil
		}
	}
	return runnerFSEntry{}, false, acpManagedConflict()
}

func (f acpManagedFS) read(ctx context.Context, name string) ([]byte, bool, error) {
	target := f.home + "/" + name
	before, exists, err := f.inspect(ctx, target)
	if err != nil || !exists {
		return nil, exists, err
	}
	params := f.params(target)
	params["max"] = acpManagedMax
	var result struct {
		Content string `json:"content"`
	}
	if err := f.call(ctx, "host.fs.read", params, &result); err != nil {
		return nil, false, errors.New("cannot read ACP managed configuration")
	}
	after, exists, err := f.inspect(ctx, target)
	if err != nil || !exists || before.Mode != after.Mode || before.Size != after.Size || fmt.Sprint(before.ModTime) != fmt.Sprint(after.ModTime) || int64(len(result.Content)) != after.Size {
		return nil, false, acpManagedConflict()
	}
	return []byte(result.Content), true, nil
}

func (f acpManagedFS) sign(record acpManagedRecord) string {
	record.MAC = ""
	raw, _ := json.Marshal(record)
	mac := hmac.New(sha256.New, f.secret)
	_, _ = mac.Write([]byte("acp-managed-files:" + f.scope + ":"))
	_, _ = mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}

func (f acpManagedFS) write(ctx context.Context, name string, content []byte) error {
	params := f.params(f.home + "/" + name)
	if err := f.call(ctx, "host.fs.mkdir", f.params(path.Dir(f.home+"/"+name)), nil); err != nil {
		return errors.New("cannot create ACP managed configuration directory")
	}
	params["content"], params["mode"], params["atomic"] = string(content), 0o600, true
	var ack map[string]any
	if err := f.call(ctx, "host.fs.write", params, &ack); err != nil {
		return errors.New("cannot save ACP managed configuration")
	}
	if gwInt(ack["mode"]) != 0o600 || ack["atomic"] != true {
		return errors.New("runtime node did not confirm secure credential write")
	}
	return nil
}

func (f acpManagedFS) save(ctx context.Context, record acpManagedRecord) error {
	record.MAC = f.sign(record)
	raw, _ := json.Marshal(record)
	return f.write(ctx, acpManagedManifest, raw)
}

func acpManagedName(name string) bool {
	return name != "" && name != "." && name != acpManagedManifest && !strings.HasPrefix(name, "/") && path.Clean(name) == name && name != ".." && !strings.HasPrefix(name, "../") && !strings.ContainsAny(name, "\\\x00")
}

// reconcile owns only files whose signed provenance and current fingerprint
// agree. An intent record precedes writes, allowing a retry after partial RPC
// failure without mistaking our new file for a user's untracked credential.
func (f acpManagedFS) reconcile(ctx context.Context, setup acpSetup, files []acpRuntimeFile) error {
	var info struct {
		Capabilities map[string]bool `json:"capabilities"`
	}
	if err := f.call(ctx, "sys.info", map[string]any{}, &info); err != nil {
		return errors.New("cannot verify ACP filesystem safety capabilities")
	}
	if !info.Capabilities["privateAtomicFS"] || !info.Capabilities["filesystemNoFollowStat"] {
		return errors.New("runtime node requires an update for safe ACP authentication mode changes")
	}
	record := acpManagedRecord{Version: 1, Files: map[string][]string{}}
	raw, exists, err := f.read(ctx, acpManagedManifest)
	if err != nil {
		return err
	}
	if exists {
		if json.Unmarshal(raw, &record) != nil || record.Version != 1 || record.Files == nil || len(record.Files) > 64 || !hmac.Equal([]byte(record.MAC), []byte(f.sign(record))) {
			return acpManagedConflict()
		}
	}
	desired := map[string][]byte{}
	for _, file := range files {
		name := strings.TrimPrefix(file.Path, f.home+"/")
		if !strings.HasPrefix(file.Path, f.home+"/") || !acpManagedName(name) || len(file.Content) > acpManagedMax {
			return errors.New("invalid ACP runtime file path")
		}
		desired[name] = []byte(file.Content)
	}
	names := map[string]bool{}
	for name, hashes := range record.Files {
		if !acpManagedName(name) || len(hashes) == 0 || len(hashes) > 2 {
			return acpManagedConflict()
		}
		names[name] = true
	}
	for name := range desired {
		names[name] = true
	}
	if setup.SetupMode == "oauth" && setup.ModelProvider != "zakura" {
		// Unprovenanced legacy artifacts are never deleted or adopted. Inspect
		// only known generated locations; user OAuth and unrelated files survive.
		if setup.ID == "codex" {
			names[".codex/auth.json"], names[".codex/config.toml"] = true, true
		}
		if agent, ok := acpRegistryAgentFor(setup.ID); ok {
			for name := range agent.Integration.Dotenv {
				names[strings.TrimPrefix(name, "/")] = true
			}
			for name := range agent.Integration.RuntimeFiles {
				names[strings.TrimPrefix(name, "/")] = true
			}
		}
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		if !acpManagedName(name) {
			return acpManagedConflict()
		}
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	observed := map[string]string{}
	for _, name := range ordered {
		data, present, err := f.read(ctx, name)
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		digest := acpManagedDigest(data)
		observed[name] = digest
		if hashes, managed := record.Files[name]; managed {
			match := false
			for _, hash := range hashes {
				if hash == digest {
					match = true
				}
			}
			if !match {
				return acpManagedConflict()
			}
		} else if _, replacing := desired[name]; replacing || !acpUnmanagedOAuthSafe(setup.ID, name, data) {
			return acpManagedConflict()
		}
	}
	intent := acpManagedRecord{Version: 1, Files: map[string][]string{}}
	for name := range record.Files {
		if digest := observed[name]; digest != "" {
			intent.Files[name] = []string{digest}
		}
	}
	for name, content := range desired {
		digest := acpManagedDigest(content)
		if old := observed[name]; old != "" && old != digest {
			intent.Files[name] = []string{old, digest}
		} else {
			intent.Files[name] = []string{digest}
		}
	}
	if len(intent.Files) == 0 && !exists {
		return nil
	}
	if err := f.save(ctx, intent); err != nil {
		return err
	}
	final := acpManagedRecord{Version: 1, Files: map[string][]string{}}
	for _, name := range ordered {
		_, managed := intent.Files[name]
		if !managed {
			continue
		}
		data, present, err := f.read(ctx, name)
		if err != nil {
			return err
		}
		if (present && acpManagedDigest(data) != observed[name]) || (!present && observed[name] != "") {
			return acpManagedConflict()
		}
		if content, keep := desired[name]; keep {
			if err := f.write(ctx, name, content); err != nil {
				return err
			}
			final.Files[name] = []string{acpManagedDigest(content)}
		} else if present {
			if err := f.call(ctx, "host.fs.remove", f.params(f.home+"/"+name), nil); err != nil {
				return errors.New("cannot clear previous managed ACP authentication configuration")
			}
		}
	}
	return f.save(ctx, final)
}

func acpUnmanagedOAuthSafe(profile, name string, data []byte) bool {
	if profile != "codex" {
		return false
	}
	if name == ".codex/auth.json" {
		var auth map[string]json.RawMessage
		if json.Unmarshal(data, &auth) != nil {
			return false
		}
		key := strings.TrimSpace(string(auth["OPENAI_API_KEY"]))
		var tokens map[string]json.RawMessage
		return (key == "" || key == "null" || key == `""`) && json.Unmarshal(auth["tokens"], &tokens) == nil && len(tokens) > 0
	}
	if name == ".codex/config.toml" {
		text := strings.ToLower(string(data))
		for _, marker := range []string{"model_provider", "base_url", "api_key", "requires_openai_auth", "experimental_bearer_token"} {
			if strings.Contains(text, marker) {
				return false
			}
		}
		return true
	}
	return false
}
