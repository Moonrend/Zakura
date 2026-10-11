// Package contextpack selects bounded, quoted source references from an
// immutable task snapshot. Ranking is lexical BM25 plus syntax-graph evidence;
// it does not execute source or infer runtime reachability.
package contextpack

import (
	"errors"
	"github.com/Moonrend/Zakura/packages/projectkit/semantic"
)

const Version = "task-context-v1"
const MaxOutputBytes = 16000
const MinOutputBytes = 512
const MaxFiles = 1000
const MaxInputBytes = 32 << 20
const MaxFileBytes = 1 << 20

var ErrInvalid = errors.New("contextpack: invalid request")

type Request struct {
	SnapshotID string   `json:"snapshotId"`
	Query      string   `json:"query,omitempty"`
	Prompt     string   `json:"prompt,omitempty"`
	Writes     []string `json:"writes"`
	CheckPaths []string `json:"checkPaths"`
	MaxBytes   int      `json:"maxBytes,omitempty"`
}
type Reason struct {
	Kind       string `json:"kind"`
	Via        string `json:"via,omitempty"`
	Confidence string `json:"confidence"`
}
type Snippet struct {
	SnapshotID string         `json:"snapshotId"`
	Path       string         `json:"path"`
	Hash       string         `json:"hash"`
	Range      semantic.Range `json:"range"`
	Text       string         `json:"text"`
	Reasons    []Reason       `json:"reasons"`
	Score      float64        `json:"score"`
	Generated  bool           `json:"generated,omitempty"`
	Partial    bool           `json:"partial"`
	Truncated  bool           `json:"truncated"`
}
type Missing struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}
type Boundary struct {
	Path   string `json:"path,omitempty"`
	Kind   string `json:"kind"`
	Detail string `json:"detail,omitempty"`
}
type Pack struct {
	Version            string     `json:"version"`
	SnapshotID         string     `json:"snapshotId"`
	Mode               string     `json:"mode"`
	UntrustedReference bool       `json:"untrustedReference"`
	Partial            bool       `json:"partial"`
	Truncated          bool       `json:"truncated"`
	Bytes              int        `json:"bytes"`
	MaxBytes           int        `json:"maxBytes"`
	ScannedFiles       int        `json:"scannedFiles"`
	ScannedBytes       int64      `json:"scannedBytes"`
	OmittedCount       int        `json:"omittedCount"`
	OmittedPaths       []string   `json:"omittedPaths"`
	MissingCount       int        `json:"missingCount"`
	Missing            []Missing  `json:"missing"`
	BoundaryCount      int        `json:"boundaryCount"`
	Boundaries         []Boundary `json:"boundaries"`
	Snippets           []Snippet  `json:"snippets"`
}
