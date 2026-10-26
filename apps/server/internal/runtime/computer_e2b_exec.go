package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
)

// E2B envd speaks the Connect protocol. Process commands use the server-streaming
// RPC process.Process/Start over application/connect+json; envd is reached on
// port 49983 at "<port>-<sandboxID>.<domain>".
const (
	e2bEnvdPort      = 49983
	e2bDefaultDomain = "e2b.dev"
	e2bExecPath      = "/process.Process/Start"
	e2bExecDefaultMS = 30_000
	e2bExecMaxMS     = 300_000
)

// e2bExecBaseURLOverride replaces the derived sandbox base URL. Tests point it
// at a fake envd server; it stays empty in production.
var e2bExecBaseURLOverride string

// e2bSandboxHost mirrors the E2B SDK's ConnectionConfig.getHost: the public host
// for a sandbox port is "<port>-<sandboxID>.<domain>".
func e2bSandboxHost(sandboxID string, port int, domain string) string {
	d := strings.TrimSpace(domain)
	if d == "" {
		d = e2bDefaultDomain
	}
	return fmt.Sprintf("%d-%s.%s", port, sandboxID, d)
}

// e2bDomainFromAPIBase derives the sandbox domain from the control-plane base
// (https://api.e2b.dev -> e2b.dev); unparseable input falls back to the default.
func e2bDomainFromAPIBase(apiBase string) string {
	parsed, err := url.Parse(strings.TrimSpace(apiBase))
	if err != nil || parsed.Hostname() == "" {
		return e2bDefaultDomain
	}
	host := strings.TrimPrefix(parsed.Hostname(), "api.")
	if host == "" {
		return e2bDefaultDomain
	}
	return host
}

func e2bSandboxBaseURL(sandboxID string) string {
	if override := strings.TrimSpace(e2bExecBaseURLOverride); override != "" {
		return strings.TrimRight(override, "/")
	}
	return "https://" + e2bSandboxHost(sandboxID, e2bEnvdPort, e2bDomainFromAPIBase(defaultE2BAPIBase))
}

// e2bExecCredentials is the subset of a computer's E2B envelope needed to reach
// envd. envdAccessToken is optional: when absent the sandbox is contacted
// without a token.
type e2bExecCredentials struct {
	APIKey          string `json:"apiKey"`
	EnvdAccessToken string `json:"envdAccessToken"`
}

func (h *handler) e2bExecCredentials(ctx context.Context, exec *resolvedExecution) (e2bExecCredentials, error) {
	var envelope string
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COALESCE(secret_ref,'') FROM computers WHERE tenant_id=? AND space_id=? AND id=?`), exec.computer.TenantID, exec.computer.SpaceID, exec.computer.ID).Scan(&envelope)
	if err != nil || strings.TrimSpace(envelope) == "" {
		return e2bExecCredentials{}, errors.New("computer has no E2B configuration")
	}
	plain, err := computers.OpenCredentials(h.deps.Secret, exec.computer.TenantID, exec.computer.SpaceID, exec.computer.ID, envelope)
	if err != nil {
		return e2bExecCredentials{}, errors.New("computer E2B configuration could not be opened")
	}
	var creds e2bExecCredentials
	if err := json.Unmarshal(plain, &creds); err != nil {
		return e2bExecCredentials{}, errors.New("computer E2B configuration is invalid")
	}
	if strings.TrimSpace(creds.APIKey) == "" {
		return e2bExecCredentials{}, errors.New("computer E2B configuration is incomplete")
	}
	if strings.TrimSpace(creds.EnvdAccessToken) == "" {
		creds.EnvdAccessToken = h.e2bRuntimeAccessToken(ctx, exec)
	}
	return creds, nil
}

// e2bRuntimeAccessToken reads the token E2B issued when the sandbox was created,
// which CompleteCreation persisted as a sealed envelope on the runtime row. A
// missing row or envelope means no token (sandboxes reconciled without one), and
// envd execution then runs unauthenticated as before.
func (h *handler) e2bRuntimeAccessToken(ctx context.Context, exec *resolvedExecution) string {
	r := exec.runtime
	if strings.TrimSpace(r.ID) == "" {
		return ""
	}
	var envelope string
	err := h.deps.DB.QueryRowContext(ctx, h.deps.Rebind(`SELECT COALESCE(access_token_enc,'') FROM computer_runtimes WHERE tenant_id=? AND space_id=? AND computer_id=? AND id=? AND incarnation=?`), r.TenantID, r.SpaceID, r.ComputerID, r.ID, r.Incarnation).Scan(&envelope)
	if err != nil || strings.TrimSpace(envelope) == "" {
		return ""
	}
	plain, err := computers.OpenCredentials(h.deps.Secret, r.TenantID, r.SpaceID, r.ComputerID, envelope)
	if err != nil {
		return ""
	}
	var stored struct {
		EnvdAccessToken string `json:"envdAccessToken"`
	}
	if err := json.Unmarshal(plain, &stored); err != nil {
		return ""
	}
	return strings.TrimSpace(stored.EnvdAccessToken)
}

// e2bComputerExec runs one command inside the E2B sandbox pinned to this run. It
// returns the same result shape as the container transport so the tool layer is
// provider-agnostic.
func (h *handler) e2bComputerExec(ctx context.Context, exec *resolvedExecution, executionTimeoutMS int64, command string, args ...string) (map[string]any, error) {
	if strings.TrimSpace(exec.containerID) == "" {
		return nil, errors.New("computer runtime has no verified sandbox")
	}
	creds, err := h.e2bExecCredentials(ctx, exec)
	if err != nil {
		return nil, err
	}
	timeoutMS := executionTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = e2bExecDefaultMS
	}
	if timeoutMS > e2bExecMaxMS {
		timeoutMS = e2bExecMaxMS
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline).Milliseconds()
		if remaining <= 0 {
			return nil, context.DeadlineExceeded
		}
		if remaining < timeoutMS {
			timeoutMS = remaining
		}
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()

	payload, err := json.Marshal(map[string]any{
		"process": map[string]any{"cmd": command, "args": args, "cwd": "/workspace"},
	})
	if err != nil {
		return nil, errors.New("E2B process request could not be encoded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e2bSandboxBaseURL(exec.containerID)+e2bExecPath, bytes.NewReader(e2bEnvelope(0, payload)))
	if err != nil {
		return nil, errors.New("E2B process request could not be built")
	}
	req.Header.Set("Content-Type", "application/connect+json")
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
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Never echo the response body: it can carry credentials or signed URLs.
		return nil, fmt.Errorf("E2B sandbox request rejected with status %d", resp.StatusCode)
	}
	stdout, stderr, exitCode, err := e2bReadStream(ctx, resp.Body)
	if err != nil {
		return nil, err
	}
	result := map[string]any{
		"exitCode":                float64(exitCode),
		"stdout":                  stdout,
		"stderr":                  stderr,
		"executionMode":           "workspace-container",
		"isolated":                true,
		"restrictedPolicyApplied": false,
	}
	if exitCode != 0 {
		return result, fmt.Errorf("command exited %d: %v", exitCode, stderr)
	}
	return result, nil
}

// e2bEnvelope frames a message with the Connect 5-byte prefix (1 flag byte plus a
// 4-byte big-endian length). Request streams never set the end-stream bit.
func e2bEnvelope(flags byte, payload []byte) []byte {
	frame := make([]byte, 5+len(payload))
	frame[0] = flags
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)
	return frame
}

// e2bReadStream consumes an envd server stream: message frames carry process
// events, and the final end-stream frame (flag 0x02) carries success or an error.
func e2bReadStream(ctx context.Context, body io.Reader) (string, string, int, error) {
	reader := bufio.NewReader(body)
	var stdout, stderr strings.Builder
	exitCode := 0
	for {
		header := make([]byte, 5)
		if _, err := io.ReadFull(reader, header); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			if ctx.Err() != nil {
				return "", "", 0, ctx.Err()
			}
			return "", "", 0, errors.New("E2B sandbox response could not be read")
		}
		payload := make([]byte, binary.BigEndian.Uint32(header[1:5]))
		if _, err := io.ReadFull(reader, payload); err != nil {
			if ctx.Err() != nil {
				return "", "", 0, ctx.Err()
			}
			return "", "", 0, errors.New("E2B sandbox response could not be read")
		}
		if header[0]&0x02 != 0 {
			var end struct {
				Error *struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if len(payload) > 0 {
				_ = json.Unmarshal(payload, &end)
			}
			if end.Error != nil && strings.TrimSpace(end.Error.Code) != "" {
				return "", "", 0, fmt.Errorf("E2B sandbox process failed: %s", end.Error.Code)
			}
			break
		}
		var msg struct {
			Event *struct {
				Data *struct {
					Stdout string `json:"stdout"`
					Stderr string `json:"stderr"`
				} `json:"data"`
				End *struct {
					ExitCode int `json:"exitCode"`
				} `json:"end"`
			} `json:"event"`
		}
		if err := json.Unmarshal(payload, &msg); err != nil || msg.Event == nil {
			continue
		}
		if msg.Event.Data != nil {
			stdout.Write(e2bDecode(msg.Event.Data.Stdout))
			stderr.Write(e2bDecode(msg.Event.Data.Stderr))
		}
		if msg.Event.End != nil {
			exitCode = msg.Event.End.ExitCode
		}
	}
	return stdout.String(), stderr.String(), exitCode, nil
}

func e2bDecode(data string) []byte {
	if data == "" {
		return nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(data); err == nil {
		return decoded
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(data); err == nil {
		return decoded
	}
	return nil
}
