package projectrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/packages/projectkit/refactor"
)

const refactorWorkerFlag = "--zakura-refactor-worker-v1"
const maxRefactorWorkerInput = 32 << 20
const maxRefactorWorkerOutput = 8 << 20

var refactorWorkerSlots = make(chan struct{}, 2)

type refactorWorkerInput struct {
	Source  refactor.MemorySource `json:"source"`
	Request refactor.Request      `json:"request"`
}
type refactorWorkerOutput struct {
	Preview refactor.Preview `json:"preview"`
	Error   string           `json:"error,omitempty"`
}

// HandleRefactorWorker is called before ordinary CLI parsing in our own agent
// binary. The exact flag selects a bounded, stdin-only compiler analysis worker.
// No deployment credentials or workspace executable are passed to this mode.
func HandleRefactorWorker(args []string) bool {
	if len(args) != 2 || args[1] != refactorWorkerFlag {
		return false
	}
	input := refactorWorkerInput{}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, maxRefactorWorkerInput+1))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&input)
	if err == nil {
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			err = errors.New("worker requires one bounded JSON request")
		}
	}
	output := refactorWorkerOutput{}
	if err == nil {
		output.Preview, err = refactor.Rename(context.Background(), input.Source, input.Request)
	}
	if err != nil {
		message := err.Error()
		if len(message) > 8192 {
			message = message[:8192]
		}
		output.Error = message
	}
	data, err := json.Marshal(output)
	if err != nil || len(data) > maxRefactorWorkerOutput {
		data = []byte(`{"error":"refactor worker result exceeds its output limit"}`)
	}
	_, _ = os.Stdout.Write(data)
	return true
}

type boundedRefactorBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedRefactorBuffer) Write(data []byte) (int, error) {
	if len(data) > b.limit-b.Len() {
		return 0, refactor.ErrLimit
	}
	return b.Buffer.Write(data)
}
func runRefactorProcess(ctx context.Context, binary string, source refactor.MemorySource, req refactor.Request) (refactor.Preview, error) {
	data, err := json.Marshal(refactorWorkerInput{Source: source, Request: req})
	if err != nil {
		return refactor.Preview{}, err
	}
	if len(data) > maxRefactorWorkerInput {
		return refactor.Preview{}, refactor.ErrLimit
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, refactorWorkerFlag)
	// Inherit only the installed runtime location required by the standard-library
	// importer. The helper receives no tokens, cloud credentials or project path.
	environment := []string{}
	for _, key := range []string{"GOROOT", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"} {
		if value, ok := os.LookupEnv(key); ok {
			environment = append(environment, key+"="+value)
		}
	}
	command.Env = environment
	command.Stdin = bytes.NewReader(data)
	stdout := &boundedRefactorBuffer{limit: maxRefactorWorkerOutput}
	stderr := &boundedRefactorBuffer{limit: 8192}
	command.Stdout = stdout
	command.Stderr = stderr
	err = command.Run()
	if ctx.Err() != nil {
		return refactor.Preview{}, ctx.Err()
	}
	if err != nil {
		return refactor.Preview{}, fmt.Errorf("%w: native checker process failed", refactor.ErrIncomplete)
	}
	var output refactorWorkerOutput
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		return refactor.Preview{}, fmt.Errorf("%w: invalid native checker response", refactor.ErrIncomplete)
	}
	if output.Error != "" {
		return refactor.Preview{}, errors.New(output.Error)
	}
	if output.Preview.Version != refactor.Version || output.Preview.SnapshotID != req.SnapshotID || output.Preview.ID == "" {
		return refactor.Preview{}, refactor.ErrIncomplete
	}
	return output.Preview, nil
}
func refactorPreview(ctx context.Context, p *project, req refactor.Request) (refactor.Preview, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	select {
	case refactorWorkerSlots <- struct{}{}:
		defer func() { <-refactorWorkerSlots }()
	case <-ctx.Done():
		return refactor.Preview{}, ctx.Err()
	}
	source, err := refactor.Load(ctx, semanticSource{p.repository}, req.SnapshotID)
	if err != nil {
		return refactor.Preview{}, err
	}
	binary, err := os.Executable()
	if err != nil {
		return refactor.Preview{}, refactor.ErrIncomplete
	}
	return runRefactorProcess(ctx, binary, source, req)
}

type refactorRequest struct {
	Scope
	refactor.Request
	OperationID  string `json:"operationId,omitempty"`
	PreviewID    string `json:"previewId,omitempty"`
	Confirmation string `json:"confirmation,omitempty"`
}

func decodeRefactorRequest(method string, raw json.RawMessage) (refactorRequest, error) {
	fields := map[string]string{"project.refactor.preview": "snapshotId path offset symbolId newName", "project.refactor.apply": "snapshotId path offset symbolId newName previewId operationId confirmation", "project.refactor.candidate": "operationId"}
	fieldList, ok := fields[method]
	if !ok {
		return refactorRequest{}, errors.New("unknown refactor RPC method")
	}
	if len(raw) == 0 || len(raw) > 65536 {
		return refactorRequest{}, refactor.ErrLimit
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil || keys == nil {
		return refactorRequest{}, refactor.ErrInvalid
	}
	allowed := map[string]bool{"spaceId": true, "projectId": true}
	for _, key := range strings.Fields(fieldList) {
		allowed[key] = true
	}
	for key := range keys {
		if !allowed[key] {
			return refactorRequest{}, fmt.Errorf("unsupported refactor parameter %q", key)
		}
	}
	var req refactorRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, refactor.ErrInvalid
	}
	if err := req.Scope.Validate(); err != nil {
		return req, err
	}
	if req.Offset != nil && req.SymbolID != "" {
		return req, errors.New("select a symbolId or byte offset, not both")
	}
	return req, nil
}
func (m *Manager) RefactorDispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	req, err := decodeRefactorRequest(method, raw)
	if err != nil {
		return nil, err
	}
	p, err := m.get(req.Scope)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if method == "project.refactor.candidate" {
		op, err := loadOperation(p, req.OperationID)
		if err != nil {
			return nil, err
		}

		if op.Method != "project.refactor.apply" {
			return nil, errors.New("operation is not a refactor candidate")
		}
		if op.Status != "completed" {
			if _, active := p.active.Load(req.OperationID); active {
				return nil, errors.New("refactor operation is still active")
			}
			proof, err := loadRefactorProof(ctx, p, op)
			if err != nil {
				return nil, errors.New("refactor candidate has no complete capture proof; no original workspace was written")
			}
			encoded, err := json.Marshal(proof.Candidate)
			if err != nil {
				return nil, err
			}
			op.Result = encoded
			op.Status = "completed"
			op.Error = ""
			op.UpdatedAt = time.Now().UTC()
			if err = persistOperation(p, op); err != nil {
				return nil, err
			}
		}

		var candidate refactor.Candidate
		if err = json.Unmarshal(op.Result, &candidate); err != nil || candidate.ID != op.ID || candidate.AcceptanceInherited || !candidate.RequiresHumanReview {
			return nil, errors.New("invalid refactor candidate receipt")
		}
		if _, err = p.repository.GetSnapshot(ctx, candidate.SnapshotID); err != nil {
			return nil, err
		}
		return candidate, nil
	}
	if method == "project.refactor.preview" {
		return refactorPreview(ctx, p, req.Request)
	}
	if req.Confirmation != "create_branch" || ValidateID(req.OperationID) != nil || len(req.PreviewID) != 64 {
		return nil, errors.New("refactor branch creation requires its exact preview and explicit confirmation")
	}
	return runJournal(ctx, p, req.OperationID, method, raw, func() (any, error) {
		preview, err := refactorPreview(ctx, p, req.Request)
		if err != nil {
			return nil, err
		}
		if preview.ID != req.PreviewID {
			return nil, errors.New("refactor preview fingerprint no longer matches this request")
		}
		branchID, err := newID("rename_")
		if err != nil {
			return nil, err
		}
		branch, err := p.repository.CreateBranch(ctx, branchID, req.SnapshotID)
		if err != nil {
			return nil, err
		}
		successful := false
		defer func() {
			if !successful {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = p.repository.DeleteBranch(cleanup, branchID, branch.Head)
			}
		}()
		base, err := p.repository.GetSnapshot(ctx, req.SnapshotID)
		if err != nil {
			return nil, err
		}
		modes := map[string]uint32{}
		for _, entry := range base.Entries {
			modes[entry.Path] = entry.Mode
		}
		for _, patch := range preview.Files {
			data, err := p.repository.ReadSnapshot(ctx, req.SnapshotID, patch.Path)
			if err != nil {
				return nil, err
			}
			rewritten, err := refactor.Apply(data, patch)
			if err != nil {
				return nil, err
			}
			if err = p.repository.Write(ctx, branchID, patch.Path, rewritten, modes[patch.Path]); err != nil {
				return nil, err
			}
		}
		snapshot, err := p.repository.CaptureBranch(ctx, branchID, branch.Head)
		if err != nil {
			return nil, err
		}

		successful = true
		candidate := refactor.Candidate{ID: req.OperationID, PreviewID: preview.ID, BranchID: branchID, SnapshotID: snapshot.ID, BaseSnapshot: req.SnapshotID, Files: preview.Files, ExportedAPIChanged: preview.ExportedAPIChanged, RequiresHumanReview: true, AcceptanceInherited: false}
		argsHash, err := canonicalHash(method, raw)
		if err != nil {
			return nil, err
		}
		proof := refactorCaptureProof{Version: refactor.Version, Scope: req.Scope, OperationID: req.OperationID, ArgumentsHash: argsHash, Candidate: candidate}
		if err = persistRefactorProof(p, proof); err != nil {
			return nil, errors.New("refactor capture proof persistence was interrupted; inspect its candidate before retrying")
		}
		return candidate, nil
	})
}

type refactorCaptureProof struct {
	Version       string             `json:"version"`
	Scope         Scope              `json:"scope"`
	OperationID   string             `json:"operationId"`
	ArgumentsHash string             `json:"argumentsHash"`
	Candidate     refactor.Candidate `json:"candidate"`
}

func refactorProofPath(p *project, id string) (string, error) {
	if ValidateID(id) != nil {
		return "", refactor.ErrInvalid
	}
	directory, err := SecureDirectory(p.root, "refactorresults")
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, id+".json"), nil
}
func persistRefactorProof(p *project, proof refactorCaptureProof) error {
	target, err := refactorProofPath(p, proof.OperationID)
	if err != nil {
		return err
	}
	data, err := json.Marshal(proof)
	if err != nil {
		return err
	}
	if len(data) > maxRefactorWorkerOutput {
		return refactor.ErrLimit
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".capture-")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err = temp.Chmod(0600); err != nil {
		temp.Close()
		return err
	}
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, target); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(target))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
func loadRefactorProof(ctx context.Context, p *project, op Operation) (refactorCaptureProof, error) {
	target, err := refactorProofPath(p, op.ID)
	if err != nil {
		return refactorCaptureProof{}, err
	}
	st, err := os.Lstat(target)
	if err != nil || !st.Mode().IsRegular() || st.Size() > maxRefactorWorkerOutput {
		return refactorCaptureProof{}, refactor.ErrIncomplete
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return refactorCaptureProof{}, err
	}
	var proof refactorCaptureProof
	if err = json.Unmarshal(data, &proof); err != nil {
		return proof, err
	}
	c := proof.Candidate
	if proof.Version != refactor.Version || proof.Scope != p.scope || proof.OperationID != op.ID || proof.ArgumentsHash != op.ArgumentsHash || c.ID != op.ID || c.AcceptanceInherited || !c.RequiresHumanReview || len(c.PreviewID) != 64 {
		return proof, refactor.ErrIncomplete
	}
	base, err := p.repository.GetSnapshot(ctx, c.BaseSnapshot)
	if err != nil {
		return proof, err
	}
	next, err := p.repository.GetSnapshot(ctx, c.SnapshotID)
	if err != nil {
		return proof, err
	}
	if len(base.Entries) != len(next.Entries) {
		return proof, refactor.ErrConflict
	}
	patches := map[string]refactor.FilePatch{}
	for _, patch := range c.Files {
		if _, duplicate := patches[patch.Path]; duplicate {
			return proof, refactor.ErrConflict
		}
		patches[patch.Path] = patch
	}
	for n, entry := range base.Entries {
		result := next.Entries[n]
		if entry.Path != result.Path || entry.Mode != result.Mode {
			return proof, refactor.ErrConflict
		}
		patch, changed := patches[entry.Path]
		if !changed {
			if entry.Hash != result.Hash || entry.Size != result.Size {
				return proof, refactor.ErrConflict
			}
			continue
		}
		if entry.Hash != patch.BeforeHash || result.Hash != patch.AfterHash {
			return proof, refactor.ErrConflict
		}
		original, err := p.repository.ReadSnapshot(ctx, c.BaseSnapshot, entry.Path)
		if err != nil {
			return proof, err
		}
		rewritten, err := refactor.Apply(original, patch)
		if err != nil || int64(len(rewritten)) != result.Size {
			return proof, refactor.ErrConflict
		}
		delete(patches, entry.Path)
	}
	if len(patches) != 0 {
		return proof, refactor.ErrConflict
	}
	return proof, nil
}
