// Package statefs provides pinned, no-follow access to durable node metadata.
package statefs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func Child(parent *os.Root, name string) (*os.Root, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("state directory is not a real directory")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	file, err := root.Open(".")
	if err != nil {
		root.Close()
		return nil, err
	}
	after, statErr := file.Stat()
	file.Close()
	if statErr != nil || !os.SameFile(before, after) {
		root.Close()
		return nil, fmt.Errorf("state directory changed during access")
	}
	return root, nil
}

func OpenRoot(path string) (*os.Root, error) {
	if path == "" {
		return nil, fmt.Errorf("state root is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	volume := filepath.VolumeName(absolute)
	root, err := os.OpenRoot(volume + string(filepath.Separator))
	if err != nil {
		return nil, err
	}
	for component := range strings.SplitSeq(strings.TrimPrefix(absolute[len(volume):], string(filepath.Separator)), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		child, err := Child(root, component)
		root.Close()
		if err != nil {
			return nil, err
		}
		root = child
	}
	return root, nil
}

func MakeChild(parent *os.Root, name string, mode fs.FileMode) (*os.Root, error) {
	if err := parent.Mkdir(name, mode); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	if err := Sync(parent); err != nil {
		return nil, err
	}
	return Child(parent, name)
}

func OpenRegular(root *os.Root, name string, limit int64) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, fmt.Errorf("invalid state record")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || after.Size() > limit || !os.SameFile(before, after) {
		file.Close()
		return nil, fmt.Errorf("state record changed during access")
	}
	return file, nil
}
