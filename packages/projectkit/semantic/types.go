// Package semantic indexes code from immutable artifact snapshots without
// executing source code, resolving external dependencies, or invoking compilers.
package semantic

import (
	"context"
	"errors"
)

const Version = "artifact-semantics-v1"

var ErrLimit = errors.New("semantic: resource limit exceeded")
var ErrNotFound = errors.New("semantic: file or symbol not found")
var ErrInvalid = errors.New("semantic: invalid request")

type Limits struct {
	MaxFiles       int
	MaxFileBytes   int64
	MaxTotalBytes  int64
	MaxNodes       int
	MaxEdges       int
	MaxSymbols     int
	MaxReferences  int
	MaxDiagnostics int
	MaxResults     int
}

func DefaultLimits() Limits {
	return Limits{MaxFiles: 2000, MaxFileBytes: 1 << 20, MaxTotalBytes: 32 << 20, MaxNodes: 500000, MaxEdges: 20000, MaxSymbols: 30000, MaxReferences: 120000, MaxDiagnostics: 2000, MaxResults: 1000}
}

type InputFile struct {
	Path string
	Hash string
	Size int64
}
type Source interface {
	Files(context.Context, string) ([]InputFile, error)
	Read(context.Context, string, string) ([]byte, error)
}
type Position struct {
	Offset int `json:"offset"`
	Line   int `json:"line"`
	Column int `json:"column"`
}
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}
type Diagnostic struct {
	Path     string `json:"path"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	Severity string `json:"severity"`
	Range    *Range `json:"range,omitempty"`
}
type Symbol struct {
	ID                 string `json:"id"`
	Key                string `json:"key"`
	Name               string `json:"name"`
	Kind               string `json:"kind"`
	Path               string `json:"path"`
	Package            string `json:"package,omitempty"`
	Receiver           string `json:"receiver,omitempty"`
	Exported           bool   `json:"exported"`
	Signature          string `json:"signature"`
	SignatureHash      string `json:"signatureHash,omitempty"`
	SignatureTruncated bool   `json:"signatureTruncated,omitempty"`
	Range              Range  `json:"range"`
	Selection          Range  `json:"selection"`
	Confidence         string `json:"confidence"`
}
type Reference struct {
	Path       string   `json:"path"`
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	Qualifier  string   `json:"qualifier,omitempty"`
	Range      Range    `json:"range"`
	SymbolIDs  []string `json:"symbolIds"`
	Confidence string   `json:"confidence"`
}
type Import struct {
	ExplicitAlias bool `json:"explicitAlias,omitempty"`

	Path       string   `json:"path"`
	Name       string   `json:"name,omitempty"`
	Range      Range    `json:"range"`
	Targets    []string `json:"targets"`
	Confidence string   `json:"confidence"`
}
type File struct {
	Path            string       `json:"path"`
	Hash            string       `json:"hash"`
	Language        string       `json:"language"`
	Package         string       `json:"package,omitempty"`
	Generated       bool         `json:"generated"`
	Test            bool         `json:"test"`
	BuildConditions []string     `json:"buildConditions"`
	Status          string       `json:"status"`
	Symbols         []Symbol     `json:"symbols"`
	Imports         []Import     `json:"imports"`
	References      []Reference  `json:"references"`
	Diagnostics     []Diagnostic `json:"diagnostics"`
}
type Edge struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Kind       string `json:"kind"`
	Confidence string `json:"confidence"`
}
type Cycle struct {
	Files []string `json:"files"`
}
type Summary struct {
	SnapshotID   string        `json:"snapshotId"`
	Version      string        `json:"version"`
	Complete     bool          `json:"complete"`
	IndexedFiles int           `json:"indexedFiles"`
	SkippedFiles int           `json:"skippedFiles"`
	Symbols      int           `json:"symbols"`
	References   int           `json:"references"`
	Files        []FileSummary `json:"files"`
	Diagnostics  []Diagnostic  `json:"diagnostics"`
	Edges        []Edge        `json:"edges"`
	Cycles       []Cycle       `json:"cycles"`
	Limitations  []string      `json:"limitations"`
}
type FileSummary struct {
	Path       string `json:"path"`
	Language   string `json:"language"`
	Package    string `json:"package,omitempty"`
	Generated  bool   `json:"generated"`
	Test       bool   `json:"test"`
	Status     string `json:"status"`
	Symbols    int    `json:"symbols"`
	References int    `json:"references"`
}
type Index struct {
	SnapshotID   string
	Version      string
	Entries      []InputFile
	Files        []File
	Diagnostics  []Diagnostic
	Edges        []Edge
	Cycles       []Cycle
	Complete     bool
	SkippedFiles int
	Limits       Limits
}
type SearchQuery struct {
	Query        string `json:"query"`
	Path         string `json:"path,omitempty"`
	Kind         string `json:"kind,omitempty"`
	ExportedOnly bool   `json:"exportedOnly,omitempty"`
	Limit        int    `json:"limit,omitempty"`
	Offset       int    `json:"offset,omitempty"`
}
type SearchResult struct {
	SnapshotID string   `json:"snapshotId"`
	Version    string   `json:"version"`
	Symbols    []Symbol `json:"symbols"`
	Total      int      `json:"total"`
	Truncated  bool     `json:"truncated"`
}
type Navigation struct {
	SnapshotID string      `json:"snapshotId"`
	Symbol     Symbol      `json:"symbol"`
	References []Reference `json:"references"`
	Total      int         `json:"total"`
	Truncated  bool        `json:"truncated"`
}
type FileResult struct {
	Truncated       bool `json:"truncated"`
	TotalSymbols    int  `json:"totalSymbols"`
	TotalReferences int  `json:"totalReferences"`
	TotalImports    int  `json:"totalImports"`

	SnapshotID   string `json:"snapshotId"`
	Version      string `json:"version"`
	File         File   `json:"file"`
	Dependencies []Edge `json:"dependencies"`
	Dependents   []Edge `json:"dependents"`
}
type APIChange struct {
	Key            string   `json:"key"`
	Kind           string   `json:"kind"`
	Classification string   `json:"classification"`
	Reason         string   `json:"reason"`
	Confidence     string   `json:"confidence"`
	Before         []Symbol `json:"before"`
	After          []Symbol `json:"after"`
}
type FileChange struct {
	Path       string `json:"path"`
	OldPath    string `json:"oldPath,omitempty"`
	Kind       string `json:"kind"`
	Confidence string `json:"confidence"`
}
type Impact struct {
	Path       string   `json:"path"`
	Reason     string   `json:"reason"`
	Via        []string `json:"via"`
	Confidence string   `json:"confidence"`
}
type RelatedTest struct {
	Path       string `json:"path"`
	SourcePath string `json:"sourcePath"`
	Reason     string `json:"reason"`
	Confidence string `json:"confidence"`
}
type ComparisonCounts struct {
	Changes      int `json:"changes"`
	APIChanges   int `json:"apiChanges"`
	Impacted     int `json:"impacted"`
	RelatedTests int `json:"relatedTests"`
}
type Comparison struct {
	Truncated bool             `json:"truncated"`
	Counts    ComparisonCounts `json:"counts"`

	BeforeSnapshot string        `json:"beforeSnapshot"`
	AfterSnapshot  string        `json:"afterSnapshot"`
	Version        string        `json:"version"`
	Complete       bool          `json:"complete"`
	Changes        []FileChange  `json:"changes"`
	APIChanges     []APIChange   `json:"apiChanges"`
	Impacted       []Impact      `json:"impacted"`
	RelatedTests   []RelatedTest `json:"relatedTests"`
	Diagnostics    []Diagnostic  `json:"diagnostics"`
	Limitations    []string      `json:"limitations"`
}
