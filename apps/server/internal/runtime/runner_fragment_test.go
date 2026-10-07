package runtime

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestRunnerReassemblesOrdinaryFragmentedOutput(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	defer conn.Close()
	pending := make(chan runnerReply, 1)
	s := &runnerSession{conn: conn, rw: bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn)), writeGate: make(chan struct{}, 1), done: make(chan struct{}), pending: map[string]chan runnerReply{"42": pending}}
	go s.readLoop()
	go func() { _, _ = io.Copy(io.Discard, peer) }() // consume pong while client writes
	body, _ := json.Marshal(map[string]any{"type": "res", "id": "42", "ok": true, "result": map[string]any{"stdout": strings.Repeat("ordinary fixture", 4000)}})
	write := func(final bool, opcode byte, payload []byte) {
		var b bytes.Buffer
		first := opcode
		if final {
			first |= 0x80
		}
		b.WriteByte(first)
		if len(payload) < 126 {
			b.WriteByte(0x80 | byte(len(payload)))
		} else {
			b.WriteByte(0x80 | 126)
			_ = binary.Write(&b, binary.BigEndian, uint16(len(payload)))
		}
		mask := []byte{1, 2, 3, 4}
		b.Write(mask)
		for i, v := range payload {
			b.WriteByte(v ^ mask[i%4])
		}
		if _, e := peer.Write(b.Bytes()); e != nil {
			t.Fatal(e)
		}
	}
	for start := 0; start < len(body); start += 4096 {
		end := start + 4096
		if end > len(body) {
			end = len(body)
		}
		opcode := byte(0)
		if start == 0 {
			opcode = 1
		}
		write(end == len(body), opcode, body[start:end])
		if start == 0 {
			write(true, 9, []byte("fixture ping"))
		}
	}
	select {
	case reply := <-pending:
		var out map[string]string
		if e := json.Unmarshal(reply.result, &out); e != nil || out["stdout"] != strings.Repeat("ordinary fixture", 4000) {
			t.Fatalf("lost fragmented JSON: %v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("fragmented runner reply was not delivered")
	}
}
