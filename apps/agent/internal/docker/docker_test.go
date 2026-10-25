package docker

import (
	"context"
	"encoding/csv"
	"reflect"
	"strings"
	"testing"
)

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

func TestVolumeMountFlagSubpath(t *testing.T) {
	v := Volume{VolumeName: "workspace-data", VolumeSubpath: "disks/disk-1/workspace", ContainerPath: "/workspace", NoCopy: true}
	want := "type=volume,source=workspace-data,target=/workspace,volume-subpath=disks/disk-1/workspace,volume-nocopy"
	if got := volumeMountFlag(v); got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestVolumeMountEscapesCSVFields(t *testing.T) {
	v := Volume{HostPath: `/storage/with,comma/and"quote`, ContainerPath: "/workspace"}
	fields, err := csv.NewReader(strings.NewReader(volumeMountFlag(v))).Read()
	want := []string{"type=bind", `source=/storage/with,comma/and"quote`, "target=/workspace"}
	if err != nil || !reflect.DeepEqual(fields, want) {
		t.Fatalf("mount CSV changed fields: %v %v", fields, err)
	}
}

func TestInvalidMountFailsBeforeDocker(t *testing.T) {
	for _, v := range []Volume{
		{VolumeName: "data", HostPath: "/data", ContainerPath: "/workspace"},
		{HostPath: "/data", ContainerPath: "/workspace", VolumeSubpath: "disk"},
		{HostPath: "/data", ContainerPath: "/workspace", NoCopy: true},
		{VolumeName: "data", ContainerPath: "/workspace", VolumeSubpath: "../other"},
		{VolumeName: "data", ContainerPath: "/workspace", VolumeSubpath: "disk/../other"},
		{VolumeName: "data", ContainerPath: "/workspace", VolumeSubpath: "/absolute"},
		{VolumeName: "data", ContainerPath: "/workspace", VolumeSubpath: `disk\other`},
		{VolumeName: "data", ContainerPath: "/workspace", VolumeSubpath: "."},
		{VolumeName: "data", ContainerPath: "/workspace\x00"},
	} {
		if v.validate() == nil || volumeMountFlag(v) != "" {
			t.Fatalf("invalid mount accepted: %+v", v)
		}
		_, err := Run(context.Background(), RunSpec{Name: "must-not-be-replaced", Image: "image", Volumes: []Volume{v}})
		if err == nil || err.Error() != v.validate().Error() {
			t.Fatalf("mount was not rejected before Docker: %v", err)
		}
	}
}

func TestVolumeMountFlagNamed(t *testing.T) {
	got := volumeMountFlag(Volume{VolumeName: "data", ContainerPath: "/data", ReadOnly: true})
	want := "type=volume,source=data,target=/data,readonly"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
