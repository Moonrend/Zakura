package host

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

type Entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

func Stat(root, rel string) (Entry, error) {
	p, err := Jail(root, rel)
	if err != nil {
		return Entry{}, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return Entry{}, err
	}
	return Entry{
		Name:    st.Name(),
		Path:    WorkspacePath(root, p),
		IsDir:   st.IsDir(),
		Size:    st.Size(),
		ModTime: st.ModTime().UTC().Format(time.RFC3339),
	}, nil
}

func List(root, rel string) ([]Entry, error) {
	p, err := Jail(root, rel)
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(p)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(ents))
	for _, e := range ents {
		info, err := e.Info()
		if err != nil {
			continue
		}
		name := e.Name()
		out = append(out, Entry{
			Name:    name,
			Path:    WorkspacePath(root, filepath.Join(p, name)),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return out, nil
}

func ReadFile(root, rel string, max int64) ([]byte, error) {
	p, err := Jail(root, rel)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, fmt.Errorf("是目录")
	}
	if max > 0 && st.Size() > max {
		return nil, fmt.Errorf("文件过大（%d > %d）", st.Size(), max)
	}
	return os.ReadFile(p)
}

func WriteFile(root, rel string, data []byte) (string, error) {
	p, err := Jail(root, rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8]), nil
}

func Mkdir(root, rel string) error {
	p, err := Jail(root, rel)
	if err != nil {
		return err
	}
	return os.MkdirAll(p, 0o755)
}

func Remove(root, rel string, recursive bool) error {
	p, err := Jail(root, rel)
	if err != nil {
		return err
	}
	if recursive {
		return os.RemoveAll(p)
	}
	return os.Remove(p)
}

func Rename(root, oldRel, newRel string) error {
	a, err := Jail(root, oldRel)
	if err != nil {
		return err
	}
	b, err := Jail(root, newRel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(b), 0o755); err != nil {
		return err
	}
	return os.Rename(a, b)
}

func CopyFile(root, rel string, w io.Writer) error {
	p, err := Jail(root, rel)
	if err != nil {
		return err
	}
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}

func WalkJSON(root string) ([]byte, error) {
	var names []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		names = append(names, rel)
		return nil
	})
	return json.Marshal(names)
}
