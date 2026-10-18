// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func workspaceRevision(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// openRoot pins the workspace directory before resolving any user-controlled
// child. No global path operations may follow validation of those children.
func (f workspaceFS) openRoot() (*os.Root, error) { return os.OpenRoot(f.root) }
func localWorkspacePath(value string) (string, error) {
	if strings.ContainsAny(value, "\x00:") {
		return "", errors.New("invalid workspace path")
	}
	value = strings.ReplaceAll(value, "\\", "/")
	value = strings.TrimPrefix(value, "/")
	for _, part := range strings.Split(value, "/") {
		if part == ".." {
			return "", errors.New("path escapes workspace")
		}
	}
	clean := path.Clean(value)
	if clean == "/" || strings.HasPrefix(clean, "/") {
		return "", errors.New("invalid workspace path")
	}
	return filepath.FromSlash(clean), nil
}
func (f workspaceFS) openLocal(name string) (*os.File, error) {
	name, err := localWorkspacePath(name)
	if err != nil {
		return nil, err
	}
	root, err := f.openRoot()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Open(name)
}
func (f workspaceFS) statLocal(name string) (os.FileInfo, error) {
	name, err := localWorkspacePath(name)
	if err != nil {
		return nil, err
	}
	root, err := f.openRoot()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Stat(name)
}
func (f workspaceFS) mkdirLocal(name string) error {
	name, err := localWorkspacePath(name)
	if err != nil {
		return err
	}
	root, err := f.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	return root.MkdirAll(name, 0750)
}
func (f workspaceFS) removeLocal(name string, recursive bool) error {
	name, err := localWorkspacePath(name)
	if err != nil {
		return err
	}
	if name == "." {
		return errors.New("cannot delete workspace root")
	}
	root, err := f.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	if recursive {
		return root.RemoveAll(name)
	}
	return root.Remove(name)
}
func (f workspaceFS) renameLocal(from, to string) error {
	from, err := localWorkspacePath(from)
	if err != nil {
		return err
	}
	to, err = localWorkspacePath(to)
	if err != nil {
		return err
	}
	if from == "." || to == "." {
		return errors.New("cannot rename workspace root")
	}
	root, err := f.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	if err = root.MkdirAll(filepath.Dir(to), 0750); err != nil {
		return err
	}
	return root.Rename(from, to)
}

func localTemp(root *os.Root, dir string) (*os.File, string, error) {
	for attempt := 0; attempt < 8; attempt++ {
		var id [16]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, "", err
		}
		name := filepath.Join(dir, ".zakura-write-"+hex.EncodeToString(id[:]))
		file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return file, name, err
	}
	return nil, "", errors.New("could not create workspace temporary file")
}

// Atomic replacement never follows a destination symlink. Root-relative temp
// creation/rename also closes the parent-directory symlink race.
func atomicRootWrite(root *os.Root, name string, src io.Reader, mode os.FileMode, limit int64) error {
	if name == "." {
		return errors.New("path is not a file")
	}
	if err := root.MkdirAll(filepath.Dir(name), 0750); err != nil {
		return err
	}
	tmp, tempName, err := localTemp(root, filepath.Dir(name))
	if err != nil {
		return err
	}
	defer root.Remove(tempName)
	count, err := io.Copy(tmp, io.LimitReader(src, limit+1))
	if err == nil && count > limit {
		err = errors.New("file exceeds workspace size limit")
	}
	if err == nil {
		err = tmp.Chmod(mode & 0777)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return root.Rename(tempName, name)
}
func (f workspaceFS) writeLocal(name string, data []byte, appendMode bool, expected string, mode os.FileMode) ([]byte, error) {
	name, err := localWorkspacePath(name)
	if err != nil {
		return nil, err
	}
	root, err := f.openRoot()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	var existing []byte
	if expected != "" || appendMode {
		file, e := root.Open(name)
		if e == nil {
			info, e := file.Stat()
			if e == nil && (!info.Mode().IsRegular() || info.Size() > maxWorkspaceUpload) {
				e = errors.New("invalid workspace file")
			}
			if e == nil {
				existing, e = io.ReadAll(io.LimitReader(file, maxWorkspaceUpload+1))
			}
			_ = file.Close()
			if e != nil {
				return nil, e
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
		if len(existing) > maxWorkspaceUpload {
			return nil, errors.New("file exceeds workspace size limit")
		}
	}
	if expected != "" && workspaceRevision(existing) != expected {
		return nil, ErrConflict
	}
	if appendMode {
		data = append(existing, data...)
	}
	if len(data) > maxWorkspaceUpload {
		return nil, errors.New("file exceeds workspace size limit")
	}
	if err = atomicRootWrite(root, name, bytes.NewReader(data), mode, maxWorkspaceUpload); err != nil {
		return nil, err
	}
	return data, nil
}
func (f workspaceFS) uploadLocal(name string, src io.Reader) error {
	name, err := localWorkspacePath(name)
	if err != nil {
		return err
	}
	root, err := f.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	return atomicRootWrite(root, name, src, 0640, maxWorkspaceUpload)
}

func archiveRootedWorkspace(f workspaceFS, paths []string) ([]byte, error) {
	root, err := f.openRoot()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	defer gz.Close()
	defer tw.Close()
	var total int64
	entries := 0
	seen := map[string]bool{}
	var add func(string) error
	add = func(name string) error {
		if seen[name] {
			return nil
		}
		seen[name] = true
		entries++
		if entries > 10000 {
			return errors.New("archive has too many entries")
		}
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("workspace symlinks are not archived")
		}
		file, err := root.Open(name)
		if err != nil {
			return err
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil {
			return err
		}
		if !opened.IsDir() && !opened.Mode().IsRegular() {
			return errors.New("workspace special files are not archived")
		}
		if name != "." {
			header, err := tar.FileInfoHeader(opened, "")
			if err != nil {
				return err
			}
			header.Name = filepath.ToSlash(name)
			if opened.IsDir() {
				header.Name += "/"
			}
			if err = tw.WriteHeader(header); err != nil {
				return err
			}
		}
		if opened.IsDir() {
			children, err := file.ReadDir(-1)
			if err != nil {
				return err
			}
			for _, child := range children {
				if err = add(filepath.Join(name, child.Name())); err != nil {
					return err
				}
			}
			return nil
		}
		total += opened.Size()
		if total > maxWorkspaceUpload {
			return errors.New("archive exceeds size limit")
		}
		_, err = io.CopyN(tw, file, opened.Size())
		return err
	}
	for _, name := range paths {
		clean, err := localWorkspacePath(name)
		if err != nil {
			return nil, err
		}
		if err = add(clean); err != nil {
			return nil, err
		}
	}
	if err = tw.Close(); err != nil {
		return nil, err
	}
	if err = gz.Close(); err != nil {
		return nil, err
	}
	return raw.Bytes(), nil
}
func archiveEntryPath(name string) (string, error) {
	if name == "" || strings.HasPrefix(name, "/") || strings.ContainsAny(name, "\\\x00:") {
		return "", errors.New("archive path traversal")
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", errors.New("archive path traversal")
		}
	}
	return localWorkspacePath(name)
}
func extractRootedWorkspace(f workspaceFS, source, destination string) error {
	source, err := localWorkspacePath(source)
	if err != nil {
		return err
	}
	destination, err = localWorkspacePath(destination)
	if err != nil {
		return err
	}
	root, err := f.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	file, err := root.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > maxWorkspaceUpload {
		return errors.New("invalid workspace archive")
	}
	if err = root.MkdirAll(destination, 0750); err != nil {
		return err
	}
	dst, err := root.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer dst.Close()
	if strings.HasSuffix(strings.ToLower(source), ".zip") {
		return extractRootZip(file, info.Size(), dst)
	}
	return extractRootTar(file, source, dst)
}
func extractRootZip(reader io.ReaderAt, size int64, dst *os.Root) error {
	archive, err := zip.NewReader(reader, size)
	if err != nil {
		return err
	}
	var total uint64
	if len(archive.File) > 10000 {
		return errors.New("archive has too many entries")
	}
	for _, entry := range archive.File {
		name, err := archiveEntryPath(entry.Name)
		if err != nil {
			return err
		}
		mode := entry.Mode()
		if !mode.IsDir() && !mode.IsRegular() {
			return errors.New("archive links and special files are not allowed")
		}
		if entry.UncompressedSize64 > maxWorkspaceUpload || total > maxWorkspaceUpload-entry.UncompressedSize64 {
			return errors.New("archive expands beyond limit")
		}
		total += entry.UncompressedSize64
		if mode.IsDir() {
			if err = dst.MkdirAll(name, 0750); err != nil {
				return err
			}
			continue
		}
		in, err := entry.Open()
		if err != nil {
			return err
		}
		err = atomicRootWrite(dst, name, in, mode&0777, int64(entry.UncompressedSize64))
		closeErr := in.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func extractRootTar(file io.Reader, source string, dst *os.Root) error {
	if strings.HasSuffix(strings.ToLower(source), ".gz") || strings.HasSuffix(strings.ToLower(source), ".tgz") {
		gz, err := gzip.NewReader(file)
		if err != nil {
			return err
		}
		defer gz.Close()
		file = gz
	}
	archive := tar.NewReader(file)
	var total int64
	entries := 0
	for {
		entry, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		entries++
		if entries > 10000 {
			return errors.New("archive has too many entries")
		}
		name, err := archiveEntryPath(entry.Name)
		if err != nil {
			return err
		}
		if entry.Size < 0 || entry.Size > maxWorkspaceUpload || total > maxWorkspaceUpload-entry.Size {
			return errors.New("archive expands beyond limit")
		}
		total += entry.Size
		switch entry.Typeflag {
		case tar.TypeDir:
			err = dst.MkdirAll(name, 0750)
		case tar.TypeReg, tar.TypeRegA:
			err = atomicRootWrite(dst, name, archive, os.FileMode(entry.Mode)&0777, entry.Size)
		default:
			return errors.New("archive links and special files are not allowed")
		}
		if err != nil {
			return err
		}
	}
}
