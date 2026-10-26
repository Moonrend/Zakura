package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const (
	createOperationLabel = "zakura.create-operation"
	createDigestLabel    = "zakura.create-digest"
)

var (
	ErrCreateUnknown  = errors.New("docker.create outcome unknown; reconcile with docker.create.status, do not create again")
	ErrCreateConflict = errors.New("docker.create operation identity or config mismatch")
	createIdentity    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)
	createName        = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$`)
	// Shared across handlers/connections. Durable directory claims also prevent a
	// second agent process from executing an already claimed operation.
	createLocks [64]sync.Mutex
)

// CreateOperation identifies a named workspace container or a v2 sidecar.
// IDs are opaque identities, never filesystem paths.
type CreateOperation struct {
	ID              string `json:"id"`
	TenantID        string `json:"tenantId"`
	SpaceID         string `json:"spaceId"`
	ComputerID      string `json:"computerId"`
	InstanceID      string `json:"instanceId,omitempty"`
	Generation      int64  `json:"generation,omitempty"`
	DiskID          string `json:"diskId,omitempty"`
	LocatorVersion  int64  `json:"locatorVersion,omitempty"`
	NodeIncarnation string `json:"nodeIncarnation,omitempty"`
	Purpose         string `json:"purpose,omitempty"`
}

type CreateStatusRequest struct {
	OperationID     string `json:"operationId"`
	TenantID        string `json:"tenantId"`
	SpaceID         string `json:"spaceId"`
	ComputerID      string `json:"computerId"`
	Name            string `json:"name,omitempty"`
	InstanceID      string `json:"instanceId,omitempty"`
	Generation      int64  `json:"generation,omitempty"`
	DiskID          string `json:"diskId,omitempty"`
	LocatorVersion  int64  `json:"locatorVersion,omitempty"`
	NodeIncarnation string `json:"nodeIncarnation,omitempty"`
	Purpose         string `json:"purpose,omitempty"`
}

type CreateStatus struct {
	State        string         `json:"state"`
	ConfigDigest string         `json:"configDigest"`
	Name         string         `json:"name"`
	Container    *ContainerInfo `json:"container,omitempty"`
}

type createIntent struct {
	Version      int             `json:"version"`
	Operation    CreateOperation `json:"operation"`
	ConfigDigest string          `json:"configDigest"`
	Name         string          `json:"name"`
}

type createCommit struct {
	createIntent
	Container ContainerInfo `json:"container"`
}

type createReceipts struct {
	root    string
	create  func(context.Context, RunSpec) (ContainerInfo, error)
	inspect func(context.Context, string) (ContainerInfo, error)
}

// CreateWithReceipt never re-executes a claimed operation, even when Docker or
// the connection fails before the outcome can be recorded. Only the first
// durable intent can authorize the Docker effect; unknown is not permission.
func CreateWithReceipt(ctx context.Context, storageRoot string, spec RunSpec, op CreateOperation) (ContainerInfo, error) {
	return (createReceipts{storageRoot, Create, Inspect}).run(ctx, spec, op)
}

// ValidateCreate checks the complete request before an executor records a
// durable writer obligation. It performs no Docker or filesystem operations.
func ValidateCreate(spec RunSpec, op CreateOperation) error {
	if _, _, err := prepareCreate(spec, op); err != nil {
		return err
	}
	for _, volume := range spec.Volumes {
		if err := volume.validate(); err != nil {
			return err
		}
	}
	return nil
}

func CreateReceiptStatus(ctx context.Context, storageRoot string, request CreateStatusRequest) (CreateStatus, error) {
	return (createReceipts{storageRoot, Create, Inspect}).status(ctx, request)
}

func (op CreateOperation) version() int {
	if op.InstanceID != "" {
		return 2
	}
	return 1
}

func (op CreateOperation) valid() bool {
	if !createIdentity.MatchString(op.ID) || !createIdentity.MatchString(op.TenantID) || !createIdentity.MatchString(op.SpaceID) || !createIdentity.MatchString(op.ComputerID) {
		return false
	}
	if op.InstanceID == "" {
		return op.Generation == 0 && op.DiskID == "" && op.LocatorVersion == 0 && op.NodeIncarnation == "" && op.Purpose == ""
	}
	switch op.Purpose {
	case "", "acp-adapter", "acp-login", "component":
	default:
		return false
	}
	return createIdentity.MatchString(op.InstanceID) && createIdentity.MatchString(op.DiskID) && createIdentity.MatchString(op.NodeIncarnation) && op.Generation > 0 && op.LocatorVersion > 0
}

func (op CreateOperation) labels(digest string) map[string]string {
	labels := map[string]string{
		"zakura.tenant": op.TenantID, "zakura.space": op.SpaceID,
		"zakura.computer": op.ComputerID, "zakura.purpose": "workspace",
		createOperationLabel: op.ID, createDigestLabel: digest,
	}
	if op.version() == 2 {
		if op.Purpose != "" {
			labels["zakura.purpose"] = op.Purpose
		}
		labels["zakura.workspace-instance"] = op.InstanceID
		labels["zakura.workspace-generation"] = strconv.FormatInt(op.Generation, 10)
		labels["zakura.disk"] = op.DiskID
		labels["zakura.disk-version"] = strconv.FormatInt(op.LocatorVersion, 10)
		labels["zakura.node-incarnation"] = op.NodeIncarnation
	}
	return labels
}

func prepareCreate(spec RunSpec, op CreateOperation) (createIntent, RunSpec, error) {
	if !op.valid() || !createName.MatchString(spec.Name) || strings.TrimSpace(spec.Image) == "" {
		return createIntent{}, RunSpec{}, fmt.Errorf("docker.create requires valid operation identities, an exact container name and image")
	}
	for _, key := range []string{createOperationLabel, createDigestLabel} {
		if _, exists := spec.Labels[key]; exists {
			return createIntent{}, RunSpec{}, fmt.Errorf("docker.create receipt labels are reserved")
		}
	}
	for key, value := range op.labels("") {
		if key != createOperationLabel && key != createDigestLabel && spec.Labels[key] != value {
			return createIntent{}, RunSpec{}, fmt.Errorf("docker.create workspace ownership labels must match operation")
		}
	}
	// encoding/json orders map keys. Hash every typed RunSpec field (including
	// environment/command secrets), but never persist the spec or those values.
	// Nil and empty collections have one representation; ordered slices retain
	// their order since command, mount and port order can affect execution.
	canonical := spec
	if len(canonical.Env) == 0 {
		canonical.Env = nil
	}
	if len(canonical.Command) == 0 {
		canonical.Command = nil
	}
	if len(canonical.Ports) == 0 {
		canonical.Ports = nil
	}
	if len(canonical.Volumes) == 0 {
		canonical.Volumes = nil
	}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return createIntent{}, RunSpec{}, err
	}
	digest := sha256.Sum256(raw)
	intent := createIntent{op.version(), op, hex.EncodeToString(digest[:]), spec.Name}
	labels := make(map[string]string, len(spec.Labels)+2)
	for key, value := range spec.Labels {
		labels[key] = value
	}
	labels[createOperationLabel], labels[createDigestLabel] = op.ID, intent.ConfigDigest
	spec.Labels = labels
	return intent, spec, nil
}

func lockCreate(opID string) func() {
	sum := sha256.Sum256([]byte(opID))
	lock := &createLocks[int(sum[0])%len(createLocks)]
	lock.Lock()
	return lock.Unlock
}

func (s createReceipts) run(ctx context.Context, spec RunSpec, op CreateOperation) (ContainerInfo, error) {
	intent, labeled, err := prepareCreate(spec, op)
	if err != nil {
		return ContainerInfo{}, err
	}
	unlock := lockCreate(op.ID)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return ContainerInfo{}, err
	}
	job, claimed, err := openCreateJob(s.root, op.ID, true)
	if err != nil {
		return ContainerInfo{}, ErrCreateUnknown
	}
	defer job.Close()
	if !claimed {
		stored, err := readCreateIntent(job)
		if err != nil {
			return ContainerInfo{}, ErrCreateUnknown
		}
		if stored != intent {
			return ContainerInfo{}, ErrCreateConflict
		}
		status, err := s.reconcile(ctx, job, stored)
		if err != nil || status.Container == nil {
			return ContainerInfo{}, ErrCreateUnknown
		}
		return *status.Container, nil
	}
	if err := saveCreateRecord(job, "intent.json", intent); err != nil {
		return ContainerInfo{}, ErrCreateUnknown
	}
	if err := ctx.Err(); err != nil {
		return ContainerInfo{}, ErrCreateUnknown
	}
	container, err := s.create(ctx, labeled)
	if err != nil || !intent.matches(container) {
		// Do not leak Docker output: it may contain environment/command secrets.
		return ContainerInfo{}, ErrCreateUnknown
	}
	container = intent.receiptContainer(container)
	if err := saveCreateRecord(job, "committed.json", createCommit{intent, container}); err != nil {
		return ContainerInfo{}, ErrCreateUnknown
	}
	return container, nil
}

func (s createReceipts) status(ctx context.Context, request CreateStatusRequest) (CreateStatus, error) {
	op := CreateOperation{ID: request.OperationID, TenantID: request.TenantID, SpaceID: request.SpaceID, ComputerID: request.ComputerID,
		InstanceID: request.InstanceID, Generation: request.Generation, DiskID: request.DiskID, LocatorVersion: request.LocatorVersion, NodeIncarnation: request.NodeIncarnation, Purpose: request.Purpose}
	unknown := CreateStatus{State: "unknown", Name: request.Name}
	if !op.valid() || (request.Name != "" && !createName.MatchString(request.Name)) {
		return unknown, fmt.Errorf("docker.create.status requires valid operation identities and an exact name")
	}
	unlock := lockCreate(op.ID)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return unknown, err
	}
	job, _, err := openCreateJob(s.root, op.ID, false)
	if err != nil {
		// Even explicit absence cannot prove that Docker never ran. No list or
		// guessed-name lookup can manufacture the missing expected digest.
		return unknown, nil
	}
	defer job.Close()
	intent, err := readCreateIntent(job)
	if err != nil {
		return unknown, nil
	}
	if intent.Operation != op || (request.Name != "" && request.Name != intent.Name) {
		return unknown, ErrCreateConflict
	}
	return s.reconcile(ctx, job, intent)
}

func (s createReceipts) reconcile(ctx context.Context, job createJob, intent createIntent) (CreateStatus, error) {
	result := CreateStatus{State: "unknown", ConfigDigest: intent.ConfigDigest, Name: intent.Name}
	var receipt createCommit
	err := readCreateRecord(job, "committed.json", &receipt)
	if err == nil {
		if receipt.createIntent != intent || !intent.matches(receipt.Container) {
			return result, ErrCreateUnknown
		}
		container := intent.receiptContainer(receipt.Container)
		result.State, result.Container = "committed", &container
		return result, nil
	}
	if !errors.Is(err, errCreateRecordMissing) {
		return result, ErrCreateUnknown
	}
	container, err := s.inspect(ctx, intent.Name)
	if err != nil || !intent.matches(container) {
		return result, nil
	}
	container = intent.receiptContainer(container)
	if err := saveCreateRecord(job, "committed.json", createCommit{intent, container}); err != nil {
		return result, ErrCreateUnknown
	}
	result.State, result.Container = "committed", &container
	return result, nil
}

func (intent createIntent) matches(container ContainerInfo) bool {
	if container.DockerID == "" || container.Name != intent.Name {
		return false
	}
	for key, value := range intent.Operation.labels(intent.ConfigDigest) {
		if container.Labels[key] != value {
			return false
		}
	}
	return true
}

func (intent createIntent) receiptContainer(container ContainerInfo) ContainerInfo {
	// Custom labels, like Env and Command, can carry secrets. A durable receipt
	// stores only the flat legacy container shape and its verified identity labels.
	container.Labels = intent.Operation.labels(intent.ConfigDigest)
	return container
}
