package sys

import "testing"

func TestEqualFoldHex(t *testing.T) {
	if !equalFoldHex("abc", "ABC") {
		t.Fatal("hex 应忽略大小写")
	}
	if equalFoldHex("aa", "bb") {
		t.Fatal("不同摘要不应匹配")
	}
}
