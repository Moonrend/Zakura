package projectrunner

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const MaxSourceActivities = 100000
const MaxSourceActivityBytes = 32 << 10

type sourceActivity struct {
	ReviewID   string    `json:"reviewId,omitempty"`
	Comment    string    `json:"comment,omitempty"`
	Resolution string    `json:"resolution,omitempty"`
	ID         string    `json:"id"`
	SpaceID    string    `json:"spaceId"`
	State      string    `json:"state"`
	StartedAt  time.Time `json:"startedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Legacy host processes may survive an agent crash. A durable active intent is
// therefore never silently discarded by a new handler. After a crash the
// operator must quiesce those host groups and review the exact orphaned ID
// set through the authenticated control plane; model tools have no bypass.
func (m *Manager) ensureSourceActivities() error {
	m.sourceInitialize.Do(func() {
		root, err := SecureDirectory(m.storageRoot, "source-processes")
		if err != nil {
			m.sourceInitializeError = err
			return
		}
		m.sourceRoot = root
		files, err := os.ReadDir(root)
		if err != nil {
			m.sourceInitializeError = err
			return
		}
		if len(files) > MaxSourceActivities {
			m.sourceInitializeError = errors.New("source process activity journal capacity exceeded")
			return
		}
		active := map[string]int{}
		records := map[string]sourceActivity{}
		for _, entry := range files {
			if strings.HasPrefix(entry.Name(), ".source-") {
				continue
			}
			if !strings.HasSuffix(entry.Name(), ".json") {
				m.sourceInitializeError = errors.New("unexpected source process journal entry")
				return
			}
			token := strings.TrimSuffix(entry.Name(), ".json")
			if ValidateID(token) != nil {
				m.sourceInitializeError = errors.New("invalid source process journal identifier")
				return
			}
			file := filepath.Join(root, entry.Name())
			info, err := os.Lstat(file)
			if err != nil || !info.Mode().IsRegular() || info.Size() > MaxSourceActivityBytes {
				m.sourceInitializeError = errors.New("invalid source process activity journal")
				return
			}
			data, err := os.ReadFile(file)
			if err != nil {
				m.sourceInitializeError = err
				return
			}
			var record sourceActivity
			if json.Unmarshal(data, &record) != nil || record.ID != token || (record.SpaceID != "" && ValidateID(record.SpaceID) != nil) || (record.State != "active" && record.State != "settled") {
				m.sourceInitializeError = errors.New("corrupt source process activity journal")
				return
			}
			if record.State == "active" {
				active[record.SpaceID]++
				records[record.ID] = record
			}
		}
		m.mu.Lock()
		for id, record := range records {
			m.sourceRecords[id] = record
		}
		for scope, count := range active {
			m.sourceActive[scope] += count
		}
		m.mu.Unlock()
	})
	return m.sourceInitializeError
}
func (m *Manager) persistSourceActivity(record sourceActivity) error {
	data, err := json.Marshal(record)
	if err == nil && len(data) > MaxSourceActivityBytes {
		err = errors.New("source activity record exceeds limit")
	}
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(m.sourceRoot, ".source-")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, filepath.Join(m.sourceRoot, record.ID+".json")); err != nil {
		return err
	}
	directory, err := os.Open(m.sourceRoot)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

type SourceActivityInfo struct {
	ID          string    `json:"id"`
	SpaceID     string    `json:"spaceId"`
	Status      string    `json:"status"`
	RuntimeLive bool      `json:"runtimeLive"`
	StartedAt   time.Time `json:"startedAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func (m *Manager) SourceActivities(spaceID string) ([]SourceActivityInfo, error) {
	if err := ValidateID(spaceID); err != nil {
		return nil, err
	}
	if err := m.ensureSourceActivities(); err != nil {
		return nil, err
	}
	m.sourceGate.RLock()
	defer m.sourceGate.RUnlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	activities := []SourceActivityInfo{}
	for _, record := range m.sourceRecords {
		if record.SpaceID != "" && record.SpaceID != spaceID {
			continue
		}
		live := m.sourceCurrent[record.ID]
		status := "orphaned"
		if live {
			status = "current"
		}
		activities = append(activities, SourceActivityInfo{ID: record.ID, SpaceID: record.SpaceID, Status: status, RuntimeLive: live, StartedAt: record.StartedAt, UpdatedAt: record.UpdatedAt})
	}
	sort.Slice(activities, func(i, j int) bool { return activities[i].ID < activities[j].ID })
	return activities, nil
}
func (m *Manager) confirmSourceActivities(req Request) (any, error) {
	if !req.Approved || ValidateID(req.ReviewID) != nil {
		return nil, errors.New("source recovery requires an approved operator attestation")
	}
	if len(req.Comment) > 4096 {
		return nil, errors.New("source recovery comment exceeds limit")
	}
	if len(req.ActivityIDs) == 0 || len(req.ActivityIDs) > 10000 {
		return nil, errors.New("source recovery requires a bounded exact activity ID set")
	}
	if err := m.ensureSourceActivities(); err != nil {
		return nil, err
	}
	m.sourceGate.Lock()
	defer m.sourceGate.Unlock()
	requested := map[string]bool{}
	for _, id := range req.ActivityIDs {
		if ValidateID(id) != nil || requested[id] {
			return nil, errors.New("invalid or duplicate source activity ID")
		}
		requested[id] = true
	}
	m.mu.Lock()
	orphaned := map[string]sourceActivity{}
	for id, record := range m.sourceRecords {
		if record.SpaceID == "" {
			m.mu.Unlock()
			return nil, errors.New("unscoped source activities require runner node administration; a project cannot clear them")
		}
		if record.SpaceID != req.SpaceID {
			continue
		}
		if m.sourceCurrent[id] {
			m.mu.Unlock()
			return nil, errors.New("current source registrations cannot be confirmed; wait for tracked processes to settle")
		}
		orphaned[id] = record
	}
	m.mu.Unlock()
	if len(requested) != len(orphaned) {
		return nil, errors.New("source activity set changed; refresh and attest the complete orphaned ID set")
	}
	for id := range orphaned {
		if !requested[id] {
			return nil, errors.New("source activity set changed; refresh and attest the complete orphaned ID set")
		}
	}
	confirmed := []string{}
	ids := make([]string, 0, len(requested))
	for id := range requested {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		record := orphaned[id]
		record.State = "settled"
		record.Resolution = "human_attestation"
		record.ReviewID = req.ReviewID
		record.Comment = req.Comment
		record.UpdatedAt = time.Now().UTC()
		if err := m.persistSourceActivity(record); err != nil {
			return map[string]any{"confirmed": confirmed, "reviewId": req.ReviewID}, errors.New("source activity confirmation persistence failed; inspect the remaining activity set")
		}
		m.mu.Lock()
		delete(m.sourceRecords, id)
		m.sourceActive[record.SpaceID]--
		if m.sourceActive[record.SpaceID] == 0 {
			delete(m.sourceActive, record.SpaceID)
		}
		m.mu.Unlock()
		confirmed = append(confirmed, id)
	}
	return map[string]any{"confirmed": confirmed, "reviewId": req.ReviewID}, nil
}
