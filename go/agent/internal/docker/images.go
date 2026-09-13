package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type ImageStatus struct {
	Image        string `json:"image"`
	ID           string `json:"id,omitempty"`
	Digest       string `json:"digest,omitempty"`
	RunningStale bool   `json:"runningStale"`
	Error        string `json:"error,omitempty"`
}

func InspectImages(ctx context.Context, names []string) []ImageStatus {
	out := make([]ImageStatus, 0, len(names))
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			continue
		}
		st := ImageStatus{Image: name}
		id, digest, err := imageID(ctx, name)
		if err != nil {
			st.Error = err.Error()
			out = append(out, st)
			continue
		}
		st.ID = id
		st.Digest = digest
		list, err := List(ctx, "")
		if err == nil {
			for _, c := range list {
				if !isZakura(c.Labels) {
					continue
				}
				if !imageRefMatch(c.Image, name) {
					continue
				}
				rawID, _ := containerImageID(ctx, c.DockerID)
				if rawID != "" && rawID != id {
					st.RunningStale = true
					break
				}
			}
		}
		out = append(out, st)
	}
	return out
}

func imageID(ctx context.Context, name string) (id, digest string, err error) {
	if err := Require(); err != nil {
		return "", "", err
	}
	cmd := exec.CommandContext(ctx, dockerBin(), "image", "inspect", name, "--format", "{{.Id}}\t{{json .RepoDigests}}")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("docker image inspect: %s", strings.TrimSpace(string(out)))
	}
	line := strings.TrimSpace(string(out))
	id, rest, _ := strings.Cut(line, "\t")
	var digests []string
	_ = json.Unmarshal([]byte(rest), &digests)
	if len(digests) > 0 {
		digest = digests[0]
	}
	return id, digest, nil
}

func containerImageID(ctx context.Context, idOrName string) (string, error) {
	cmd := exec.CommandContext(ctx, dockerBin(), "inspect", idOrName, "--format", "{{.Image}}")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func imageRefMatch(got, want string) bool {
	if got == want {
		return true
	}
	repo := func(s string) string {
		s = strings.Split(s, "@")[0]
		if i := strings.LastIndex(s, ":"); i > 0 && !strings.Contains(s[i+1:], "/") {
			return s[:i]
		}
		return s
	}
	return repo(got) == repo(want)
}

func isZakura(labels map[string]string) bool {
	for k := range labels {
		if strings.HasPrefix(k, "zakura.") {
			return true
		}
	}
	return false
}
