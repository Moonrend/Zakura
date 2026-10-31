package docker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHardeningRejectsPrivilegeBeforeDocker(t *testing.T) {
	// A missing binary proves rejection happens before any Docker access.
	t.Setenv("ZAKURA_DOCKER", filepath.Join(t.TempDir(), "missing-docker"))
	cases := map[string]RunSpec{
		"privileged":        {Name: "x", Image: "i", Privileged: true},
		"host network":      {Name: "x", Image: "i", Network: "host"},
		"container network": {Name: "x", Image: "i", Network: "container:other"},
		"docker socket":     {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/var/run/docker.sock", ContainerPath: "/var/run/docker.sock"}}},
		"any socket":        {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/srv/podman/podman.sock", ContainerPath: "/s"}}},
		"host root":         {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/", ContainerPath: "/host"}}},
		"host root dotted":  {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/srv/../", ContainerPath: "/host"}}},
		"proc":              {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/proc/1", ContainerPath: "/p"}}},
		"docker data":       {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/var/lib/docker/volumes", ContainerPath: "/v"}}},
		"ssh keys":          {Name: "x", Image: "i", Volumes: []Volume{{HostPath: "/root/.ssh", ContainerPath: "/k"}}},
	}
	for name, spec := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Create(context.Background(), spec)
			if err == nil || !strings.Contains(err.Error(), "not allowed") {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	for _, allowed := range []string{"/var/lib/zakura/agent/spaces/s/workspace", "/srv/zakura/disks/d/workspace", "C:/Users/dev/zakura/workspace"} {
		if reason := deniedHostPath(allowed); reason != "" {
			t.Fatalf("workspace path %s denied: %s", allowed, reason)
		}
	}
}

func TestEveryRunIsHardened(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZAKURA_DOCKER", bin)
	log := filepath.Join(t.TempDir(), "calls.jsonl")
	t.Setenv("ZAKURA_TEST_CREATE_DOCKER_LOG", log)
	t.Setenv("ZAKURA_TEST_CREATE_CONFLICT", "")
	t.Setenv("ZAKURA_CONTAINER_MEMORY", "2g")
	SetEgress(EgressNetworkName, "http://172.30.0.1:3128")
	defer SetEgress("", "")
	specs := []RunSpec{
		{Name: "ws", Image: "workspace:1", Labels: map[string]string{"zakura.purpose": "workspace"}},
		{Name: "mcp", Image: "bridge:1", Ports: []Port{{ContainerPort: 3100}}, Env: map[string]string{"HTTPS_PROXY": "http://own"}},
	}
	for _, spec := range specs {
		if _, err := Create(context.Background(), spec); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var runs [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			t.Fatal(err)
		}
		if args[0] == "run" {
			runs = append(runs, args)
		}
	}
	if len(runs) != 2 {
		t.Fatalf("runs: %v", runs)
	}
	for _, args := range runs {
		joined := strings.Join(args, " ")
		for _, want := range []string{"--security-opt no-new-privileges=true", "--cap-drop ALL", "--pids-limit 4096", "--memory 2g", "NO_PROXY=localhost,127.0.0.1,::1 "} {
			if !strings.Contains(joined, want) {
				t.Fatalf("missing %q: %v", want, args)
			}
		}
		for _, forbidden := range []string{"--privileged", "--cap-add SYS_ADMIN", "--cap-add NET_ADMIN", "--cap-add ALL"} {
			if strings.Contains(joined, forbidden) {
				t.Fatalf("unexpected %q: %v", forbidden, args)
			}
		}
	}
	workspace, mcp := strings.Join(runs[0], " "), strings.Join(runs[1], " ")
	if !strings.Contains(workspace, "--network "+EgressNetworkName) || !strings.Contains(workspace, "--shm-size 1g") || !strings.Contains(workspace, "HTTPS_PROXY=http://172.30.0.1:3128") {
		t.Fatalf("workspace not confined to egress network: %s", workspace)
	}
	if strings.Contains(mcp, "--network "+EgressNetworkName) || strings.Contains(mcp, "HTTPS_PROXY=http://172.30.0.1:3128") || !strings.Contains(mcp, "HTTPS_PROXY=http://own") {
		t.Fatalf("published service handling wrong: %s", mcp)
	}
}

func TestRecreateDropsPrivilege(t *testing.T) {
	spec, err := specFromInspectJSON([]byte(`[{"Name":"/old","Config":{"Image":"i","Labels":{"zakura.purpose":"component"}},"HostConfig":{"Privileged":true,"NetworkMode":"host"}}]`))
	if err != nil {
		t.Fatal(err)
	}
	if spec.Privileged || spec.Network != "" || validateHardening(spec) != nil {
		t.Fatalf("privilege carried forward: %+v", spec)
	}
}
