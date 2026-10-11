// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// Unwrap lets ResponseController reach Flush through this status tracker and
// through any middleware wrappers below it.
type gatewayResponseWriter struct {
	http.ResponseWriter
	committed bool
}

func (w *gatewayResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *gatewayResponseWriter) WriteHeader(status int) {
	w.committed = true
	w.ResponseWriter.WriteHeader(status)
}
func (w *gatewayResponseWriter) Write(p []byte) (int, error) {
	if !w.committed {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

// Keep the buffered reader for replay: it may already contain subsequent events.
func readStreamCommit(body *bufio.Reader) ([]byte, error) {
	var out bytes.Buffer
	atLineStart := true
	for out.Len() < 64<<10 {
		line, err := body.ReadSlice('\n')
		if out.Len()+len(line) > 64<<10 {
			return nil, errors.New("first stream event exceeds 64 KiB")
		}
		out.Write(line)
		if atLineStart && err == nil && (bytes.Equal(line, []byte("\n")) || bytes.Equal(line, []byte("\r\n"))) {
			return out.Bytes(), nil
		}
		atLineStart = err != bufio.ErrBufferFull
		if err != nil && err != bufio.ErrBufferFull {
			return nil, fmt.Errorf("stream failed before first complete event: %w", err)
		}
	}
	return nil, errors.New("first stream event exceeds 64 KiB")
}

var gatewayStreamBuffers = sync.Pool{New: func() any {
	buffer := make([]byte, 32<<10)
	return &buffer
}}

// A stream is bounded in working memory, not total lifetime bytes. Flush after
// each upstream read so a persistent SSE connection delivers tokens promptly.
func copyProviderStream(w http.ResponseWriter, body io.Reader) error {
	buffer := gatewayStreamBuffers.Get().(*[]byte)
	defer gatewayStreamBuffers.Put(buffer)
	controller := http.NewResponseController(w)
	for {
		n, readErr := body.Read(*buffer)
		if n > 0 {
			written, err := w.Write((*buffer)[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
			if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
				return err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}
