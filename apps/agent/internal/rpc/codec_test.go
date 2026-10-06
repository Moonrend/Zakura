package rpc

import (
	"encoding/json"
	"testing"
)

func TestOkErrRoundtrip(t *testing.T) {
	ok := Ok("1", map[string]int{"n": 2})
	if ok.Type != "res" || ok.OK == nil || !*ok.OK {
		t.Fatal(ok)
	}
	var n struct {
		N int `json:"n"`
	}
	if err := json.Unmarshal(ok.Result, &n); err != nil || n.N != 2 {
		t.Fatal(err, n)
	}
	er := Err("1", "boom")
	if er.OK == nil || *er.OK || er.Error != "boom" {
		t.Fatal(er)
	}
}
