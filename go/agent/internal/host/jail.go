package host

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Jail 把相对工作区路径限制在 root 下（Windows 盘符与斜杠一并处理）。
func Jail(root, rel string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	cleaned := strings.TrimSpace(rel)
	cleaned = strings.ReplaceAll(cleaned, "\\", "/")
	if cleaned == "" || cleaned == "/" {
		return rootAbs, nil
	}
	cleaned = strings.TrimPrefix(cleaned, "/")
	if runtime.GOOS == "windows" {
		if filepath.IsAbs(cleaned) || strings.Contains(cleaned, ":") {
			return "", fmt.Errorf("拒绝绝对路径: %s", rel)
		}
	}
	joined := filepath.Join(rootAbs, filepath.FromSlash(cleaned))
	relToRoot, err := filepath.Rel(rootAbs, joined)
	if err != nil || strings.HasPrefix(relToRoot, "..") {
		return "", fmt.Errorf("路径越狱: %s", rel)
	}
	return joined, nil
}

func AgentWorkspace(storageRoot, agentID string) string {
	return filepath.Join(storageRoot, "agents", agentID, "workspace")
}

func EnsureDir(path string) error {
	return os.MkdirAll(path, 0o755)
}
