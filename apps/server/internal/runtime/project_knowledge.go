// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/httpx"
	"github.com/Moonrend/Zakura/apps/server/internal/projectknowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/knowledge"
	"github.com/Moonrend/Zakura/packages/projectkit/mission"
	"github.com/go-chi/chi/v5"
)

func (h *handler) initializeProjectKnowledge() {
	h.projectKnowledge = projectknowledge.NewStore(h.deps.DB, h.deps.Dialect, h.deps.Rebind)
}

// registerProjectKnowledge is mounted inside the existing {pid} route; the
// project's existing tenant-scoped authorization middleware applies throughout.
func (h *handler) registerProjectKnowledge(r chi.Router) {
	r.Get("/knowledge", h.projectKnowledgeList)
	r.Post("/knowledge", h.projectKnowledgeCreate)
	r.Get("/knowledge/search", h.projectKnowledgeSearch)
	r.Get("/knowledge/{kid}", h.projectKnowledgeGet)
	r.Patch("/knowledge/{kid}", h.projectKnowledgeUpdate)
	r.Delete("/knowledge/{kid}", h.projectKnowledgeDelete)
	r.Get("/knowledge/{kid}/history", h.projectKnowledgeHistory)
	r.Post("/knowledge/{kid}/state", h.projectKnowledgeState)
	r.Get("/knowledge/{kid}/comments", h.projectKnowledgeComments)
	r.Post("/knowledge/{kid}/comments", h.projectKnowledgeComment)
}
func knowledgeHTTPFilter(r *http.Request) knowledge.Filter {
	q := r.URL.Query()
	return knowledge.Filter{Kind: q.Get("kind"), Status: q.Get("status"), Tags: q["tag"], RunID: q.Get("runId"), TaskID: q.Get("taskId"), IncludeArchived: q.Get("includeArchived") == "true"}
}
func (h *handler) knowledgeRequest(r *http.Request) (mission.Scope, error) {
	p, err := h.requestProject(r)
	if err != nil {
		return mission.Scope{}, err
	}
	if h.projectKnowledge == nil {
		return mission.Scope{}, errors.New("project knowledge is unavailable")
	}
	return projectScope(p), nil
}
func knowledgeAuthor(r *http.Request) string {
	p := principal(r)
	if p.APIKey {
		return "api-key:" + p.APIKeyID
	}
	return p.UserID
}
func (h *handler) projectKnowledgeList(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	items, err := h.projectKnowledge.List(r.Context(), scope, knowledgeHTTPFilter(r), r.URL.Query().Get("cursor"), projectQueryInt(r, "limit", 50, 200))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, items)
}
func (h *handler) projectKnowledgeCreate(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var draft knowledge.Draft
	if httpx.DecodeJSON(r, &draft) != nil {
		httpx.Error(w, 400, "Invalid knowledge document")
		return
	}
	entry, err := h.projectKnowledge.Create(r.Context(), scope, draft, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, entry)
}
func (h *handler) projectKnowledgeGet(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	revision := int64(0)
	if value := r.URL.Query().Get("revision"); value != "" {
		revision, err = strconv.ParseInt(value, 10, 64)
		if err != nil || revision <= 0 {
			httpx.Error(w, 400, "Invalid immutable knowledge revision")
			return
		}
	}
	entry, err := h.projectKnowledge.Get(r.Context(), scope, chi.URLParam(r, "kid"), revision)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, entry)
}
func (h *handler) projectKnowledgeUpdate(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		knowledge.Draft
		ExpectedRevision int64  `json:"expectedRevision"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 {
		httpx.Error(w, 400, "Expected revision and complete document required")
		return
	}
	entry, err := h.projectKnowledge.Update(r.Context(), scope, chi.URLParam(r, "kid"), body.ExpectedRevision, body.Draft, body.Comment, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, entry)
}
func (h *handler) projectKnowledgeSearch(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	result, err := h.projectKnowledge.Search(ctx, scope, knowledge.Query{Text: r.URL.Query().Get("q"), Filter: knowledgeHTTPFilter(r), Limit: projectQueryInt(r, "limit", 20, 100), SnippetRunes: projectQueryInt(r, "snippetRunes", 240, 1000)})
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, result)
}
func (h *handler) projectKnowledgeHistory(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	before := int64(0)
	if value := r.URL.Query().Get("before"); value != "" {
		before, err = strconv.ParseInt(value, 10, 64)
		if err != nil || before <= 0 {
			httpx.Error(w, 400, "Invalid revision cursor")
			return
		}
	}
	items, err := h.projectKnowledge.History(r.Context(), scope, chi.URLParam(r, "kid"), before, projectQueryInt(r, "limit", 50, 200))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}
func (h *handler) projectKnowledgeDelete(w http.ResponseWriter, r *http.Request) {
	h.projectKnowledgeTransition(w, r, "delete")
}
func (h *handler) projectKnowledgeState(w http.ResponseWriter, r *http.Request) {
	h.projectKnowledgeTransition(w, r, "")
}
func (h *handler) projectKnowledgeTransition(w http.ResponseWriter, r *http.Request, fixed string) {
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		Action           string `json:"action"`
		Comment          string `json:"comment"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 {
		httpx.Error(w, 400, "Expected revision, action and explanatory comment required")
		return
	}
	if fixed != "" {
		body.Action = fixed
	}
	human := false
	if projectknowledge.HumanAction(body.Action) {
		p := principal(r)
		if p.UserID == "" || p.APIKey || p.OAuth || p.SessionID == "" || (p.Role != "owner" && p.Role != "admin" && p.Role != "member") {
			httpx.Error(w, 403, "Decision review and question resolution require an authenticated human member session")
			return
		}
		human = true
	}
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	entry, err := h.projectKnowledge.Transition(r.Context(), scope, chi.URLParam(r, "kid"), body.ExpectedRevision, body.Action, body.Comment, knowledgeAuthor(r), human)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 200, entry)
}
func (h *handler) projectKnowledgeComments(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	items, err := h.projectKnowledge.Comments(r.Context(), scope, chi.URLParam(r, "kid"), r.URL.Query().Get("cursor"), projectQueryInt(r, "limit", 100, 200))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	cursor := ""
	if len(items) > 0 {
		cursor = items[len(items)-1].ID
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "cursor": cursor})
}
func (h *handler) projectKnowledgeComment(w http.ResponseWriter, r *http.Request) {
	scope, err := h.knowledgeRequest(r)
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	var body struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		Body             string `json:"body"`
	}
	if httpx.DecodeJSON(r, &body) != nil || body.ExpectedRevision <= 0 {
		httpx.Error(w, 400, "Expected revision and comment body required")
		return
	}
	comment, err := h.projectKnowledge.AddComment(r.Context(), scope, chi.URLParam(r, "kid"), body.ExpectedRevision, body.Body, knowledgeAuthor(r))
	if err != nil {
		projectHTTPError(w, err)
		return
	}
	httpx.JSON(w, 201, comment)
}
func knowledgeToolJSON(raw json.RawMessage, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("single JSON object required")
	}
	return nil
}
func (h *handler) projectKnowledgePerform(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.ToolResult, error) {
	if h.projectKnowledge == nil {
		return mission.ToolResult{}, errors.New("project knowledge is unavailable")
	}
	var result any
	var err error
	switch op.Call.Name {
	case "project_note":
		return h.projectKnowledge.NoteOperation(ctx, a, op)
	case "knowledge_search":
		var body struct {
			Query  string   `json:"query"`
			Kind   string   `json:"kind"`
			Status string   `json:"status"`
			Tags   []string `json:"tags"`
			RunID  string   `json:"runId"`
			TaskID string   `json:"taskId"`
			Limit  int      `json:"limit"`
		}
		if err = knowledgeToolJSON(op.Call.Arguments, &body); err != nil {
			return mission.ToolResult{}, err
		}
		if body.Limit <= 0 {
			body.Limit = 5
		}
		if body.Limit > 10 {
			return mission.ToolResult{}, errors.New("model knowledge searches allow at most 10 results")
		}
		search, e := h.projectKnowledge.Search(ctx, a.Scope, knowledge.Query{Text: body.Query, Filter: knowledge.Filter{Kind: body.Kind, Status: body.Status, Tags: body.Tags, RunID: body.RunID, TaskID: body.TaskID}, Limit: body.Limit, MaxCandidates: 500, SnippetRunes: 400})
		err = e
		// Return references and excerpts, avoiding full document injection. The
		// model can explicitly request an exact immutable revision if necessary.
		for i := range search.Items {
			search.Items[i].Entry.Body = ""
		}
		result = map[string]any{"result": search, "untrustedReference": true}
	case "knowledge_read":
		var body struct {
			EntryID  string `json:"entryId"`
			Revision int64  `json:"revision"`
			Offset   int    `json:"offset"`
			MaxRunes int    `json:"maxRunes"`
		}
		if err = knowledgeToolJSON(op.Call.Arguments, &body); err != nil {
			return mission.ToolResult{}, err
		}
		if body.Offset < 0 || body.Revision < 0 {
			return mission.ToolResult{}, errors.New("invalid knowledge revision or text offset")
		}
		if body.MaxRunes <= 0 {
			body.MaxRunes = 4000
		}
		if body.MaxRunes > 8000 {
			return mission.ToolResult{}, errors.New("model knowledge excerpts allow at most 8000 code points")
		}
		entry, e := h.projectKnowledge.Get(ctx, a.Scope, body.EntryID, body.Revision)
		err = e
		if err == nil {
			runes := []rune(entry.Body)
			start := body.Offset
			if start > len(runes) {
				start = len(runes)
			}
			end := start + body.MaxRunes
			if end > len(runes) {
				end = len(runes)
			}
			entry.Body = string(runes[start:end])
			result = map[string]any{"entry": entry, "offset": start, "totalRunes": len(runes), "truncated": end < len(runes), "untrustedReference": true}
		}
	default:
		return mission.ToolResult{}, errors.New("unsupported project knowledge tool")
	}
	if err != nil {
		return mission.ToolResult{}, err
	}
	raw, err := json.Marshal(result)
	return mission.ToolResult{Content: raw}, err
}
func (h *handler) projectKnowledgeInspect(ctx context.Context, a mission.Assignment, op mission.Operation) (mission.Inspection, error) {
	if h.projectKnowledge == nil {
		return mission.Inspection{}, errors.New("project knowledge is unavailable")
	}
	if op.Call.Name == "project_note" {
		return h.projectKnowledge.InspectNote(ctx, a.Scope, op)
	}
	if strings.HasPrefix(op.Call.Name, "knowledge_") {
		result, err := h.projectKnowledgePerform(ctx, a, op)
		return mission.Inspection{Known: err == nil, Result: result}, err
	}
	return mission.Inspection{}, errors.New("unsupported project knowledge tool")
}
