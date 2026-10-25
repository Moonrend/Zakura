package workspaces

import (
	"encoding/json"
	"errors"
	"regexp"

	protocol "github.com/Moonrend/Zakura/apps/agent/workspace"
)

var (
	ErrConflict      = errors.New("workspace binding changed or resource is busy")
	ErrTargetRevoked = errors.New("the original workspace instance is no longer available")
	ErrUnverified    = errors.New("workspace disk must be verified on its original node")
	identityPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)
)

// Locator is node-relative storage metadata, never a caller-supplied host path.
// The node resolves it to both its own filesystem and a Docker mount descriptor.
// Legacy locations are adopted without moving or creating their contents.
type Locator = protocol.Locator

type Target = protocol.Target

type Disk struct {
	ID                 string  `json:"id"`
	TenantID           string  `json:"tenantId"`
	SpaceID            string  `json:"spaceId"`
	Name               string  `json:"name"`
	NodeID             string  `json:"nodeId"`
	NodeIncarnation    string  `json:"nodeIncarnation"`
	NodeRemovedAt      *string `json:"nodeRemovedAt"`
	Locator            Locator `json:"-"`
	LocatorVersion     int64   `json:"locatorVersion"`
	State              string  `json:"state"`
	AttachedInstanceID *string `json:"attachedInstanceId"`
	UsedBytes          *int64  `json:"usedBytes"`
	SampledAt          *string `json:"sampledAt"`
	VerifiedAt         *string `json:"verifiedAt"`
	LastError          *string `json:"lastError"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
}

type Instance struct {
	Target
	ComputerID        string          `json:"computerId"`
	Config            json.RawMessage `json:"-"`
	IdentityVersion   int             `json:"identityVersion"`
	State             string          `json:"state"`
	DockerID          *string         `json:"dockerId"`
	CreateOperationID *string         `json:"createOperationId"`
	RevokedAt         *string         `json:"revokedAt"`
	ReleasedAt        *string         `json:"releasedAt"`
	LastError         *string         `json:"lastError"`
	CreatedAt         string          `json:"createdAt"`
	UpdatedAt         string          `json:"updatedAt"`
}

func (i Instance) Usable() bool {
	return i.RevokedAt == nil && (i.State == "pending" || i.State == "creating" || i.State == "running" || i.State == "stopped")
}

type CreateEvidence struct {
	OperationID     string  `json:"operationId"`
	ComputerID      string  `json:"computerId"`
	Name            string  `json:"name"`
	ConfigDigest    *string `json:"configDigest"`
	IdentityVersion int     `json:"identityVersion"`
}

type CleanupSnapshot struct {
	Version        int               `json:"version"`
	Instance       *Instance         `json:"instance,omitempty"`
	Disk           Disk              `json:"disk"`
	Locator        Locator           `json:"locator"`
	Create         *CreateEvidence   `json:"create,omitempty"`
	Lease          json.RawMessage   `json:"lease,omitempty"`
	Containers     []json.RawMessage `json:"containers,omitempty"`
	Connections    []json.RawMessage `json:"connections,omitempty"`
	Authentication []json.RawMessage `json:"authentication,omitempty"`
	DeviceAttempts []json.RawMessage `json:"deviceAttempts,omitempty"`
}

type Cleanup struct {
	ID          string          `json:"id"`
	RequestID   string          `json:"requestId"`
	TenantID    string          `json:"tenantId"`
	SpaceID     string          `json:"spaceId"`
	InstanceID  *string         `json:"instanceId"`
	DiskID      string          `json:"diskId"`
	DeleteDisk  bool            `json:"deleteDisk"`
	Phase       string          `json:"phase"`
	Pending     bool            `json:"pending"`
	Attempts    int             `json:"attempts"`
	NextAttempt int64           `json:"-"`
	Token       string          `json:"-"`
	Snapshot    CleanupSnapshot `json:"-"`
	LastError   *string         `json:"lastError"`
}
