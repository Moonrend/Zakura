package host

import (
	"bytes"
	"errors"
	"sync"
)

// ErrSourceGroupUnknown means that process settlement could not be proved.
// Publication remains fenced until a human recovers an orphan after restart.
var ErrSourceGroupUnknown = errors.New("source process group settlement unknown")

// Background stdout and snapshots use independent buffer synchronization.
type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *synchronizedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}
func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// Done returns the registry-owned completion signal without reading mutable
// stdout/stderr buffers. Closing it means the foreground and its tracked process group settled;
// arbitrary detached host daemons remain an operator-managed trust boundary.
func (r *Registry) Done(id string) <-chan struct{} {
	r.mu.Lock()
	job := r.jobs[id]
	r.mu.Unlock()
	if job == nil {
		return nil
	}
	return job.done
}
