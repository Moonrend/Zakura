package docker

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
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

func dockerBin() string { return Binary() }

func Probe() Ping {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, dockerBin(), "version", "--format", "{{.Server.Version}}")
	out, err := cmd.CombinedOutput()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return Ping{OK: false, Error: ErrUnavailable.Error()}
		}
		if ctx.Err() != nil {
			return Ping{OK: false, Error: "Docker 响应超时，请检查 Docker Engine / Desktop 是否已启动"}
		}
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return Ping{OK: false, Error: "Docker 不可用，请检查服务状态、当前 context 和访问权限：" + detail}
	}
	ver := strings.TrimSpace(string(out))
	if ver == "" {
		return Ping{OK: false, Error: "Docker 未返回服务端版本，请检查 Docker Engine / Desktop 是否已启动"}
	}
	return Ping{OK: true, Version: ver}
}

func Require() error {
	if p := Probe(); !p.OK {
		if p.Error == ErrUnavailable.Error() {
			return ErrUnavailable
		}
		return errors.New(p.Error)
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
	VolumeSubpath string `json:"volumeSubpath,omitempty"`
	NoCopy        bool   `json:"noCopy,omitempty"`
}

type ContainerInfo struct {
	DockerID string            `json:"dockerId"`
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	Status   string            `json:"status"`
	Ports    []Port            `json:"ports"`
	Labels   map[string]string `json:"labels"`
}

func (v Volume) validate() error {
	if v.ContainerPath == "" || (v.VolumeName == "") == (v.HostPath == "") {
		return fmt.Errorf("mount requires one source and a container path")
	}
	for _, value := range []string{v.HostPath, v.VolumeName, v.ContainerPath, v.VolumeSubpath} {
		if strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("invalid mount path")
		}
	}
	if v.VolumeName == "" && (v.VolumeSubpath != "" || v.NoCopy) {
		return fmt.Errorf("volume options require a named volume")
	}
	if v.VolumeSubpath != "" && (strings.ContainsAny(v.VolumeSubpath, `\:`) || path.IsAbs(v.VolumeSubpath) || path.Clean(v.VolumeSubpath) != v.VolumeSubpath || v.VolumeSubpath == "." || v.VolumeSubpath == ".." || strings.HasPrefix(v.VolumeSubpath, "../")) {
		return fmt.Errorf("volume subpath must be a clean relative directory")
	}
	return nil
}

// --mount uses CSV, including escaping paths containing commas or quotes.
func volumeMountFlag(v Volume) string {
	if v.validate() != nil {
		return ""
	}
	kind, source := "volume", v.VolumeName
	if v.HostPath != "" {
		kind, source = "bind", strings.ReplaceAll(v.HostPath, `\`, "/")
	}
	fields := []string{"type=" + kind, "source=" + source, "target=" + v.ContainerPath}
	if v.VolumeSubpath != "" {
		fields = append(fields, "volume-subpath="+v.VolumeSubpath)
	}
	if v.NoCopy {
		fields = append(fields, "volume-nocopy")
	}
	if v.ReadOnly {
		fields = append(fields, "readonly")
	}
	var buffer strings.Builder
	writer := csv.NewWriter(&buffer)
	_ = writer.Write(fields)
	writer.Flush()
	return strings.TrimSuffix(buffer.String(), "\n")
}

func Pull(ctx context.Context, image string) error {
	return PullWithProgress(ctx, image, nil)
}

func Run(ctx context.Context, spec RunSpec) (ContainerInfo, error) {
	return run(ctx, spec, true)
}

// Create starts a new named container without replacing an existing container.
// A conflict or uncertain response must be reconciled by identity, never retried
// through Run, which retains legacy destructive replacement behavior.
func Create(ctx context.Context, spec RunSpec) (ContainerInfo, error) {
	if strings.TrimSpace(spec.Name) == "" {
		return ContainerInfo{}, fmt.Errorf("container name is required")
	}
	if strings.TrimSpace(spec.Image) == "" {
		return ContainerInfo{}, fmt.Errorf("image is required")
	}
	return run(ctx, spec, false)
}

func run(ctx context.Context, spec RunSpec, replace bool) (ContainerInfo, error) {
	for _, volume := range spec.Volumes {
		if err := volume.validate(); err != nil {
			return ContainerInfo{}, err
		}
	}
	if err := Require(); err != nil {
		return ContainerInfo{}, err
	}
	if spec.Image == "" {
		return ContainerInfo{}, fmt.Errorf("image 不能为空")
	}
	if replace && spec.Name != "" {
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

// Start resumes an existing container without replacing it or its bind mounts.
func Start(ctx context.Context, idOrName string) (ContainerInfo, error) {
	idOrName = strings.TrimSpace(idOrName)
	if idOrName == "" || strings.HasPrefix(idOrName, "-") {
		return ContainerInfo{}, fmt.Errorf("container identity is required")
	}
	if err := Require(); err != nil {
		return ContainerInfo{}, err
	}
	out, err := exec.CommandContext(ctx, dockerBin(), "start", idOrName).CombinedOutput()
	if err != nil {
		return ContainerInfo{}, fmt.Errorf("docker start: %s", strings.TrimSpace(string(out)))
	}
	return Inspect(ctx, idOrName)
}

func Stop(ctx context.Context, idOrName string, remove bool) error {
	idOrName = strings.TrimSpace(idOrName)
	if idOrName == "" || strings.HasPrefix(idOrName, "-") {
		return fmt.Errorf("container identity is required")
	}
	if err := Require(); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, dockerBin(), "stop", idOrName).CombinedOutput()
	if err != nil {
		if dockerContainerAbsent(out) {
			return nil
		}
		return fmt.Errorf("docker stop: %s: %w", strings.TrimSpace(string(out)), err)
	}
	if remove {
		out, err = exec.CommandContext(ctx, dockerBin(), "rm", idOrName).CombinedOutput()
		if err != nil && !dockerContainerAbsent(out) {
			return fmt.Errorf("docker rm: %s: %w", strings.TrimSpace(string(out)), err)
		}
	}
	return nil
}

// Only Docker's explicit daemon not-found response proves absence. Timeouts,
// permission failures and unavailable engines must never authorize removal.
func dockerContainerAbsent(out []byte) bool {
	message := strings.TrimSpace(string(out))
	return strings.HasPrefix(message, "Error response from daemon: No such container:")
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
		Id    string `json:"Id"`
		Name  string `json:"Name"`
		State struct {
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
	return ExecWithOptions(ctx, idOrName, command, workdir, env, ExecOptions{})
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
			return nil, fmt.Errorf("docker list incomplete (inspect %s): %w", id, err)
		}
		list = append(list, info)
	}
	return list, nil
}
