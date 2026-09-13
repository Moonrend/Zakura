package rpc

import "encoding/json"

// Msg 控制面与代理之间的 JSON 帧。流数据用 base64 放在 Data。
type Msg struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	OK     *bool           `json:"ok,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
	Stream string          `json:"stream,omitempty"`
	Chan   string          `json:"chan,omitempty"`
	Data   string          `json:"data,omitempty"`
}

func Ok(id string, result any) Msg {
	raw, _ := json.Marshal(result)
	t := true
	return Msg{Type: "res", ID: id, OK: &t, Result: raw}
}

func Err(id, message string) Msg {
	f := false
	return Msg{Type: "res", ID: id, OK: &f, Error: message}
}

func Hello(token, version, kind string) Msg {
	p, _ := json.Marshal(map[string]string{
		"token":   token,
		"version": version,
		"kind":    kind,
	})
	return Msg{Type: "hello", Params: p}
}
