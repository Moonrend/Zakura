// Package workspace defines the pinned identities shared by the control plane
// and node. These are opaque identities; only Locator contains a relative path.
package workspace

import (
	"errors"
	"path"
	"regexp"
	"strings"
)

var identityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)

func ValidIdentity(value string) bool { return identityPattern.MatchString(value) }

type Locator struct {
	Kind         string `json:"kind"`
	RelativePath string `json:"relativePath"`
}

func (l Locator) Validate() error {
	if l.Kind != "directory" && l.Kind != "legacy-bind" {
		return errors.New("unsupported workspace disk locator")
	}
	if l.RelativePath == "" || strings.ContainsAny(l.RelativePath, "\\:\x00") || strings.HasPrefix(l.RelativePath, "/") || path.Clean(l.RelativePath) != l.RelativePath {
		return errors.New("invalid workspace disk path")
	}
	parts := strings.Split(l.RelativePath, "/")
	prefix := "disks"
	if l.Kind == "legacy-bind" {
		prefix = "spaces"
	}
	if len(parts) != 3 || parts[0] != prefix || !ValidIdentity(parts[1]) || strings.Contains(parts[1], ":") || parts[2] != "workspace" {
		return errors.New("disk path must identify one workspace directory")
	}
	return nil
}

type Target struct {
	TenantID        string `json:"tenantId"`
	SpaceID         string `json:"spaceId"`
	InstanceID      string `json:"instanceId"`
	Generation      int64  `json:"generation"`
	NodeID          string `json:"nodeId"`
	NodeIncarnation string `json:"nodeIncarnation"`
	DiskID          string `json:"diskId"`
	LocatorVersion  int64  `json:"locatorVersion"`
}

func (t Target) Validate() error {
	for _, value := range []string{t.TenantID, t.SpaceID, t.InstanceID, t.NodeID, t.NodeIncarnation, t.DiskID} {
		if !ValidIdentity(value) {
			return errors.New("workspace target identity is incomplete")
		}
	}
	if t.Generation < 1 || t.LocatorVersion < 1 {
		return errors.New("workspace target version is invalid")
	}
	return nil
}

// Disk is tenant-scoped storage. SpaceID is set only for legacy-bind disks,
// whose directory is still named after the Space that created it; managed
// directory disks can be attached by any Space of the tenant.
type Disk struct {
	TenantID        string  `json:"tenantId"`
	SpaceID         string  `json:"spaceId,omitempty"`
	DiskID          string  `json:"diskId"`
	NodeIncarnation string  `json:"nodeIncarnation"`
	LocatorVersion  int64   `json:"locatorVersion"`
	Locator         Locator `json:"locator"`
}

func (d Disk) Validate() error {
	for _, value := range []string{d.TenantID, d.DiskID, d.NodeIncarnation} {
		if !ValidIdentity(value) {
			return errors.New("workspace disk identity is incomplete")
		}
	}
	if d.Locator.Kind == "legacy-bind" && !ValidIdentity(d.SpaceID) || d.Locator.Kind != "legacy-bind" && d.SpaceID != "" {
		return errors.New("workspace disk owner does not match its locator")
	}
	if d.LocatorVersion < 1 {
		return errors.New("workspace disk version is invalid")
	}
	if err := d.Locator.Validate(); err != nil {
		return err
	}
	id := d.DiskID
	if d.Locator.Kind == "legacy-bind" {
		id = d.SpaceID
	}
	if strings.Split(d.Locator.RelativePath, "/")[1] != id {
		return errors.New("workspace disk locator does not match ownership")
	}
	return nil
}

func (d Disk) Matches(t Target) bool {
	return d.TenantID == t.TenantID && (d.SpaceID == "" || d.SpaceID == t.SpaceID) && d.DiskID == t.DiskID && d.NodeIncarnation == t.NodeIncarnation && d.LocatorVersion == t.LocatorVersion
}

type Binding struct {
	Target Target `json:"target"`
	Disk   Disk   `json:"disk"`
}

func (b Binding) Validate() error {
	if err := b.Target.Validate(); err != nil {
		return err
	}
	if err := b.Disk.Validate(); err != nil {
		return err
	}
	if !b.Disk.Matches(b.Target) {
		return errors.New("workspace target and disk do not match")
	}
	return nil
}
