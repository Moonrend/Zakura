package main

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/docker"
	"github.com/Moonrend/Zakura/apps/agent/internal/statefs"
	"github.com/Moonrend/Zakura/apps/agent/internal/workspacestate"
)

type healthRecord struct {
	ConnectedAt time.Time `json:"connectedAt"`
}

func startHealth(state string) (func(), func(), error) {
	root, err := statefs.OpenRoot(state)
	if err != nil {
		return nil, nil, err
	}
	defer root.Close()
	directory, err := statefs.MakeChild(root, ".health", 0700)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	unlock, err := statefs.Lock(ctx, directory)
	if err != nil {
		directory.Close()
		return nil, nil, err
	}
	if err := statefs.Write(directory, "connection.json", healthRecord{}, true); err != nil {
		unlock()
		directory.Close()
		return nil, nil, err
	}
	return func() {
		if err := statefs.Write(directory, "connection.json", healthRecord{ConnectedAt: time.Now().UTC()}, true); err != nil {
			log.Print("node health heartbeat could not be saved")
		}
	}, func() { _ = directory.Remove("connection.json"); unlock(); directory.Close() }, nil
}

func checkHealth(state, data, volume string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	root, err := statefs.OpenRoot(state)
	if err != nil {
		return err
	}
	defer root.Close()
	directory, err := statefs.Child(root, ".health")
	if err != nil {
		return err
	}
	defer directory.Close()
	var record healthRecord
	if err := statefs.Read(directory, "connection.json", &record); err != nil {
		return err
	}
	age := time.Since(record.ConnectedAt)
	if record.ConnectedAt.IsZero() || age < 0 || age > 45*time.Second {
		return errors.New("control plane connection is unavailable")
	}
	if volume == "" {
		return errors.New("workspace volume is not configured")
	}
	if err := docker.VerifyWorkspaceVolume(ctx, volume, data); err != nil {
		return err
	}
	_, err = (workspacestate.Store{StateRoot: state, DataRoot: data, VolumeName: volume}).Identity(ctx)
	return err
}
