// SPDX-License-Identifier: AGPL-3.0-or-later
package runtime

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func writeMaskedText(t *testing.T, conn net.Conn, text string) {
	t.Helper()
	payload := []byte(text)
	head := []byte{0x81}
	n := len(payload)
	if n < 126 {
		head = append(head, 0x80|byte(n))
	} else {
		head = append(head, 0x80|126, byte(n>>8), byte(n))
	}
	mask := []byte{1, 2, 3, 4}
	head = append(head, mask...)
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	if _, e := conn.Write(append(head, payload...)); e != nil {
		t.Fatal(e)
	}
}
func readServerText(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	head := make([]byte, 2)
	if _, e := io.ReadFull(r, head); e != nil {
		t.Fatal(e)
	}
	n := uint64(head[1] & 0x7f)
	if n == 126 {
		var b [2]byte
		_, _ = io.ReadFull(r, b[:])
		n = uint64(binary.BigEndian.Uint16(b[:]))
	} else if n == 127 {
		var b [8]byte
		_, _ = io.ReadFull(r, b[:])
		n = binary.BigEndian.Uint64(b[:])
	}
	payload := make([]byte, n)
	_, _ = io.ReadFull(r, payload)
	return string(payload)
}
func TestSocketIOWebSocketHandshakeAndAuth(t *testing.T) {
	d := testDeps(t)
	token := seedTenant(t, d, "tenant")
	router := chi.NewRouter()
	RegisterRoutes(router, d)
	server := httptest.NewServer(router)
	defer server.Close()
	u, _ := url.Parse(server.URL)
	conn, e := net.Dial("tcp", u.Host)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	_, _ = fmt.Fprintf(conn, "GET /api/socket.io?EIO=4&transport=websocket HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host)
	reader := bufio.NewReader(conn)
	status, _ := reader.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade status %s", status)
	}
	for {
		line, _ := reader.ReadString('\n')
		if line == "\r\n" {
			break
		}
	}
	if open := readServerText(t, reader); !strings.HasPrefix(open, "0{") {
		t.Fatalf("open packet %s", open)
	}
	writeMaskedText(t, conn, `40{"token":"`+token+`"}`)
	connected := readServerText(t, reader)
	if !strings.HasPrefix(connected, "40{") {
		t.Fatalf("connect packet %s", connected)
	}
	presence := readServerText(t, reader)
	if !strings.Contains(presence, "presence:state") {
		t.Fatalf("presence packet %s", presence)
	}
}
