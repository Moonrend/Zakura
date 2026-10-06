package docker

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// PullEvent 与控制面的 DockerPullEvent 保持一致。
type PullEvent struct {
	ID             string        `json:"id,omitempty"`
	Status         string        `json:"status,omitempty"`
	Progress       string        `json:"progress,omitempty"`
	ProgressDetail *PullProgress `json:"progressDetail,omitempty"`
}

type PullProgress struct {
	Current int64 `json:"current"`
	Total   int64 `json:"total"`
}

var (
	pullANSI  = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	pullLayer = regexp.MustCompile(`^([a-fA-F0-9]{12,64}):\s*(.*)$`)
	pullBytes = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s*([kKMGTPE]?i?B)\s*/\s*([0-9]+(?:\.[0-9]+)?)\s*([kKMGTPE]?i?B)`)
)

func pullByteCount(value, unit string) int64 {
	n, _ := strconv.ParseFloat(value, 64)
	unit = strings.ToUpper(unit)
	base := float64(1000)
	if strings.Contains(unit, "I") {
		base = 1024
	}
	if power := strings.Index("BKMGTPE", unit[:1]); power > 0 {
		for i := 0; i < power; i++ {
			n *= base
		}
	}
	return int64(n)
}

func parsePullEvent(line string) PullEvent {
	line = strings.TrimSpace(pullANSI.ReplaceAllString(line, ""))
	event := PullEvent{Status: line}
	if parts := pullLayer.FindStringSubmatch(line); parts != nil {
		event.ID, event.Status = parts[1], parts[2]
	}
	if progress := pullBytes.FindStringSubmatch(event.Status); progress != nil {
		event.Progress = progress[0]
		event.ProgressDetail = &PullProgress{
			Current: pullByteCount(progress[1], progress[2]),
			Total:   pullByteCount(progress[3], progress[4]),
		}
		if at := strings.Index(event.Status, "["); at >= 0 {
			event.Status = strings.TrimSpace(event.Status[:at])
		} else {
			event.Status = strings.TrimSpace(strings.TrimSuffix(event.Status, progress[0]))
		}
	}
	return event
}

type pullOutput struct {
	pending    []byte
	tail       []byte
	onProgress func(PullEvent)
}

func (out *pullOutput) emit(line []byte) {
	if event := parsePullEvent(string(line)); event.Status != "" && out.onProgress != nil {
		out.onProgress(event)
	}
}

func (out *pullOutput) Write(p []byte) (int, error) {
	// 错误只保留末尾日志，避免大镜像的逐层进度长期占用内存。
	out.tail = append(out.tail, p...)
	if len(out.tail) > 8192 {
		out.tail = append([]byte(nil), out.tail[len(out.tail)-8192:]...)
	}
	out.pending = append(out.pending, p...)
	for {
		at := bytes.IndexAny(out.pending, "\r\n")
		if at < 0 {
			break
		}
		out.emit(out.pending[:at])
		out.pending = out.pending[at+1:]
	}
	if len(out.pending) > 64*1024 {
		out.emit(out.pending)
		out.pending = nil
	}
	return len(p), nil
}

func PullWithProgress(ctx context.Context, image string, onProgress func(PullEvent)) error {
	if err := Require(); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, dockerBin(), "pull", image)
	out := &pullOutput{onProgress: onProgress}
	var err error
	if onProgress == nil {
		cmd.Stdout, cmd.Stderr = out, out
		err = cmd.Run()
	} else {
		err = runPullCommand(cmd, out)
	}
	out.emit(out.pending)
	if err != nil {
		return fmt.Errorf("docker pull: %s: %w", strings.TrimSpace(pullANSI.ReplaceAllString(string(out.tail), "")), err)
	}
	return nil
}
