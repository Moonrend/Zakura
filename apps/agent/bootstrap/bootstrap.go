// Package bootstrap handles a local installation's private node enrollment
// material. Neither bootstrap secrets nor node tokens belong in logs or UI.
package bootstrap

import (
	"context"
	"crypto/rand"
	"errors"
	"io/fs"

	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	"github.com/Moonrend/Zakura/apps/agent/workspace"
)

type Installation struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Secret  string `json:"secret"`
}

func (i Installation) Valid() bool {
	return i.Version == 1 && workspace.ValidIdentity(i.ID) && len(i.Secret) >= 40 && len(i.Secret) <= 256
}

// Initialize is called only by the control plane with a dedicated writable
// bootstrap volume. The node receives this volume read-only.
func Initialize(ctx context.Context, directory string) (Installation, error) {
	root, err := statefs.OpenRoot(directory)
	if err != nil {
		return Installation{}, err
	}
	defer root.Close()
	unlock, err := statefs.Lock(ctx, root)
	if err != nil {
		return Installation{}, err
	}
	defer unlock()
	var installation Installation
	err = statefs.Read(root, "installation.json", &installation)
	if errors.Is(err, fs.ErrNotExist) {
		installation = Installation{Version: 1, ID: rand.Text(), Secret: rand.Text() + rand.Text()}
		err = statefs.Write(root, "installation.json", installation, false)
	}
	if err != nil {
		return Installation{}, err
	}
	if !installation.Valid() {
		return Installation{}, errors.New("invalid node bootstrap installation")
	}
	return installation, nil
}

func Read(directory string) (Installation, error) {
	root, err := statefs.OpenRoot(directory)
	if err != nil {
		return Installation{}, err
	}
	defer root.Close()
	var installation Installation
	if err := statefs.Read(root, "installation.json", &installation); err != nil {
		return Installation{}, err
	}
	if !installation.Valid() {
		return Installation{}, errors.New("invalid node bootstrap installation")
	}
	return installation, nil
}

type Request struct {
	InstallationID  string `json:"installationId"`
	NodeIncarnation string `json:"nodeIncarnation"`
}

type Credential struct {
	InstallationID  string `json:"installationId"`
	NodeID          string `json:"nodeId"`
	NodeIncarnation string `json:"nodeIncarnation"`
	Token           string `json:"token"`
}
