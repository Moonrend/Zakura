package workspace

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound   = errors.New("workspace: not found")
	ErrConflict   = errors.New("workspace: baseline changed")
	ErrUnsafePath = errors.New("workspace: unsafe path")
	ErrLimit      = errors.New("workspace: resource limit exceeded")
	ErrCorrupt    = errors.New("workspace: corrupt object or manifest")
	ErrUnresolved = errors.New("workspace: unresolved merge conflicts")
)

type Options struct {
	MaxFiles      int
	MaxFileBytes  int64
	MaxTotalBytes int64
	MaxPathBytes  int
	MaxTextBytes  int64
}

type Entry struct {
	Path string `json:"path"`
	Hash string `json:"hash"`
	Size int64  `json:"size"`
	Mode uint32 `json:"mode"`
}

type Snapshot struct {
	ID         string  `json:"id"`
	Entries    []Entry `json:"entries"`
	TotalBytes int64   `json:"totalBytes"`
}

type Branch struct {
	ID         string    `json:"id"`
	Base       string    `json:"base"`
	Head       string    `json:"head"`
	Generation uint64    `json:"generation"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type Change struct {
	Kind    string `json:"kind"`
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Before  *Entry `json:"before,omitempty"`
	After   *Entry `json:"after,omitempty"`
}

type Conflict struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Path    string `json:"path"`
	Base    *Entry `json:"base,omitempty"`
	Ours    *Entry `json:"ours,omitempty"`
	Theirs  *Entry `json:"theirs,omitempty"`
	Preview string `json:"preview,omitempty"`
	Source  string `json:"source,omitempty"`
}

type MergePlan struct {
	ID        string     `json:"id"`
	Base      string     `json:"base"`
	Ours      string     `json:"ours"`
	Theirs    string     `json:"theirs"`
	Result    Snapshot   `json:"result"`
	Conflicts []Conflict `json:"conflicts"`
}

type Resolution struct {
	ConflictID  string `json:"conflictId"`
	Choice      string `json:"choice"`
	Content     []byte `json:"content,omitempty"`
	Mode        uint32 `json:"mode,omitempty"`
	Destination string `json:"destination,omitempty"`
}

type Composition struct {
	Snapshot  Snapshot    `json:"snapshot"`
	Plans     []MergePlan `json:"plans"`
	Conflicts []Conflict  `json:"conflicts"`
}

type ApplyResult struct {
	JournalID string   `json:"journalId"`
	Snapshot  Snapshot `json:"snapshot"`
	Branch    *Branch  `json:"branch,omitempty"`
}

type GCOptions struct {
	KeepSnapshots []string
	MinAge        time.Duration
	DryRun        bool
}

type GCResult struct {
	Objects   int   `json:"objects"`
	Manifests int   `json:"manifests"`
	Bytes     int64 `json:"bytes"`
}

// ArtifactManifest binds task-produced files to a verified immutable snapshot.
type ArtifactManifest struct {
	SnapshotID string  `json:"snapshotId"`
	Entries    []Entry `json:"entries"`
}

// CheckContext permits adapters to fail before expensive workspace operations.
func CheckContext(ctx context.Context) error { return ctx.Err() }
