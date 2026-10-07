// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"sync"
	"time"
)

type psProgressEvent struct {
	TS      int64  `json:"ts"`
	Level   string `json:"level"`
	Step    string `json:"step"`
	Message string `json:"message"`
	Percent int    `json:"percent,omitempty"`
}

type psProgressSnapshot struct {
	ServiceKey string            `json:"serviceKey"`
	Phase      string            `json:"phase"`
	Percent    int               `json:"percent"`
	Running    bool              `json:"running"`
	Done       bool              `json:"done"`
	Error      *string           `json:"error"`
	Message    string            `json:"message"`
	Events     []psProgressEvent `json:"events"`
	UpdatedAt  int64             `json:"updatedAt"`
}

const (
	psProgressMaxEvents    = 400
	psProgressMessageLimit = 500
)

var (
	psProgressMu    sync.Mutex
	psProgressStore = map[string]*psProgressSnapshot{}
)

func psTruncateMessage(message string) string {
	runes := []rune(message)
	if len(runes) > psProgressMessageLimit {
		return string(runes[:psProgressMessageLimit])
	}
	return message
}

func psClampPercent(percent int) int {
	if percent < 0 {
		return 0
	}
	if percent > 100 {
		return 100
	}
	return percent
}

func psProgressIdle(serviceKey string) *psProgressSnapshot {
	return &psProgressSnapshot{ServiceKey: serviceKey, Phase: "idle", Percent: 0, Running: false, Done: false, Error: nil, Message: "", Events: []psProgressEvent{}, UpdatedAt: time.Now().UnixMilli()}
}

func psCloneProgress(s *psProgressSnapshot) *psProgressSnapshot {
	if s == nil {
		return nil
	}
	out := *s
	out.Events = append([]psProgressEvent{}, s.Events...)
	return &out
}

func psProgressSnapshotFor(key string) *psProgressSnapshot {
	psProgressMu.Lock()
	cur := psProgressStore[key]
	var out *psProgressSnapshot
	if cur != nil {
		out = psCloneProgress(cur)
	}
	psProgressMu.Unlock()
	if out == nil {
		return psProgressIdle(key)
	}
	return out
}

func psAppendEvent(s *psProgressSnapshot, ev psProgressEvent) {
	s.Events = append(s.Events, ev)
	if len(s.Events) > psProgressMaxEvents {
		s.Events = s.Events[len(s.Events)-psProgressMaxEvents:]
	}
}

func publishPSProgress(s *psProgressSnapshot) {
	broadcastPlatform("platform", map[string]any{"type": "platform_service_progress", "ts": time.Now().UnixMilli(), "serviceKey": s.ServiceKey, "snapshot": s})
}

func beginPSProgress(key, phase, message string) {
	psProgressMu.Lock()
	s := psProgressStore[key]
	if s == nil {
		s = psProgressIdle(key)
		psProgressStore[key] = s
	}
	s.Phase = phase
	s.Message = psTruncateMessage(message)
	s.Running = true
	s.Done = false
	s.Error = nil
	if s.Percent < 2 {
		s.Percent = 2
	}
	s.UpdatedAt = time.Now().UnixMilli()
	psAppendEvent(s, psProgressEvent{TS: time.Now().UnixMilli(), Level: "info", Step: phase, Message: psTruncateMessage(message)})
	out := psCloneProgress(s)
	psProgressMu.Unlock()
	publishPSProgress(out)
}

func logPSProgress(key, step, message, level string, percent int, phase string) {
	psProgressMu.Lock()
	s := psProgressStore[key]
	if s == nil {
		s = psProgressIdle(key)
		psProgressStore[key] = s
	}
	if percent >= 0 {
		s.Percent = psClampPercent(percent)
	}
	if phase != "" {
		s.Phase = phase
	}
	s.Message = psTruncateMessage(message)
	s.Running = true
	s.Done = false
	s.Error = nil
	s.UpdatedAt = time.Now().UnixMilli()
	ev := psProgressEvent{TS: time.Now().UnixMilli(), Level: level, Step: step, Message: psTruncateMessage(message)}
	if percent >= 0 {
		ev.Percent = psClampPercent(percent)
	}
	psAppendEvent(s, ev)
	out := psCloneProgress(s)
	psProgressMu.Unlock()
	publishPSProgress(out)
}

func finishPSProgress(key string, errMsg string, message string) {
	psProgressMu.Lock()
	s := psProgressStore[key]
	if s == nil {
		s = psProgressIdle(key)
		psProgressStore[key] = s
	}
	if message == "" {
		if errMsg != "" {
			message = errMsg
		} else {
			message = "完成"
		}
	}
	s.Running = false
	s.Done = true
	s.Percent = 100
	s.Message = psTruncateMessage(message)
	s.UpdatedAt = time.Now().UnixMilli()
	ev := psProgressEvent{TS: time.Now().UnixMilli(), Message: psTruncateMessage(message), Percent: 100}
	if errMsg != "" {
		s.Phase = "error"
		s.Error = &errMsg
		ev.Level = "error"
		ev.Step = "error"
	} else {
		s.Phase = "done"
		s.Error = nil
		ev.Level = "ok"
		ev.Step = "done"
	}
	psAppendEvent(s, ev)
	out := psCloneProgress(s)
	psProgressMu.Unlock()
	publishPSProgress(out)
}
