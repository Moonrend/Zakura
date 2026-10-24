// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
)

func (g *Gateway) resolveCandidates(ctx context.Context, tenant, capability, model string) ([]ModelCandidate, error) {
	if model == "" {
		return g.store.ResolveCandidates(ctx, tenant, capability, model)
	}
	routes, err := g.store.ListRoutes(ctx, tenant, capability)
	if err != nil {
		return nil, err
	}
	for _, route := range routes {
		if route.ID != model {
			continue
		}
		if route.Status != "ready" {
			return nil, ErrNotFound
		}
		upstream, err := g.store.GetUpstream(ctx, tenant, route.UpstreamID)
		if err != nil || upstream.Status != "ready" {
			return nil, ErrNotFound
		}
		return []ModelCandidate{{Route: route, Upstream: upstream}}, nil
	}
	matched := false
	for _, route := range routes {
		if route.Status == "ready" && (route.Model == model || route.Slug == model || (route.Alias != nil && *route.Alias == model)) {
			matched = true
			break
		}
	}
	if !matched {
		return nil, ErrNotFound
	}
	return g.store.ResolveCandidates(ctx, tenant, capability, model)
}

func copyProviderResponse(w http.ResponseWriter, resp *ProviderResponse) error {
	defer resp.Body.Close()
	for _, key := range []string{"Retry-After", "X-Request-Id", "Request-Id", "Openai-Processing-Ms"} {
		if value := resp.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	if resp.Status < 200 || resp.Status >= 300 {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			writeGatewayError(w, resp.Operation, http.StatusBadGateway, err.Error(), "upstream_error")
			return err
		}
		message := gwOr(gwErrorMessage(body), http.StatusText(resp.Status))
		if stream, ok := w.(*gatewayStreamWriter); ok {
			return stream.writeError(resp.Operation, resp.Status, message, "upstream_error")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.Status)
		_, err = w.Write(gwErrorBody(resp.Operation, resp.Status, message, "upstream_error"))
		return err
	}
	if resp.Stream && isEventStream(resp.Header.Get("Content-Type")) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(resp.Status)
		if gwPassthrough(resp.Protocol, resp.Operation) {
			buffer := make([]byte, 32<<10)
			reader := io.LimitReader(resp.Body, maxProviderResponse)
			for {
				n, err := reader.Read(buffer)
				if n > 0 {
					if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
						return writeErr
					}
					if flushErr := http.NewResponseController(w).Flush(); flushErr != nil && !errors.Is(flushErr, http.ErrNotSupported) {
						return flushErr
					}
				}
				if err == io.EOF {
					return nil
				}
				if err != nil {
					return err
				}
			}
		}
		return translateGatewayStream(w, resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProviderResponse+1))
	if err == nil && len(body) > maxProviderResponse {
		err = errors.New("provider response exceeds size limit")
	}
	if err != nil {
		writeGatewayError(w, resp.Operation, http.StatusBadGateway, err.Error(), "upstream_error")
		return err
	}
	if resp.Stream && gwChatOperation(resp.Operation) {
		res, ok := gwParseResult(resp.Protocol, body)
		if !ok {
			err = errors.New("upstream returned an invalid completion")
			writeGatewayError(w, resp.Operation, http.StatusBadGateway, err.Error(), "upstream_error")
			return err
		}
		res.Model = gwOr(res.Model, resp.Model)
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(resp.Status)
		encoder := &gwStreamEncoder{w: w, operation: resp.Operation}
		if err = encoder.start(res); err != nil {
			return err
		}
		for _, delta := range []gwStreamDelta{{reasoning: res.Reasoning}, {text: res.Text}} {
			if err = encoder.delta(delta); err != nil {
				return err
			}
		}
		for index, call := range res.ToolCalls {
			tool := &gwStreamTool{gwToolCall: call, index: index}
			if err = encoder.delta(gwStreamDelta{tool: tool, arguments: call.Arguments}); err != nil {
				return err
			}
		}
		return encoder.finish(res)
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" || gwChatOperation(resp.Operation) {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(resp.Status)
	_, err = w.Write(normalizeProviderResponse(resp.Protocol, resp.Operation, body))
	return err
}

func writeGatewayError(w http.ResponseWriter, operation string, status int, message, code string) {
	if stream, ok := w.(*gatewayStreamWriter); ok {
		_ = stream.writeError(operation, status, message, code)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(gwErrorBody(operation, status, message, code))
}

func writeGatewayFailure(w http.ResponseWriter, operation string, err error) {
	status, message, code := http.StatusBadGateway, err.Error(), "upstream_error"
	var routeErr *gatewayRouteError
	if errors.As(err, &routeErr) && routeErr.Status > 0 {
		status = routeErr.Status
		message = gwOr(gwErrorMessage(routeErr.Body), err.Error())
		if routeErr.RetryAfter != "" {
			w.Header().Set("Retry-After", routeErr.RetryAfter)
		}
	} else if errors.Is(err, ErrNotFound) {
		status, message, code = http.StatusNotFound, "No available model route matches the request", "model_not_found"
	}
	writeGatewayError(w, operation, status, strings.TrimSpace(message), code)
}
