package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"github.com/pkg/sftp"
)

const sshFilesTimeout = 30 * time.Second

// sshFilesPath maps a workspace-relative tool path onto the SSH user's home
// directory: a leading slash is relative to the workspace root, not the remote
// filesystem root, so the tools stay scoped to the user's own space. SFTP
// resolves the returned relative path against the login home.
func sshFilesPath(target string) (string, error) {
	safe, err := runnerWorkspacePath(target)
	if err != nil {
		return "", err
	}
	safe = strings.TrimPrefix(safe, "/")
	if safe == "" {
		safe = "."
	}
	return safe, nil
}

// computerSSHFiles serves fs_list/fs_read/fs_write over SFTP for both generic SSH
// and Railway computers. The dial configuration is resolved from the computer's
// sealed credentials through sshExecDialConfig, so the fingerprint pin and
// provider constants are shared with the command transport. The connection is
// opened and closed per call. It mirrors the JSON the runner transport returns.
func (h *handler) computerSSHFiles(ctx context.Context, exec *resolvedExecution, op string, args map[string]any) (json.RawMessage, error) {
	if exec == nil || strings.TrimSpace(exec.containerID) == "" {
		return nil, errors.New("computer runtime has no verified host")
	}
	if exec.computer.Provider != computers.SSH && exec.computer.Provider != computers.Railway {
		return nil, errors.New("computer provider does not support ssh files")
	}
	dial, err := h.sshExecDialConfig(ctx, exec)
	if err != nil {
		return nil, err
	}
	client, err := computers.DialSSH(ctx, dial)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return nil, errors.New("sftp session could not be opened")
	}
	defer sftpClient.Close()

	timeout := sshFilesTimeout
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, context.DeadlineExceeded
		}
		if remaining < timeout {
			timeout = remaining
		}
	}
	// An SFTP request has no context: the only way to bound it is to close the
	// client, which tears the channel down and unblocks the pending call.
	var timedOut atomic.Bool
	timer := time.AfterFunc(timeout, func() {
		timedOut.Store(true)
		_ = client.Close()
	})
	defer timer.Stop()

	result, opErr := h.sshFilesOp(sftpClient, op, args)
	if timedOut.Load() {
		return nil, context.DeadlineExceeded
	}
	return result, opErr
}

func (h *handler) sshFilesOp(sftpClient *sftp.Client, op string, args map[string]any) (json.RawMessage, error) {
	switch op {
	case "list":
		target := strings.TrimSpace(builtinStringArg(args, "path"))
		if target == "" {
			target = "."
		}
		resolved, err := sshFilesPath(target)
		if err != nil {
			return nil, err
		}
		infos, err := sftpClient.ReadDir(resolved)
		if err != nil {
			return nil, errors.New("sftp directory could not be listed")
		}
		entries := make([]runnerFSEntry, 0, len(infos))
		for _, info := range infos {
			entries = append(entries, runnerFSEntry{
				Name:    info.Name(),
				Path:    path.Join(resolved, info.Name()),
				Size:    info.Size(),
				Mode:    fmt.Sprintf("%04o", info.Mode().Perm()),
				ModTime: info.ModTime().UTC().Format(time.RFC3339Nano),
				IsDir:   info.IsDir(),
			})
		}
		return builtinJSON(map[string]any{"path": resolved, "entries": entries})
	case "read":
		target := builtinStringArg(args, "path")
		if strings.TrimSpace(target) == "" {
			return nil, errors.New("path is required")
		}
		resolved, err := sshFilesPath(target)
		if err != nil {
			return nil, err
		}
		file, err := sftpClient.Open(resolved)
		if err != nil {
			return nil, errors.New("sftp file could not be opened")
		}
		defer file.Close()
		raw, err := io.ReadAll(io.LimitReader(file, agentFSReadMaxBytes))
		if err != nil {
			return nil, errors.New("sftp file could not be read")
		}
		offset, limit := fsReadWindow(args)
		return fsReadContent(resolved, raw, offset, limit)
	case "write":
		target := builtinStringArg(args, "path")
		if strings.TrimSpace(target) == "" {
			return nil, errors.New("path is required")
		}
		resolved, err := sshFilesPath(target)
		if err != nil {
			return nil, err
		}
		if dir := path.Dir(resolved); dir != "." && dir != "/" {
			if err := sftpClient.MkdirAll(dir); err != nil {
				return nil, errors.New("sftp directory could not be created")
			}
		}
		file, err := sftpClient.Create(resolved)
		if err != nil {
			return nil, errors.New("sftp file could not be created")
		}
		if _, err := file.Write([]byte(builtinStringArg(args, "content"))); err != nil {
			_ = file.Close()
			return nil, errors.New("sftp file could not be written")
		}
		if err := file.Close(); err != nil {
			return nil, errors.New("sftp file could not be written")
		}
		return builtinJSON(map[string]any{"path": resolved, "written": true})
	}
	return nil, errors.New("unsupported filesystem operation")
}
