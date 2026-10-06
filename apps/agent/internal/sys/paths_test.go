package sys

import (
	"runtime"
	"strings"
	"testing"
)

func TestDefaultDataDirNotHardcodedVarZakura(t *testing.T) {
	d := DefaultDataDir()
	if strings.HasPrefix(d, "/var/zakura") {
		t.Fatalf("数据目录不应写死 /var/zakura，得到 %s", d)
	}
	switch runtime.GOOS {
	case "windows":
		if !strings.Contains(strings.ToLower(d), "zakura") {
			t.Fatalf("Windows 数据目录应含 zakura: %s", d)
		}
	case "darwin":
		if !strings.Contains(d, "Application Support") && !strings.Contains(d, "zakura") {
			t.Fatalf("macOS 数据目录异常: %s", d)
		}
	}
}
