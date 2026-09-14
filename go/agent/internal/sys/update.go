package sys

import (
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const updateTimeout = 10 * time.Minute

// Resolve symlinks once, before replacing the running inode. On Linux,
// os.Executable can otherwise start returning the backup's name after a rename.
var executablePath = sync.OnceValues(func() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
})

var runningSHA = sync.OnceValue(func() string {
	p, err := executablePath()
	if err != nil {
		return ""
	}
	sum, _ := fileSHA256(p)
	return sum
})

func currentSHA256() string { return runningSHA() }

type UpdateParams struct {
	URL            string `json:"url"`
	SHA256         string `json:"sha256"`
	Version        string `json:"version"`
	Restart        bool   `json:"restart"`
	ProgressStream string `json:"progressStream,omitempty"`
}

type UpdateProgress struct {
	Phase           string `json:"phase"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
}

type UpdateResult struct {
	OK             bool   `json:"ok"`
	Version        string `json:"version"`
	SHA256         string `json:"sha256"`
	BinPath        string `json:"binPath"`
	AlreadyCurrent bool   `json:"alreadyCurrent"`
	Restarting     bool   `json:"restarting"`
	Note           string `json:"note,omitempty"`
	afterReply     func()
}

// AfterReply must be called only after the RPC response has been written.
func (r UpdateResult) AfterReply() {
	if r.afterReply != nil {
		go r.afterReply()
	}
}

type updater struct {
	mu          sync.Mutex
	binary      func() (string, error)
	runningSHA  func() string
	restart     func(bin, staged string) error
	lastError   atomic.Value
	idleTimeout time.Duration
}

var selfUpdater = &updater{
	binary: executablePath, runningSHA: currentSHA256, restart: restartSelf,
	idleTimeout: 30 * time.Second,
}

func (u *updater) errorMessage() string {
	v, _ := u.lastError.Load().(string)
	if v == "" && runtime.GOOS == "windows" {
		if bin, err := u.binary(); err == nil {
			if b, err := os.ReadFile(bin + ".update-error"); err == nil {
				v = string(b)
			}
		}
	}
	return v
}

func Apply(ctx context.Context, p UpdateParams, progress func(UpdateProgress)) (UpdateResult, error) {
	return selfUpdater.apply(ctx, p, progress)
}

func (u *updater) apply(ctx context.Context, p UpdateParams, progress func(UpdateProgress)) (UpdateResult, error) {
	if !u.mu.TryLock() {
		return UpdateResult{}, fmt.Errorf("已有代理更新正在进行，请等待完成")
	}
	unlock := true
	defer func() {
		if unlock {
			u.mu.Unlock()
		}
	}()
	p.SHA256 = strings.TrimSpace(p.SHA256)
	if !validSHA256(p.SHA256) {
		return UpdateResult{}, fmt.Errorf("sha256 必须是 64 位十六进制摘要")
	}
	parsed, err := url.Parse(p.URL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return UpdateResult{}, fmt.Errorf("url 必须是 HTTP(S) 二进制下载地址")
	}
	if runtime.GOOS == "windows" && !p.Restart {
		return UpdateResult{}, fmt.Errorf("Windows 自更新需要允许重启")
	}
	bin, err := u.binary()
	if err != nil {
		return UpdateResult{}, err
	}
	u.lastError.Store("")
	if runtime.GOOS == "windows" {
		_ = os.Remove(bin + ".update-error")
	}
	result := UpdateResult{OK: true, Version: p.Version, SHA256: strings.ToLower(p.SHA256), BinPath: bin}
	// Compare the running binary, not a file installed by an earlier, unrestarted update.
	if equalFoldHex(u.runningSHA(), p.SHA256) {
		result.AlreadyCurrent = true
		result.Note = "已是目标版本"
		return result, nil
	}

	ctx, cancel := context.WithTimeout(ctx, updateTimeout)
	defer cancel()
	f, err := os.CreateTemp(filepath.Dir(bin), ".zakura-agent-update-*")
	if err != nil {
		return UpdateResult{}, fmt.Errorf("无法写入代理安装目录: %w", err)
	}
	tmp := f.Name()
	keepStaged := false
	defer func() {
		_ = f.Close()
		if !keepStaged {
			_ = os.Remove(tmp)
		}
	}()
	report := func(phase string) {
		if progress != nil {
			progress(UpdateProgress{Phase: phase})
		}
	}
	report("downloading")
	sum, err := downloadFile(ctx, p.URL, f, u.idleTimeout, progress)
	if err != nil {
		return UpdateResult{}, err
	}
	report("verifying")
	if !equalFoldHex(sum, p.SHA256) {
		return UpdateResult{}, fmt.Errorf("校验和不匹配：期望 %s 实际 %s", p.SHA256, sum)
	}
	if err := f.Sync(); err != nil {
		return UpdateResult{}, err
	}
	if err := f.Close(); err != nil {
		return UpdateResult{}, err
	}
	if err := validateAgentBinary(tmp); err != nil {
		return UpdateResult{}, err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		return UpdateResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return UpdateResult{}, err
	}
	report("installing")
	if runtime.GOOS != "windows" {
		if err := replaceBinary(bin, tmp); err != nil {
			return UpdateResult{}, err
		}
	}
	if !p.Restart {
		result.Note = "已安装，重启代理后生效"
		return result, nil
	}
	keepStaged = runtime.GOOS == "windows"
	result.Restarting = true
	unlock = false // Hold through the response and restart; a second update must not overwrite the backup.
	result.afterReply = sync.OnceFunc(func() {
		if err := u.restart(bin, tmp); err != nil {
			if runtime.GOOS != "windows" {
				if rollbackErr := os.Rename(bin+".bak", bin); rollbackErr != nil {
					err = fmt.Errorf("%w；回滚失败: %v", err, rollbackErr)
				}
			}
			_ = os.Remove(tmp)
			u.lastError.Store("代理重启失败: " + err.Error())
			log.Print(u.errorMessage())
			u.mu.Unlock()
		}
	})
	return result, nil
}

// Keep the old executable at its original path until the single atomic rename.
// A backup copy also works on filesystems that do not support hard links.
func replaceBinary(bin, tmp string) error {
	bak := bin + ".bak"
	if err := os.Remove(bak); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Link(bin, bak); err != nil {
		if err := copyBinary(bin, bak); err != nil {
			return fmt.Errorf("备份代理失败: %w", err)
		}
	}
	if err := os.Rename(tmp, bin); err != nil {
		return fmt.Errorf("替换代理失败（原代理保留）: %w", err)
	}
	return nil
}

func copyBinary(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	return out.Close()
}

func validateAgentBinary(path string) error {
	info, err := buildinfo.ReadFile(path)
	if err != nil || info.Path != "zakura.dev/agent/cmd/zakura-agent" {
		return fmt.Errorf("下载内容不是可用的 zakura-agent 二进制")
	}
	settings := map[string]string{}
	for _, s := range info.Settings {
		settings[s.Key] = s.Value
	}
	if settings["GOOS"] != runtime.GOOS || settings["GOARCH"] != runtime.GOARCH {
		return fmt.Errorf("二进制平台 %s/%s 与本机 %s/%s 不匹配", settings["GOOS"], settings["GOARCH"], runtime.GOOS, runtime.GOARCH)
	}
	return nil
}

func downloadFile(ctx context.Context, url string, dest io.Writer, idleTimeout time.Duration, progress func(UpdateProgress)) (string, error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	// Bound stalled headers and stalled bodies, while allowing a slow but active download.
	idle := time.AfterFunc(idleTimeout, func() { cancel(fmt.Errorf("下载停滞超过 %s，请检查网络后重试", idleTimeout)) })
	defer idle.Stop()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", context.Cause(ctx)
		}
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载失败: HTTP %d", resp.StatusCode)
	}
	h := sha256.New()
	writer := &downloadWriter{dest: io.MultiWriter(dest, h), idle: idle, idleTimeout: idleTimeout,
		progress: progress, total: max(resp.ContentLength, 0)}
	_, err = io.Copy(writer, resp.Body)
	if ctx.Err() != nil {
		return "", context.Cause(ctx)
	}
	if err != nil {
		return "", err
	}
	writer.report()
	return hex.EncodeToString(h.Sum(nil)), nil
}

type downloadWriter struct {
	dest        io.Writer
	idle        *time.Timer
	idleTimeout time.Duration
	progress    func(UpdateProgress)
	total       int64
	downloaded  int64
	lastReport  time.Time
}

func (w *downloadWriter) Write(p []byte) (int, error) {
	n, err := w.dest.Write(p)
	w.downloaded += int64(n)
	w.idle.Reset(w.idleTimeout)
	if time.Since(w.lastReport) >= 250*time.Millisecond {
		w.report()
	}
	return n, err
}

func (w *downloadWriter) report() {
	if w.progress != nil {
		w.progress(UpdateProgress{Phase: "downloading", DownloadedBytes: w.downloaded, TotalBytes: w.total})
	}
	w.lastReport = time.Now()
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func validSHA256(s string) bool {
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == sha256.Size
}

func equalFoldHex(a, b string) bool {
	return validSHA256(a) && validSHA256(b) && strings.EqualFold(a, b)
}
