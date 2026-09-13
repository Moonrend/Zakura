package docker

import "testing"

func TestImageRefMatch(t *testing.T) {
	if !imageRefMatch("sunwuyuan/zakura-workspace-dev:latest", "sunwuyuan/zakura-workspace-dev:latest") {
		t.Fatal("exact")
	}
	if !imageRefMatch("sunwuyuan/zakura-workspace-dev:old", "sunwuyuan/zakura-workspace-dev:latest") {
		t.Fatal("same repo")
	}
	if imageRefMatch("other/img:latest", "sunwuyuan/zakura-workspace-dev:latest") {
		t.Fatal("different repo")
	}
}

func TestSpecFromInspectJSON(t *testing.T) {
	raw := []byte(`[
	  {
	    "Name": "/zakura-ws-a",
	    "Config": {
	      "Image": "img:old",
	      "Env": ["FOO=bar", "PATH=/usr/bin"],
	      "Labels": {"zakura.agent": "a1"},
	      "Cmd": ["sleep", "inf"],
	      "WorkingDir": "/workspace"
	    },
	    "HostConfig": {
	      "Privileged": false,
	      "NetworkMode": "bridge",
	      "RestartPolicy": {"Name": "unless-stopped"},
	      "PortBindings": {"6080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "16080"}]}
	    },
	    "Mounts": [
	      {"Type": "bind", "Source": "/data/a", "Destination": "/workspace", "RW": true}
	    ]
	  }
	]`)
	spec, err := specFromInspectJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Name != "zakura-ws-a" {
		t.Fatalf("name %q", spec.Name)
	}
	if spec.Env["FOO"] != "bar" {
		t.Fatalf("env %v", spec.Env)
	}
	if len(spec.Ports) != 1 || spec.Ports[0].HostPort != 16080 {
		t.Fatalf("ports %+v", spec.Ports)
	}
	if len(spec.Volumes) != 1 || spec.Volumes[0].HostPath != "/data/a" {
		t.Fatalf("volumes %+v", spec.Volumes)
	}
	if spec.Network != "" {
		t.Fatalf("bridge 不应写入 network: %q", spec.Network)
	}
}

func TestIsZakura(t *testing.T) {
	if !isZakura(map[string]string{"zakura.agent": "x"}) {
		t.Fatal("zakura label")
	}
	if isZakura(map[string]string{"com.docker.compose.project": "x"}) {
		t.Fatal("unrelated")
	}
}
