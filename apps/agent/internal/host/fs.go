package host

import (
	"crypto/rand"
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
	Mode    string `json:"mode"`
	ModTime string `json:"modTime"`
}

// Keep path aliases compatible with Jail, but perform every filesystem access
// through an OS root handle. Lexical validation or EvalSymlinks followed by a
// path-based operation is insufficient when an untrusted process swaps parents.
func rootedPath(root, rel string, create bool) (*os.Root, string, error) {
	p, err := Jail(root, rel)
	if err != nil {
		return nil, "", err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, "", err
	}
	relative, err := filepath.Rel(abs, p)
	if err != nil {
		return nil, "", err
	}
	if create {
		if err = os.MkdirAll(abs, 0o755); err != nil {
			return nil, "", err
		}
	}
	handle, err := os.OpenRoot(abs)
	return handle, relative, err
}

func Stat(root, rel string) (Entry, error) {
	return statEntry(root, rel, false)
}

// Lstat reports the final entry itself, including symlink and special-file
// type bits. Parent resolution remains bounded by os.Root; this does not claim
// a snapshot or prevent another process changing the tree between requests.
func Lstat(root, rel string) (Entry, error) {
	return statEntry(root, rel, true)
}

func statEntry(root, rel string, noFollow bool) (Entry, error) {
	r, _, err := rootedPath(root, rel, false)
	if err != nil {
		return Entry{}, err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).Stat(rel, noFollow)
}

// PinnedFS keeps the already verified workspace handle throughout an operation.
// It never reopens the root by pathname or creates a missing workspace root.
type PinnedFS struct {
	Root     *os.Root
	HostPath string
}

func (f PinnedFS) resolve(rel string) (string, error) {
	absolute, err := Jail(f.HostPath, rel)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(f.HostPath)
	if err != nil {
		return "", err
	}
	return filepath.Rel(root, absolute)
}

func (f PinnedFS) Stat(rel string, noFollow bool) (Entry, error) {
	p, err := f.resolve(rel)
	if err != nil {
		return Entry{}, err
	}
	stat := f.Root.Stat
	if noFollow {
		stat = f.Root.Lstat
	}
	st, err := stat(p)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Name: st.Name(), Path: WorkspacePath(f.HostPath, filepath.Join(f.HostPath, p)), IsDir: st.IsDir(), Size: st.Size(), Mode: st.Mode().String(), ModTime: st.ModTime().UTC().Format(time.RFC3339)}, nil
}

func List(root, rel string) ([]Entry, error) {
	r, _, err := rootedPath(root, rel, false)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).List(rel)
}

func (f PinnedFS) List(rel string) ([]Entry, error) {
	p, err := f.resolve(rel)
	if err != nil {
		return nil, err
	}
	ents, err := fs.ReadDir(f.Root.FS(), filepath.ToSlash(p))
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(ents))
	for _, e := range ents {
		child := filepath.Join(p, e.Name())
		info, err := f.Root.Lstat(child)
		if err != nil {
			continue
		}
		out = append(out, Entry{Name: e.Name(), Path: WorkspacePath(f.HostPath, filepath.Join(f.HostPath, child)), IsDir: info.IsDir(), Size: info.Size(), Mode: info.Mode().String(), ModTime: info.ModTime().UTC().Format(time.RFC3339)})
	}
	return out, nil
}

func ReadFile(root, rel string, max int64) ([]byte, error) {
	r, _, err := rootedPath(root, rel, false)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).ReadFile(rel, max)
}

func (pinned PinnedFS) ReadFile(rel string, max int64) ([]byte, error) {
	p, err := pinned.resolve(rel)
	if err != nil {
		return nil, err
	}
	f, err := pinned.Root.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file")
	}
	if max > 0 && st.Size() > max {
		return nil, fmt.Errorf("文件过大（%d > %d）", st.Size(), max)
	}
	var reader io.Reader = f
	if max > 0 {
		reader = io.LimitReader(f, max+1)
	}
	data, err := io.ReadAll(reader)
	if err == nil && max > 0 && int64(len(data)) > max {
		return nil, fmt.Errorf("文件过大")
	}
	return data, err
}

func WriteFile(root, rel string, data []byte) (string, error) {
	r, _, err := rootedPath(root, rel, true)
	if err != nil {
		return "", err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).WriteFile(rel, data)
}

func (f PinnedFS) WriteFile(rel string, data []byte) (string, error) {
	p, err := f.resolve(rel)
	if err != nil {
		return "", err
	}
	if err = f.Root.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if err = f.Root.WriteFile(p, data, 0o644); err != nil {
		return "", err
	}
	return fileRevision(data), nil
}

// WritePrivateFile atomically replaces a credential file without a readable
// intermediate file. Both temp creation and rename use one pinned parent handle,
// so concurrent directory/symlink swaps cannot redirect secrets outside root.
// The regular WriteFile contract intentionally stays 0644 and non-atomic.
func WritePrivateFile(root, rel string, data []byte) (string, error) {
	r, _, err := rootedPath(root, rel, true)
	if err != nil {
		return "", err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).WritePrivateFile(rel, data)
}

func (pinned PinnedFS) WritePrivateFile(rel string, data []byte) (string, error) {
	p, err := pinned.resolve(rel)
	if err != nil {
		return "", err
	}
	r := pinned.Root
	if p == "." {
		return "", fmt.Errorf("invalid private file path")
	}
	parent := filepath.Dir(p)
	if err = r.MkdirAll(parent, 0o700); err != nil {
		return "", err
	}
	dir, err := r.OpenRoot(parent)
	if err != nil {
		return "", err
	}
	defer dir.Close()
	name := filepath.Base(p)
	if st, e := dir.Lstat(name); e == nil {
		if !st.Mode().IsRegular() {
			return "", fmt.Errorf("private destination must be a regular file")
		}
	} else if !os.IsNotExist(e) {
		return "", e
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", err
	}
	temporary := ".zakura-private-" + hex.EncodeToString(nonce[:])
	f, err := dir.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer dir.Remove(temporary)
	defer f.Close()
	if err = f.Chmod(0o600); err != nil {
		return "", err
	}
	if _, err = f.Write(data); err != nil {
		return "", err
	}
	if err = f.Sync(); err != nil {
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	if err = dir.Rename(temporary, name); err != nil {
		return "", err
	}
	return fileRevision(data), nil
}

func fileRevision(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:8]) }

func Mkdir(root, rel string) error {
	r, _, err := rootedPath(root, rel, true)
	if err != nil {
		return err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).Mkdir(rel)
}

func (f PinnedFS) Mkdir(rel string) error {
	p, err := f.resolve(rel)
	if err != nil {
		return err
	}
	return f.Root.MkdirAll(p, 0o755)
}

func Remove(root, rel string, recursive bool) error {
	r, _, err := rootedPath(root, rel, false)
	if err != nil {
		return err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).Remove(rel, recursive)
}

func (f PinnedFS) Remove(rel string, recursive bool) error {
	p, err := f.resolve(rel)
	if err != nil {
		return err
	}
	if p == "." {
		return fmt.Errorf("cannot remove workspace root")
	}
	if recursive {
		return f.Root.RemoveAll(p)
	}
	return f.Root.Remove(p)
}

func Rename(root, oldRel, newRel string) error {
	r, _, err := rootedPath(root, oldRel, false)
	if err != nil {
		return err
	}
	defer r.Close()
	return (PinnedFS{Root: r, HostPath: root}).Rename(oldRel, newRel)
}

func (f PinnedFS) Rename(oldRel, newRel string) error {
	a, err := f.resolve(oldRel)
	if err != nil {
		return err
	}
	b, err := f.resolve(newRel)
	if err != nil {
		return err
	}
	if a == "." || b == "." {
		return fmt.Errorf("cannot rename workspace root")
	}
	if err = f.Root.MkdirAll(filepath.Dir(b), 0o755); err != nil {
		return err
	}
	return f.Root.Rename(a, b)
}

func CopyFile(root, rel string, w io.Writer) error {
	r, p, err := rootedPath(root, rel, false)
	if err != nil {
		return err
	}
	defer r.Close()
	f, err := r.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("not a regular file")
	}
	_, err = io.Copy(w, f)
	return err
}

func WalkJSON(root string) ([]byte, error) {
	r, _, err := rootedPath(root, ".", false)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	var names []string
	_ = fs.WalkDir(r.FS(), ".", func(path string, d fs.DirEntry, err error) error {
		if err == nil {
			names = append(names, filepath.FromSlash(path))
		}
		return nil
	})
	return json.Marshal(names)
}
