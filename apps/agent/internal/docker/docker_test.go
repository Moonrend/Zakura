package docker

import "testing"

func TestVolumeMountFlagBindWindowsPath(t *testing.T) {
	got := volumeMountFlag(Volume{
		HostPath:      `C:\ProgramData\zakura\agent\agents\a\workspace`,
		ContainerPath: "/workspace",
	})
	want := "type=bind,source=C:/ProgramData/zakura/agent/agents/a/workspace,target=/workspace"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestVolumeMountFlagNamed(t *testing.T) {
	got := volumeMountFlag(Volume{VolumeName: "data", ContainerPath: "/data", ReadOnly: true})
	want := "type=volume,source=data,target=/data,readonly"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
