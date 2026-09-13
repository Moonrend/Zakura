package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ErrUnavailable 本机没有可用的 Docker Engine / Desktop。
var ErrUnavailable = fmt.Errorf("本机未检测到 Docker。请安装 Docker Engine 或 Docker Desktop 后重试；文件与终端仍可使用，但 MCP / ACP 容器无法启动")

type Ping struct {
	OK      bool   `json:"ok"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

func dockerBin() string {
	if p := os.Getenv("ZAKURA_DOCKER"); p != "" {
		return p
	}
	return "docker"
}

func Probe() Ping {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, dockerBin(), "version", "--format", "{{.Server.Version}}")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return Ping{OK: false, Error: ErrUnavailable.Error()}
	}
	ver := strings.TrimSpace(string(out))
	if ver == "" {
		return Ping{OK: false, Error: ErrUnavailable.Error()}
	}
	return Ping{OK: true, Version: ver}
}

func Require() error {
	if p := Probe(); !p.OK {
		return ErrUnavailable
	}
	return nil
}

type RunSpec struct {
	Name       string            `json:"name"`
	Image      string            `json:"image"`
	Command    []string          `json:"command"`
	Env        map[string]string `json:"env"`
	Labels     map[string]string `json:"labels"`
	Ports      []Port            `json:"ports"`
	Volumes    []Volume          `json:"volumes"`
	Network    string            `json:"network"`
	WorkingDir string            `json:"workingDir"`
	Restart    string            `json:"restart"`
	Privileged bool              `json:"privileged"`
	StdinOpen  bool              `json:"stdinOpen"`
}

type Port struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort,omitempty"`
	HostIP        string `json:"hostIp,omitempty"`
	Protocol      string `json:"protocol,omitempty"`
}

type Volume struct {
	HostPath      string `json:"hostPath,omitempty"`
	VolumeName    string `json:"volumeName,omitempty"`
	ContainerPath string `json:"containerPath"`
	ReadOnly      bool   `json:"readOnly,omitempty"`
}

type ContainerInfo struct {
	DockerID string            `json:"dockerId"`
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	Status   string            `json:"status"`
	Ports    []Port            `json:"ports"`
	Labels   map[string]string `json:"labels"`
}

// volumeMountFlag 用 --mount 而不是 -v，避免 Windows 盘符冒号被拆成 host:port。
func volumeMountFlag(v Volume) string {
	if v.ContainerPath == "" {
		return ""
	}
	if v.VolumeName != "" && v.HostPath == "" {
		spec := "type=volume,source=" + v.VolumeName + ",target=" + v.ContainerPath
		if v.ReadOnly {
			spec += ",readonly"
		}
		return spec
	}
	if v.HostPath == "" {
		return ""
	}
	src := filepath.ToSlash(v.HostPath)
	spec := "type=bind,source=" + src + ",target=" + v.ContainerPath
	if v.ReadOnly {
		spec += ",readonly"
	}
	return spec
}

func Pull(ctx context.Context, image string) error {
	if err := Require(); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, dockerBin(), "pull", image)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker pull: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func Run(ctx context.Context, spec RunSpec) (ContainerInfo, error) {
	if err := Require(); err != nil {
		return ContainerInfo{}, err
	}
	if spec.Image == "" {
		return ContainerInfo{}, fmt.Errorf("image 不能为空")
	}
	if spec.Name != "" {
		_ = exec.CommandContext(ctx, dockerBin(), "rm", "-f", spec.Name).Run()
	}
	args := []string{"run", "-d"}
	if spec.StdinOpen {
		args = append(args, "-i")
	}
	if spec.Name != "" {
		args = append(args, "--name", spec.Name)
	}
	restart := spec.Restart
	if restart == "" {
		restart = "unless-stopped"
	}
	args = append(args, "--restart", restart)
	if spec.WorkingDir != "" {
		args = append(args, "-w", spec.WorkingDir)
	}
	if spec.Network != "" && spec.Network != "bridge" && spec.Network != "default" {
		args = append(args, "--network", spec.Network)
	}
	if spec.Privileged {
		args = append(args, "--privileged")
	}
	for k, v := range spec.Env {
		args = append(args, "-e", k+"="+v)
	}
	for k, v := range spec.Labels {
		args = append(args, "--label", k+"="+v)
	}
	for _, p := range spec.Ports {
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		bind := fmt.Sprintf("%d/%s", p.ContainerPort, proto)
		if p.HostPort > 0 {
			if p.HostIP != "" {
				bind = fmt.Sprintf("%s:%d:%d/%s", p.HostIP, p.HostPort, p.ContainerPort, proto)
			} else {
				bind = fmt.Sprintf("%d:%d/%s", p.HostPort, p.ContainerPort, proto)
			}
		} else if p.HostIP != "" {
			bind = fmt.Sprintf("%s::%d/%s", p.HostIP, p.ContainerPort, proto)
		}
		args = append(args, "-p", bind)
	}
	for _, v := range spec.Volumes {
		if flag := volumeMountFlag(v); flag != "" {
			args = append(args, "--mount", flag)
		}
	}
	args = append(args, spec.Image)
	args = append(args, spec.Command...)
	cmd := exec.CommandContext(ctx, dockerBin(), args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ContainerInfo{}, fmt.Errorf("docker run: %s", strings.TrimSpace(string(out)))
	}
	id := strings.TrimSpace(string(out))
	return Inspect(ctx, id)
}

func Stop(ctx context.Context, idOrName string, remove bool) error {
	if err := Require(); err != nil {
		return err
	}
	_ = exec.CommandContext(ctx, dockerBin(), "stop", idOrName).Run()
	if remove {
		return exec.CommandContext(ctx, dockerBin(), "rm", "-f", idOrName).Run()
	}
	return nil
}

func Inspect(ctx context.Context, idOrName string) (ContainerInfo, error) {
	if err := Require(); err != nil {
		return ContainerInfo{}, err
	}
	cmd := exec.CommandContext(ctx, dockerBin(), "inspect", idOrName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ContainerInfo{}, fmt.Errorf("docker inspect: %s", strings.TrimSpace(string(out)))
	}
	var raw []struct {
		Id     string `json:"Id"`
		Name   string `json:"Name"`
		State  struct {
			Status string `json:"Status"`
		} `json:"State"`
		Config struct {
			Image  string            `json:"Image"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		NetworkSettings struct {
			Ports map[string][]struct {
				HostIP   string `json:"HostIp"`
				HostPort string `json:"HostPort"`
			} `json:"Ports"`
		} `json:"NetworkSettings"`
	}
	if err := json.Unmarshal(out, &raw); err != nil || len(raw) == 0 {
		return ContainerInfo{}, fmt.Errorf("解析 inspect 失败")
	}
	c := raw[0]
	info := ContainerInfo{
		DockerID: c.Id,
		Name:     strings.TrimPrefix(c.Name, "/"),
		Image:    c.Config.Image,
		Status:   c.State.Status,
		Labels:   c.Config.Labels,
	}
	for k, binds := range c.NetworkSettings.Ports {
		var cp int
		var proto string
		fmt.Sscanf(k, "%d/%s", &cp, &proto)
		p := Port{ContainerPort: cp, Protocol: proto}
		if len(binds) > 0 {
			fmt.Sscanf(binds[0].HostPort, "%d", &p.HostPort)
			p.HostIP = binds[0].HostIP
		}
		info.Ports = append(info.Ports, p)
	}
	return info, nil
}

func Exec(ctx context.Context, idOrName string, command []string, workdir string, env map[string]string) (stdout, stderr string, code int, err error) {
	if err := Require(); err != nil {
		return "", "", 1, err
	}
	args := []string{"exec"}
	if workdir != "" {
		args = append(args, "-w", workdir)
	}
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, idOrName)
	args = append(args, command...)
	cmd := exec.CommandContext(ctx, dockerBin(), args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	runErr := cmd.Run()
	code = 0
	if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			return outBuf.String(), errBuf.String(), 1, runErr
		}
	}
	return outBuf.String(), errBuf.String(), code, nil
}

func Logs(ctx context.Context, idOrName string, tail int) (string, error) {
	if err := Require(); err != nil {
		return "", err
	}
	args := []string{"logs", "--tail", fmt.Sprintf("%d", tail), idOrName}
	out, err := exec.CommandContext(ctx, dockerBin(), args...).CombinedOutput()
	return string(out), err
}

func Copy(ctx context.Context, src, dest string) error {
	if err := Require(); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, dockerBin(), "cp", src, dest).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker cp: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func List(ctx context.Context, label string) ([]ContainerInfo, error) {
	if err := Require(); err != nil {
		return nil, err
	}
	args := []string{"ps", "-a", "--format", "{{.ID}}"}
	if label != "" {
		args = append(args, "--filter", "label="+label)
	}
	out, err := exec.CommandContext(ctx, dockerBin(), args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %s", strings.TrimSpace(string(out)))
	}
	var list []ContainerInfo
	for _, id := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		info, err := Inspect(ctx, id)
		if err != nil {
			continue
		}
		list = append(list, info)
	}
	return list, nil
}
