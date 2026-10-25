package statefs

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

const recordLimit = 65536

func Read(root *os.Root, name string, value any) error {
	file, err := OpenRegular(root, name, recordLimit)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, recordLimit+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return fmt.Errorf("invalid state record tail")
	}
	return nil
}

// Write publishes a complete, synced record. Replacement requires the caller to
// hold the state lock; immutable publication never replaces an existing file.
func Write(root *os.Root, name string, value any, replace bool) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > recordLimit {
		return fmt.Errorf("state record too large")
	}
	if before, err := root.Lstat(name); err == nil {
		if !replace || !before.Mode().IsRegular() {
			return fs.ErrExist
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	temporary := ".state-" + rand.Text()
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	_, err = io.Copy(file, bytes.NewReader(raw))
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if replace {
		err = root.Rename(temporary, name)
	} else {
		err = root.Link(temporary, name)
	}
	if err != nil {
		return err
	}
	return Sync(root)
}
