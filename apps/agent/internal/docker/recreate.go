package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

type RecreateResult struct {
	Image      string          `json:"image"`
	Recreated  []ContainerInfo `json:"recreated"`
	Skipped    int             `json:"skipped"`
	Failed     []string        `json:"failed,omitempty"`
}

// RecreateStale 把仍跑旧镜像 ID 的 zakura 容器按 inspect 重建到当前 tag。
func RecreateStale(ctx context.Context, image string) (RecreateResult, error) {
	res := RecreateResult{Image: image}
	if image == "" {
		return res, fmt.Errorf("image 不能为空")
	}
	cur, _, err := imageID(ctx, image)
	if err != nil {
		return res, err
	}
	list, err := List(ctx, "")
	if err != nil {
		return res, err
	}
	for _, c := range list {
		if !isZakura(c.Labels) || !imageRefMatch(c.Image, image) {
			res.Skipped++
			continue
		}
		rawID, _ := containerImageID(ctx, c.DockerID)
		if rawID == cur {
			res.Skipped++
			continue
		}
		spec, err := specFromContainer(ctx, c.DockerID)
		if err != nil {
			res.Failed = append(res.Failed, c.Name+": "+err.Error())
			continue
		}
		spec.Image = image
		bak := spec.Name + ".bak"
		_ = exec.CommandContext(ctx, dockerBin(), "rm", "-f", bak).Run()
		if spec.Name != "" {
			_ = exec.CommandContext(ctx, dockerBin(), "rename", spec.Name, bak).Run()
		}
		info, err := Run(ctx, spec)
		if err != nil {
			if spec.Name != "" {
				_ = exec.CommandContext(ctx, dockerBin(), "rename", bak, spec.Name).Run()
			}
			res.Failed = append(res.Failed, c.Name+": "+err.Error())
			continue
		}
		_ = exec.CommandContext(ctx, dockerBin(), "rm", "-f", bak).Run()
		res.Recreated = append(res.Recreated, info)
	}
	return res, nil
}

func specFromContainer(ctx context.Context, id string) (RunSpec, error) {
	cmd := exec.CommandContext(ctx, dockerBin(), "inspect", id)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return RunSpec{}, fmt.Errorf("inspect: %s", strings.TrimSpace(string(out)))
	}
	return specFromInspectJSON(out)
}

func specFromInspectJSON(raw []byte) (RunSpec, error) {
	var arr []inspectBlob
	if err := json.Unmarshal(raw, &arr); err != nil || len(arr) == 0 {
		return RunSpec{}, fmt.Errorf("解析 inspect 失败")
	}
	c := arr[0]
	spec := RunSpec{
		Name:       strings.TrimPrefix(c.Name, "/"),
		Image:      c.Config.Image,
		Command:    c.Config.Cmd,
		WorkingDir: c.Config.WorkingDir,
		Labels:     c.Config.Labels,
		Privileged: c.HostConfig.Privileged,
		Restart:    c.HostConfig.RestartPolicy.Name,
		Env:        map[string]string{},
	}
	net := c.HostConfig.NetworkMode
	if net != "" && net != "default" && net != "bridge" && net != "host" {
		spec.Network = net
	}
	for _, e := range c.Config.Env {
		k, v, ok := strings.Cut(e, "=")
		if ok {
			spec.Env[k] = v
		}
	}
	for k, binds := range c.HostConfig.PortBindings {
		var cp int
		var proto string
		fmt.Sscanf(k, "%d/%s", &cp, &proto)
		p := Port{ContainerPort: cp, Protocol: proto}
		if len(binds) > 0 {
			p.HostPort, _ = strconv.Atoi(binds[0].HostPort)
			p.HostIP = binds[0].HostIP
		}
		spec.Ports = append(spec.Ports, p)
	}
	for _, m := range c.Mounts {
		v := Volume{ContainerPath: m.Destination, ReadOnly: !m.RW}
		if m.Type == "volume" {
			v.VolumeName = m.Name
		} else {
			v.HostPath = m.Source
		}
		spec.Volumes = append(spec.Volumes, v)
	}
	return spec, nil
}

type inspectBlob struct {
	Name   string `json:"Name"`
	Config struct {
		Image      string            `json:"Image"`
		Env        []string          `json:"Env"`
		Labels     map[string]string `json:"Labels"`
		Cmd        []string          `json:"Cmd"`
		WorkingDir string            `json:"WorkingDir"`
	} `json:"Config"`
	HostConfig struct {
		Privileged    bool   `json:"Privileged"`
		NetworkMode   string `json:"NetworkMode"`
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
		PortBindings map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"PortBindings"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
}
