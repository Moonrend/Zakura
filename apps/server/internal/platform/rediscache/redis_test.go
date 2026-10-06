package rediscache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func TestCacheRoundtrip(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer mr.Close()
	c := Open(context.Background(), "redis://"+mr.Addr())
	if !c.Enabled() {
		t.Fatal("expected enabled cache")
	}
	ctx := context.Background()
	c.Set(ctx, "zakura:roundtrip", []byte("value"), time.Minute)
	if got, ok := c.Get(ctx, "zakura:roundtrip"); !ok || string(got) != "value" {
		t.Fatalf("get = %q ok=%v", got, ok)
	}
	c.Del(ctx, "zakura:roundtrip")
	if got, ok := c.Get(ctx, "zakura:roundtrip"); ok {
		t.Fatalf("expected miss after del, got %q", got)
	}
}

func TestCacheBadURLDisabled(t *testing.T) {
	c := Open(context.Background(), "not-a-redis-url")
	if c.Enabled() {
		t.Fatal("expected disabled cache for bad url")
	}
	ctx := context.Background()
	if _, ok := c.Get(ctx, "zakura:x"); ok {
		t.Fatal("disabled get should miss")
	}
	c.Set(ctx, "zakura:x", []byte("v"), time.Second)
	c.Del(ctx, "zakura:x")
}

func TestCacheUnreachableDisabled(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	addr := mr.Addr()
	mr.Close()
	c := Open(context.Background(), "redis://"+addr)
	if c.Enabled() {
		t.Fatal("expected disabled cache for unreachable url")
	}
	if _, ok := c.Get(context.Background(), "zakura:x"); ok {
		t.Fatal("unreachable get should miss")
	}
}
