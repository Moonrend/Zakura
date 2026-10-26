package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	"github.com/Moonrend/Zakura/apps/agent/workspace"
)

type savedCredential struct {
	ServerURL  string     `json:"serverUrl"`
	Credential Credential `json:"credential"`
}

// Wait enrolls only against the configured control plane. Transient startup and
// pre-setup responses are retried without logging credentials or response bodies.
func Wait(ctx context.Context, server, bootstrapDirectory, stateDirectory, incarnation string) (Credential, error) {
	server = strings.TrimRight(server, "/")
	u, err := url.Parse(server)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "http" && u.Scheme != "https" || !workspace.ValidIdentity(incarnation) {
		return Credential{}, errors.New("invalid bootstrap server or node identity")
	}
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for {
		if err := ctx.Err(); err != nil {
			return Credential{}, err
		}
		installation, err := Read(bootstrapDirectory)
		if err == nil {
			credential, retry, err := enroll(ctx, client, server, stateDirectory, incarnation, installation)
			if !retry {
				return credential, err
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return Credential{}, err
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return Credential{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func enroll(ctx context.Context, client *http.Client, server, stateDirectory, incarnation string, installation Installation) (Credential, bool, error) {
	root, err := statefs.OpenRoot(stateDirectory)
	if err != nil {
		return Credential{}, false, err
	}
	defer root.Close()
	var saved savedCredential
	err = statefs.Read(root, "node-credential.json", &saved)
	if err == nil {
		if saved.ServerURL != server || !validCredential(saved.Credential, installation.ID, incarnation) {
			return Credential{}, false, errors.New("stored node enrollment identity changed")
		}
		return saved.Credential, false, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return Credential{}, false, err
	}
	body, _ := json.Marshal(Request{InstallationID: installation.ID, NodeIncarnation: incarnation})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server+"/api/runtime-nodes/installation/enroll", bytes.NewReader(body))
	if err != nil {
		return Credential{}, false, err
	}
	request.Header.Set("Authorization", "Bearer "+installation.Secret)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return Credential{}, true, nil
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict || response.StatusCode == http.StatusServiceUnavailable || response.StatusCode >= 500 {
		return Credential{}, true, nil
	}
	if response.StatusCode != http.StatusOK {
		return Credential{}, false, fmt.Errorf("node enrollment rejected (HTTP %d)", response.StatusCode)
	}
	var credential Credential
	decoder := json.NewDecoder(io.LimitReader(response.Body, 65536))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&credential) != nil || decoder.Decode(&struct{}{}) != io.EOF || !validCredential(credential, installation.ID, incarnation) {
		return Credential{}, false, errors.New("invalid node enrollment response")
	}
	unlock, err := statefs.Lock(ctx, root)
	if err != nil {
		return Credential{}, false, err
	}
	defer unlock()
	if err := statefs.Read(root, "node-credential.json", &saved); err == nil {
		if saved.ServerURL != server || saved.Credential != credential {
			return Credential{}, false, errors.New("concurrent node enrollment changed identity")
		}
	} else if errors.Is(err, fs.ErrNotExist) {
		if err := statefs.Write(root, "node-credential.json", savedCredential{server, credential}, false); err != nil {
			return Credential{}, false, err
		}
	} else {
		return Credential{}, false, err
	}
	return credential, false, nil
}

func validCredential(c Credential, installation, incarnation string) bool {
	return c.InstallationID == installation && c.NodeIncarnation == incarnation && workspace.ValidIdentity(c.NodeID) && strings.HasPrefix(c.Token, "rnr_") && len(c.Token) >= 40 && len(c.Token) <= 256
}
