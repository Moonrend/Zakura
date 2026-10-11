// Package projectrunner owns scoped project repositories and durable operations.
package projectrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/Moonrend/Zakura/apps/agent/internal/sandbox"
	"github.com/Moonrend/Zakura/packages/projectkit/workspace"
)

const MaxRPCBytes = 16 << 20
const MaxReadBytes = 8 << 20
const MaxProjects = 512
const MaxOperations = 100000
const MaxJournalBytes = 64 << 20

var opaqueID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func ValidateID(id string) error {
	if !opaqueID.MatchString(id) {
		return errors.New("a valid opaque identifier is required")
	}
	return nil
}

type Scope struct {
	SpaceID   string `json:"spaceId"`
	ProjectID string `json:"projectId"`
}

func (s Scope) Validate() error {
	if err := ValidateID(s.SpaceID); err != nil {
		return errors.New("a valid spaceId is required")
	}
	if err := ValidateID(s.ProjectID); err != nil {
		return errors.New("a valid projectId is required")
	}
	return nil
}

type Executor interface {
	Run(context.Context, string, sandbox.ProjectExecParams) (sandbox.ExecResult, error)
}
type dockerExecutor struct{}

func (dockerExecutor) Run(ctx context.Context, root string, p sandbox.ProjectExecParams) (sandbox.ExecResult, error) {
	return sandbox.RunProject(ctx, root, p)
}

type Manager struct {
	sourceInitialize      sync.Once
	sourceInitializeError error
	sourceRoot            string
	sourceRecords         map[string]sourceActivity
	sourceCurrent         map[string]bool
	sourceGate            sync.RWMutex
	sourceJournal         sync.Mutex
	sourceActive          map[string]int
	storageRoot           string
	mu                    sync.Mutex
	projects              map[Scope]*project
	spaces                map[string]*sync.Mutex
	executor              Executor
}
type project struct {
	mu              sync.Mutex
	scope           Scope
	root            string
	repository      *workspace.Repository
	active          sync.Map
	initialize      sync.Once
	initializeError error
}

func New(storageRoot string) *Manager {
	return &Manager{storageRoot: storageRoot, projects: map[Scope]*project{}, spaces: map[string]*sync.Mutex{}, sourceActive: map[string]int{}, sourceRecords: map[string]sourceActivity{}, sourceCurrent: map[string]bool{}, executor: dockerExecutor{}}
}

// WithExecutor is for an explicitly configured trusted runner backend/test.
// RPCs cannot select an executor or alter its isolation policy.
func (m *Manager) WithExecutor(executor Executor) *Manager {
	if executor == nil {
		panic("nil project executor")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.projects) > 0 {
		panic("executor cannot change after first project operation")
	}
	m.executor = executor
	return m
}

func (m *Manager) LockSpace(spaceID string) (func(), error) {
	if err := ValidateID(spaceID); err != nil {
		return nil, err
	}
	m.mu.Lock()
	lock := m.spaces[spaceID]
	if lock == nil {
		lock = &sync.Mutex{}
		m.spaces[spaceID] = lock
	}
	m.mu.Unlock()
	lock.Lock()
	return lock.Unlock, nil
}

// SecureDirectory creates only real directory components beneath a real root.
// It rejects symlink ancestors before any project scope is used as a path.
func SecureDirectory(storageRoot string, parts ...string) (string, error) {
	if storageRoot == "" {
		return "", errors.New("project storage root is unavailable")
	}
	root, err := filepath.Abs(storageRoot)
	if err != nil {
		return "", err
	}
	actual, err := filepath.EvalSymlinks(root)
	if err != nil || actual != root {
		return "", errors.New("project storage root must be an existing real directory")
	}
	st, err := os.Lstat(root)
	if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("project storage root must be a real directory")
	}
	for _, part := range parts {
		if err := ValidateID(part); err != nil {
			return "", err
		}
		root = filepath.Join(root, part)
		if err := os.Mkdir(root, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", errors.New("project directory is unavailable")
		}
		st, err := os.Lstat(root)
		if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("project directory must not be a symlink or special file")
		}
	}
	return root, nil
}
func (m *Manager) Source(scope Scope) (string, error) {
	if err := scope.Validate(); err != nil {
		return "", err
	}
	return SecureDirectory(m.storageRoot, "spaces", scope.SpaceID, "workspace")
}
func (m *Manager) get(scope Scope) (*project, error) {
	if err := scope.Validate(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	p := m.projects[scope]
	if p == nil {
		if len(m.projects) >= MaxProjects {
			m.mu.Unlock()
			return nil, errors.New("project runner repository limit reached")
		}
		p = &project{scope: scope}
		m.projects[scope] = p
	}
	m.mu.Unlock()
	p.initialize.Do(func() {
		root, err := SecureDirectory(m.storageRoot, "projects", scope.SpaceID, scope.ProjectID)
		if err != nil {
			p.initializeError = err
			return
		}
		p.root = root
		repoRoot, err := SecureDirectory(root, "repository")
		if err != nil {
			p.initializeError = err
			return
		}
		repository, err := workspace.New(repoRoot, workspace.Options{MaxFiles: 100000, MaxFileBytes: MaxReadBytes, MaxTotalBytes: 512 << 20, MaxPathBytes: 4096, MaxTextBytes: 1 << 20})
		if err != nil {
			p.initializeError = err
			return
		}
		if _, err := SecureDirectory(root, "operations"); err != nil {
			p.initializeError = err
			return
		}
		if _, err := SecureDirectory(root, "verification"); err != nil {
			p.initializeError = err
			return
		}
		p.repository = repository
	})
	if p.initializeError != nil {
		m.mu.Lock()
		if m.projects[scope] == p {
			delete(m.projects, scope)
		}
		m.mu.Unlock()
		return nil, p.initializeError
	}
	return p, nil
}

// BeginSourceProcess atomically registers trusted host execution before launch.
// The returned release must follow foreground-process reaping, never RPC reply.
// An empty space ID means an unrestricted storage-root process and blocks all
// source publication. Detached daemons and out-of-band host writers cannot be
// safely inferred from a foreground process and remain operator managed.
func (m *Manager) BeginSourceProcess(spaceID string) (func(), error) {
	if spaceID != "" {
		if err := ValidateID(spaceID); err != nil {
			return nil, err
		}
	}
	if err := m.ensureSourceActivities(); err != nil {
		return nil, err
	}
	m.sourceGate.RLock()
	defer m.sourceGate.RUnlock()
	m.sourceJournal.Lock()
	defer m.sourceJournal.Unlock()
	files, err := os.ReadDir(m.sourceRoot)
	if err != nil {
		return nil, err
	}
	if len(files) >= MaxSourceActivities {
		return nil, errors.New("source process activity journal capacity reached")
	}
	token, err := newID("source_")
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	record := sourceActivity{ID: token, SpaceID: spaceID, State: "active", StartedAt: now, UpdatedAt: now}
	// Intent precedes host launch; a restart cannot infer that it is harmless.
	if err := m.persistSourceActivity(record); err != nil {
		return nil, errors.New("source process intent could not be persisted")
	}
	m.mu.Lock()
	m.sourceActive[spaceID]++
	m.sourceRecords[token] = record
	m.sourceCurrent[token] = true
	m.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			m.sourceGate.RLock()
			defer m.sourceGate.RUnlock()
			record.State = "settled"
			record.UpdatedAt = time.Now().UTC()
			if err := m.persistSourceActivity(record); err != nil {
				return
			}
			m.mu.Lock()
			delete(m.sourceRecords, token)
			delete(m.sourceCurrent, token)
			m.sourceActive[spaceID]--
			if m.sourceActive[spaceID] == 0 {
				delete(m.sourceActive, spaceID)
			}
			m.mu.Unlock()
		})
	}, nil
}

// LockPublication suspends new host launches for the complete source operation
// and rejects known active processes instead of terminating the user's work.
func (m *Manager) LockPublication(spaceID string) (func(), error) {
	if err := m.ensureSourceActivities(); err != nil {
		return nil, err
	}
	if err := ValidateID(spaceID); err != nil {
		return nil, err
	}
	m.sourceGate.Lock()
	m.mu.Lock()
	active := m.sourceActive[spaceID] + m.sourceActive[""]
	m.mu.Unlock()
	if active > 0 {
		m.sourceGate.Unlock()
		return nil, errors.New("source workspace has active host processes; wait for them to finish before publication")
	}
	unlock, err := m.LockSpace(spaceID)
	if err != nil {
		m.sourceGate.Unlock()
		return nil, err
	}
	return func() { unlock(); m.sourceGate.Unlock() }, nil
}

// NoEffectError proves that source workspace publication was not attempted.
// It is used only for merge preflight rejection, never inferred from any error.
type NoEffectError struct{ Cause error }

func (e *NoEffectError) Error() string { return e.Cause.Error() }
func (e *NoEffectError) Unwrap() error { return e.Cause }
func noEffect(err error) error         { return &NoEffectError{Cause: err} }

type Operation struct {
	EffectState   string          `json:"effectState,omitempty"`
	ID            string          `json:"id"`
	Scope         Scope           `json:"scope"`
	Method        string          `json:"method"`
	ArgumentsHash string          `json:"argumentsHash"`
	Status        string          `json:"status"`
	Result        json.RawMessage `json:"result,omitempty"`
	Error         string          `json:"error,omitempty"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}
type Inspection struct {
	EffectState string          `json:"effectState,omitempty"`
	Known       bool            `json:"known"`
	Status      string          `json:"status,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
}

func operationPath(p *project, id string) (string, error) {
	if err := ValidateID(id); err != nil {
		return "", errors.New("a valid operationId is required")
	}
	return filepath.Join(p.root, "operations", id+".json"), nil
}
func loadOperation(p *project, id string) (Operation, error) {
	path, err := operationPath(p, id)
	if err != nil {
		return Operation{}, err
	}
	st, err := os.Lstat(path)
	if err != nil {
		return Operation{}, err
	}
	if !st.Mode().IsRegular() || st.Size() > MaxJournalBytes {
		return Operation{}, errors.New("invalid project operation journal")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Operation{}, err
	}
	var op Operation
	if err = json.Unmarshal(data, &op); err != nil {
		return Operation{}, errors.New("corrupt project operation journal")
	}
	if op.ID != id || op.Scope != p.scope {
		return Operation{}, errors.New("project operation scope mismatch")
	}
	return op, nil
}
func persistOperation(p *project, op Operation) error {
	target, err := operationPath(p, op.ID)
	if err != nil {
		return err
	}
	data, err := json.Marshal(op)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(target), ".operation-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, target); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(target))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func canonicalHash(method string, raw json.RawMessage) (string, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte(method+"\n"), data...))
	return hex.EncodeToString(sum[:]), nil
}

// runJournal is called under the project mutex. Intent is durable before fn runs.
func runJournal(ctx context.Context, p *project, id, method string, raw json.RawMessage, fn func() (any, error)) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	hash, err := canonicalHash(method, raw)
	if err != nil {
		return nil, err
	}
	old, err := loadOperation(p, id)
	if err == nil {
		if old.Method != method || old.ArgumentsHash != hash {
			return nil, errors.New("operationId was already used with different arguments")
		}
		switch old.Status {
		case "completed":
			return old.Result, nil
		case "failed":
			return old.Result, errors.New(old.Error)
		default:
			return nil, errors.New("operation outcome is unknown; inspect and reconcile before retrying")
		}
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(p.root, "operations"))
	if err != nil {
		return nil, err
	}
	if len(entries) >= MaxOperations {
		return nil, errors.New("project operation journal capacity reached")
	}
	now := time.Now().UTC()
	op := Operation{ID: id, Scope: p.scope, Method: method, ArgumentsHash: hash, Status: "running", CreatedAt: now, UpdatedAt: now}
	if err := persistOperation(p, op); err != nil {
		return nil, fmt.Errorf("project operation intent could not be persisted: %w", err)
	}
	p.active.Store(id, true)
	defer p.active.Delete(id)
	result, operationErr := fn()
	encoded, encodeErr := json.Marshal(result)
	if encodeErr != nil {
		return nil, errors.Join(operationErr, errors.New("operation outcome could not be encoded; inspect before retrying"))
	}
	if len(encoded) > MaxJournalBytes-(64<<10) {
		op.Status = "unknown"
		op.Error = "operation result exceeded journal limit; reconcile before retrying"
		op.UpdatedAt = time.Now().UTC()
		_ = persistOperation(p, op)
		return nil, errors.New(op.Error)
	}
	op.Result = encoded
	op.UpdatedAt = time.Now().UTC()
	op.Status = "completed"
	if operationErr != nil {
		op.Status = "failed"
		op.Error = operationErr.Error()
		var noPublication *NoEffectError
		if errors.As(operationErr, &noPublication) {
			op.EffectState = "not_performed"
		}
	}
	if err := persistOperation(p, op); err != nil {
		return nil, errors.Join(operationErr, errors.New("operation result persistence failed; outcome is unknown"))
	}
	return result, operationErr
}
func (m *Manager) Inspect(scope Scope, id string) (Inspection, error) {
	p, err := m.get(scope)
	if err != nil {
		return Inspection{}, err
	}
	op, err := loadOperation(p, id)
	if errors.Is(err, os.ErrNotExist) {
		return Inspection{Known: false}, nil
	}
	if err != nil {
		return Inspection{}, err
	}
	status := op.Status
	if status == "running" {
		if _, active := p.active.Load(id); !active {
			status = "unknown"
		}
	}
	return Inspection{Known: status == "completed" || status == "failed", EffectState: op.EffectState, Status: status, Result: op.Result, Error: op.Error}, nil
}
