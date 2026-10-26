package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

// envd exposes file content over the HTTP files endpoint and directory listings
// over the unary filesystem.Filesystem/ListDir Connect RPC. Both are rooted at
// the sandbox workspace that commands run in.
const (
	e2bFilesRoot          = "/workspace"
	e2bFilesHTTPPath      = "/files"
	e2bFilesListPath      = "/filesystem.Filesystem/ListDir"
	e2bFilesResponseLimit = 1 << 20
)

// e2bFilesPath maps a workspace-relative tool path onto the sandbox's absolute
// path. A leading slash is relative to the workspace root, matching the runner
// contract, never the sandbox's own filesystem root.
func e2bFilesPath(target string) (string, error) {
	safe, err := runnerWorkspacePath(target)
	if err != nil {
		return "", err
	}
	safe = strings.TrimPrefix(safe, "/")
	if safe == "" {
		safe = "."
	}
	return path.Join(e2bFilesRoot, safe), nil
}

func e2bFilesURL(exec *resolvedExecution, endpoint string) string {
	return e2bSandboxBaseURL(exec.containerID) + endpoint
}

// e2bComputerFiles serves fs_list/fs_read/fs_write against a pinned E2B sandbox.
// It mirrors the JSON the runner transport returns so tool_output truncation and
// audit keep working unchanged.
func (h *handler) e2bComputerFiles(ctx context.Context, exec *resolvedExecution, op string, args map[string]any) (json.RawMessage, error) {
	if strings.TrimSpace(exec.containerID) == "" {
		return nil, errors.New("computer runtime has no verified sandbox")
	}
	creds, err := h.e2bExecCredentials(ctx, exec)
	if err != nil {
		return nil, err
	}
	switch op {
	case "list":
		target := strings.TrimSpace(builtinStringArg(args, "path"))
		if target == "" {
			target = "."
		}
		resolved, err := e2bFilesPath(target)
		if err != nil {
			return nil, err
		}
		entries, err := h.e2bFilesList(ctx, exec, creds, resolved)
		if err != nil {
			return nil, err
		}
		return builtinJSON(map[string]any{"path": resolved, "entries": entries})
	case "read":
		target := builtinStringArg(args, "path")
		if strings.TrimSpace(target) == "" {
			return nil, errors.New("path is required")
		}
		resolved, err := e2bFilesPath(target)
		if err != nil {
			return nil, err
		}
		raw, err := h.e2bFilesRead(ctx, exec, creds, resolved)
		if err != nil {
			return nil, err
		}
		offset, limit := fsReadWindow(args)
		return fsReadContent(resolved, raw, offset, limit)
	case "write":
		target := builtinStringArg(args, "path")
		if strings.TrimSpace(target) == "" {
			return nil, errors.New("path is required")
		}
		resolved, err := e2bFilesPath(target)
		if err != nil {
			return nil, err
		}
		written, err := h.e2bFilesWrite(ctx, exec, creds, resolved, []byte(builtinStringArg(args, "content")))
		if err != nil {
			return nil, err
		}
		if written == "" {
			written = resolved
		}
		return builtinJSON(map[string]any{"path": written, "written": true})
	}
	return nil, errors.New("unsupported filesystem operation")
}

// e2bFilesDo applies the same envd headers and redaction rules as the command
// transport: the response body never reaches an error, and a non-2xx status is
// surfaced as its code only.
func (h *handler) e2bFilesDo(ctx context.Context, exec *resolvedExecution, creds e2bExecCredentials, req *http.Request) (*http.Response, error) {
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("E2b-Sandbox-Id", exec.containerID)
	req.Header.Set("E2b-Sandbox-Port", fmt.Sprint(e2bEnvdPort))
	if token := strings.TrimSpace(creds.EnvdAccessToken); token != "" {
		req.Header.Set("X-Access-Token", token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("E2B sandbox request failed")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("E2B sandbox request rejected with status %d", resp.StatusCode)
	}
	return resp, nil
}

func (h *handler) e2bFilesList(ctx context.Context, exec *resolvedExecution, creds e2bExecCredentials, resolved string) ([]runnerFSEntry, error) {
	body, err := json.Marshal(map[string]any{"path": resolved, "depth": 1})
	if err != nil {
		return nil, errors.New("E2B filesystem request could not be encoded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e2bFilesURL(exec, e2bFilesListPath), bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("E2B filesystem request could not be built")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.e2bFilesDo(ctx, exec, creds, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, e2bFilesResponseLimit))
	if err != nil {
		return nil, errors.New("E2B sandbox response could not be read")
	}
	var payload struct {
		Entries []e2bEntryInfo `json:"entries"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, errors.New("E2B sandbox response could not be read")
	}
	entries := make([]runnerFSEntry, 0, len(payload.Entries))
	for _, entry := range payload.Entries {
		entries = append(entries, entry.runnerEntry())
	}
	return entries, nil
}

func (h *handler) e2bFilesRead(ctx context.Context, exec *resolvedExecution, creds e2bExecCredentials, resolved string) ([]byte, error) {
	endpoint := e2bFilesHTTPPath + "?path=" + url.QueryEscape(resolved)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e2bFilesURL(exec, endpoint), nil)
	if err != nil {
		return nil, errors.New("E2B filesystem request could not be built")
	}
	resp, err := h.e2bFilesDo(ctx, exec, creds, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, agentFSReadMaxBytes))
	if err != nil {
		return nil, errors.New("E2B sandbox response could not be read")
	}
	return raw, nil
}

func (h *handler) e2bFilesWrite(ctx context.Context, exec *resolvedExecution, creds e2bExecCredentials, resolved string, data []byte) (string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeHeaderValue(resolved)))
	header.Set("Content-Type", "application/octet-stream")
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", errors.New("E2B filesystem request could not be encoded")
	}
	if _, err := part.Write(data); err != nil {
		return "", errors.New("E2B filesystem request could not be encoded")
	}
	if err := writer.Close(); err != nil {
		return "", errors.New("E2B filesystem request could not be encoded")
	}
	endpoint := e2bFilesHTTPPath + "?path=" + url.QueryEscape(resolved)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e2bFilesURL(exec, endpoint), &buffer)
	if err != nil {
		return "", errors.New("E2B filesystem request could not be built")
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := h.e2bFilesDo(ctx, exec, creds, req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, e2bFilesResponseLimit))
	if err != nil {
		return "", errors.New("E2B sandbox response could not be read")
	}
	var written []struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(raw, &written); err == nil {
		for _, item := range written {
			if path := strings.TrimSpace(item.Path); path != "" {
				return path, nil
			}
		}
	}
	return resolved, nil
}

func escapeHeaderValue(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	return strings.ReplaceAll(value, `"`, `\"`)
}

// e2bEntryInfo is envd's filesystem.EntryInfo in its proto3 JSON shape. int64 and
// uint32 fields arrive as strings and numbers depending on the encoder, so they
// are decoded leniently.
type e2bEntryInfo struct {
	Name         string          `json:"name"`
	Type         string          `json:"type"`
	Path         string          `json:"path"`
	Size         json.RawMessage `json:"size"`
	Mode         json.RawMessage `json:"mode"`
	ModifiedTime *e2bEntryTime   `json:"modifiedTime"`
}

type e2bEntryTime struct {
	Seconds json.RawMessage `json:"seconds"`
	Nanos   json.RawMessage `json:"nanos"`
}

func (e e2bEntryInfo) runnerEntry() runnerFSEntry {
	entry := runnerFSEntry{
		Name:  e.Name,
		Path:  e.Path,
		Size:  jsonInt64(e.Size),
		Mode:  fmt.Sprintf("%04o", jsonInt64(e.Mode)),
		IsDir: e.isDir(),
	}
	if e.ModifiedTime != nil {
		entry.ModTime = time.Unix(jsonInt64(e.ModifiedTime.Seconds), jsonInt64(e.ModifiedTime.Nanos)).UTC().Format(time.RFC3339Nano)
	}
	return entry
}

func (e e2bEntryInfo) isDir() bool {
	switch strings.ToUpper(strings.TrimSpace(e.Type)) {
	case "FILE_TYPE_DIRECTORY", "DIRECTORY", "DIR", "2":
		return true
	}
	return false
}

func jsonInt64(raw json.RawMessage) int64 {
	value := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if value == "" {
		return 0
	}
	if n, err := strconv.ParseInt(value, 10, 64); err == nil {
		return n
	}
	if f, err := strconv.ParseFloat(value, 64); err == nil {
		return int64(f)
	}
	return 0
}
