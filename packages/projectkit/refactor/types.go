// Package refactor creates type-checked Go rename patches from immutable source
// snapshots. It never executes project source code or downloads dependencies.
package refactor

import (
	"context"
	"errors"
	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
)

const Version = "go-rename-v1"

var ErrIncomplete = errors.New("refactor: complete local type information is required")
var ErrInvalid = errors.New("refactor: invalid rename request")
var ErrConflict = errors.New("refactor: rename changes resolution or produces a collision")
var ErrLimit = errors.New("refactor: resource limit exceeded")

const MaxFiles = 500
const MaxFileBytes = 1 << 20
const MaxTotalBytes = 8 << 20
const MaxNodes = 200000
const MaxEdits = 20000

type Source = semantic.Source
type Request struct {
	SnapshotID string `json:"snapshotId"`
	Path       string `json:"path"`
	Offset     *int   `json:"offset,omitempty"`
	SymbolID   string `json:"symbolId,omitempty"`
	NewName    string `json:"newName"`
}
type Selection struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Path     string `json:"path"`
	Offset   int    `json:"offset"`
	Package  string `json:"package"`
	Exported bool   `json:"exported"`
}
type TextEdit struct {
	Start   int    `json:"start"`
	End     int    `json:"end"`
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}
type FilePatch struct {
	Path       string     `json:"path"`
	BeforeHash string     `json:"beforeHash"`
	AfterHash  string     `json:"afterHash"`
	Edits      []TextEdit `json:"edits"`
}
type Preview struct {
	ID                  string      `json:"id"`
	Version             string      `json:"version"`
	SnapshotID          string      `json:"snapshotId"`
	Request             Request     `json:"request"`
	Selection           Selection   `json:"selection"`
	NewName             string      `json:"newName"`
	Files               []FilePatch `json:"files"`
	References          int         `json:"references"`
	CheckedPackages     []string    `json:"checkedPackages"`
	ExportedAPIChanged  bool        `json:"exportedApiChanged"`
	RequiresHumanReview bool        `json:"requiresHumanReview"`
	Warnings            []string    `json:"warnings"`
}
type Candidate struct {
	ID string `json:"id"`

	PreviewID           string      `json:"previewId"`
	BranchID            string      `json:"branchId"`
	SnapshotID          string      `json:"snapshotId"`
	BaseSnapshot        string      `json:"baseSnapshot"`
	Files               []FilePatch `json:"files"`
	ExportedAPIChanged  bool        `json:"exportedApiChanged"`
	RequiresHumanReview bool        `json:"requiresHumanReview"`
	AcceptanceInherited bool        `json:"acceptanceInherited"`
}
type MemorySource struct {
	Snapshot    string
	FilesByPath map[string]string
}

func (m MemorySource) Files(ctx context.Context, id string) ([]semantic.InputFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if id != m.Snapshot {
		return nil, ErrInvalid
	}
	result := []semantic.InputFile{}
	for p, data := range m.FilesByPath {
		result = append(result, semantic.InputFile{Path: p, Size: int64(len(data)), Hash: hash([]byte(data))})
	}
	return result, nil
}
func (m MemorySource) Read(ctx context.Context, id, p string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if id != m.Snapshot {
		return nil, ErrInvalid
	}
	data, ok := m.FilesByPath[p]
	if !ok {
		return nil, ErrInvalid
	}
	return []byte(data), nil
}
