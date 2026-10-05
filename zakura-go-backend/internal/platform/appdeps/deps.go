package appdeps

import (
	"context"
	"crypto/rsa"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"
)

// Dependencies is the deliberately small boundary shared by the platform,
// runtime and integration route packages. Business state is always persisted
// through DB; Clock/NewID are replaceable so tests remain deterministic.
type Dependencies struct {
	Context                context.Context
	DB                     *sql.DB
	Dialect                string
	Rebind                 func(string) string
	Clock                  func() time.Time
	NewID                  func() string
	Secret                 []byte
	PublicURL              string
	WebURL                 string
	DataDir                string
	Edition                string
	MultiTenant            bool
	VerifyDomain           func(context.Context, string, string) error
	OAuthPublicKey         func(context.Context) (*rsa.PublicKey, error)
	HTTPClient             *http.Client
	ResolveIPs             func(context.Context, string) ([]net.IP, error)
	BeforeTenantDelete     func(context.Context, string) error
	AfterMemberRemoved     func(context.Context, string, string) error
	SendTransactionalEmail func(context.Context, string, string, string, string) error
	RecordUsage            func(context.Context, UsageRecord) error
}

type UsageRecord struct {
	TenantID, UserID, ActorKind, Category, Action, Status string
	DurationMS                                            int64
	AgentID, SessionID, ResourceKind, ResourceID, Summary string
}

func (d *Dependencies) RunContext() context.Context {
	if d != nil && d.Context != nil {
		return d.Context
	}
	return context.Background()
}

func (d *Dependencies) Validate() error {
	if d == nil || d.DB == nil {
		return errors.New("database dependency is required")
	}
	if d.Clock == nil || d.NewID == nil || d.Rebind == nil {
		return errors.New("clock, id generator and SQL rebinder are required")
	}
	if len(d.Secret) < 32 {
		return errors.New("session secret must contain at least 32 bytes")
	}
	return nil
}

// PostgresRebind converts database/sql question-mark placeholders to the
// positional placeholders used by lib/pq. SQL literals do not use '?' in this
// project, so the intentionally small implementation keeps the dependency
// boundary auditable.
func PostgresRebind(query string) string {
	var b strings.Builder
	n := 0
	for _, r := range query {
		if r == '?' {
			n++
			b.WriteByte('$')
			for _, d := range []byte(intToString(n)) {
				b.WriteByte(d)
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func IdentityRebind(query string) string { return query }

type TxFunc func(*sql.Tx) error

func InTx(ctx context.Context, db *sql.DB, fn TxFunc) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
