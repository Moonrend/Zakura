package sys

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

var (
	shaOnce sync.Once
	shaVal  string
)

func currentSHA256() string {
	shaOnce.Do(func() {
		p, err := os.Executable()
		if err != nil {
			return
		}
		s, err := fileSHA256(p)
		if err != nil {
			return
		}
		shaVal = s
	})
	return shaVal
}

type UpdateParams struct {
	URL      string `json:"url"`
	SHA256   string `json:"sha256"`
	Version  string `json:"version"`
	Restart  bool   `json:"restart"`
}

type UpdateResult struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	BinPath string `json:"binPath"`
	Note    string `json:"note,omitempty"`
}

// Apply 下载新二进制、校验、旁路替换，并按平台重启服务。
func Apply(p UpdateParams) (UpdateResult, error) {
	if p.URL == "" {
		return UpdateResult{}, fmt.Errorf("url 不能为空")
	}
	bin, err := os.Executable()
	if err != nil {
		return UpdateResult{}, err
	}
	if p.SHA256 != "" {
		if cur, err := fileSHA256(bin); err == nil && equalFoldHex(cur, p.SHA256) {
			return UpdateResult{OK: true, Version: p.Version, BinPath: bin, Note: "已是目标版本"}, nil
		}
	}
	tmp := bin + ".new"
	if err := downloadFile(p.URL, tmp); err != nil {
		return UpdateResult{}, err
	}
	if p.SHA256 != "" {
		sum, err := fileSHA256(tmp)
		if err != nil {
			_ = os.Remove(tmp)
			return UpdateResult{}, err
		}
		if !equalFoldHex(sum, p.SHA256) {
			_ = os.Remove(tmp)
			return UpdateResult{}, fmt.Errorf("校验和不匹配：期望 %s 实际 %s", p.SHA256, sum)
		}
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(tmp, 0o755)
	}

	// Windows 不能覆盖正在运行的 exe：交给延迟脚本；Unix 可 rename。
	if runtime.GOOS == "windows" {
		if err := scheduleWindowsReplace(bin, tmp); err != nil {
			return UpdateResult{}, err
		}
		return UpdateResult{
			OK:      true,
			Version: p.Version,
			BinPath: bin,
			Note:    "已安排替换并重启 Windows 服务",
		}, nil
	}

	bak := bin + ".bak"
	_ = os.Remove(bak)
	if err := os.Rename(bin, bak); err != nil {
		// 无写权限时尝试直接覆盖
		if err2 := os.Rename(tmp, bin); err2 != nil {
			return UpdateResult{}, err
		}
	} else if err := os.Rename(tmp, bin); err != nil {
		_ = os.Rename(bak, bin)
		return UpdateResult{}, err
	}
	go restartServiceSoon()
	return UpdateResult{OK: true, Version: p.Version, BinPath: bin}, nil
}

func downloadFile(url, dest string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("下载失败: HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
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

func equalFoldHex(a, b string) bool {
	return hex.EncodeToString(mustDecode(a)) == hex.EncodeToString(mustDecode(b))
}

func mustDecode(s string) []byte {
	b, _ := hex.DecodeString(s)
	return b
}

func restartServiceSoon() {
	time.Sleep(800 * time.Millisecond)
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("launchctl", "kickstart", "-k", "system/"+LaunchdLabel).Start()
		_ = exec.Command("launchctl", "kickstart", "-k", "gui/"+uid()+"/"+LaunchdLabel).Start()
	case "windows":
		restartWindowsService()
	default:
		_ = exec.Command("systemctl", "restart", ServiceName).Start()
		_ = exec.Command("systemctl", "--user", "restart", ServiceName).Start()
	}
}

func restartWindowsService() {
	if err := exec.Command("net", "stop", WindowsService).Run(); err == nil {
		_ = exec.Command("net", "start", WindowsService).Start()
		return
	}
	_ = exec.Command("schtasks", "/End", "/TN", WindowsService).Run()
	_ = exec.Command("schtasks", "/Run", "/TN", WindowsService).Start()
}

func uid() string {
	return fmt.Sprintf("%d", os.Getuid())
}

func scheduleWindowsReplace(bin, tmp string) error {
	script := bin + ".update.cmd"
	content := fmt.Sprintf(
		"ping 127.0.0.1 -n 3 >nul\r\nmove /Y \"%s\" \"%s\"\r\nnet stop %s 2>nul\r\nnet start %s 2>nul\r\nschtasks /End /TN %s 2>nul\r\nschtasks /Run /TN %s 2>nul\r\n",
		tmp, bin, WindowsService, WindowsService, WindowsService, WindowsService)
	if err := os.WriteFile(script, []byte(content), 0o644); err != nil {
		return err
	}
	cmd := exec.Command("cmd.exe", "/C", "start", "/B", script)
	cmd.Dir = filepath.Dir(bin)
	return cmd.Start()
}
