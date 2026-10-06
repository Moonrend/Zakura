package admin

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/appdeps"
	platformdb "github.com/Moonrend/Zakura/apps/server/internal/platform/db"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/migrations"
)

func infraTestSecret(t *testing.T) []byte {
	t.Helper()
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return secret
}

func TestSealOpenAdminRoundTrip(t *testing.T) {
	secret := infraTestSecret(t)
	values := []string{
		"redis://user:secret@host:6379",
		"rediss://:p@ssword@host:6380/0",
		"redis://host:6379",
		"redis://用户名:密码@主机:6379/0",
		"redis://user:p@ss:w/ord?x=1#frag",
		"redis://[2001:db8::1]:6379",
		"redis://user:secret@host:6379/2?timeout=5s",
	}
	for _, want := range values {
		sealed, err := sealAdmin(secret, []byte(want))
		if err != nil {
			t.Fatalf("sealAdmin(%q): %v", want, err)
		}
		if sealed == "" {
			t.Fatalf("sealAdmin(%q) returned empty payload", want)
		}
		got, err := openAdmin(secret, sealed)
		if err != nil {
			t.Fatalf("openAdmin(%q): %v", want, err)
		}
		if got != want {
			t.Errorf("roundtrip %q -> %q", want, got)
		}
	}
}

func TestOpenAdminRejectsWrongSecretAndTampering(t *testing.T) {
	secret := infraTestSecret(t)
	sealed, err := sealAdmin(secret, []byte("redis://user:secret@host:6379"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openAdmin(infraTestSecret(t), sealed); err == nil {
		t.Fatal("openAdmin accepted a different secret")
	}
	if _, err := openAdmin(secret, sealed+"x"); err == nil {
		t.Fatal("openAdmin accepted a tampered payload")
	}
	if _, err := openAdmin(secret, "not-base64!!"); err == nil {
		t.Fatal("openAdmin accepted invalid base64")
	}
	if _, err := openAdmin(secret, ""); err == nil {
		t.Fatal("openAdmin accepted an empty payload")
	}
}

func TestMaskRedisURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"redis://user:secret@host:6379", "redis://user:****@host:6379"},
		{"rediss://user:secret@host:6380/0", "rediss://user:****@host:6380/0"},
		{"redis://user:secret@host:6379/2?timeout=5s", "redis://user:****@host:6379/2?timeout=5s"},
		{"redis://:pass@host:6379", "redis://:****@host:6379"},
		{"redis://host:6379", "redis://host:6379"},
		{"redis://user@host:6379", "redis://user@host:6379"},
		{"redis://[2001:db8::1]:6379", "redis://[2001:db8::1]:6379"},
		{"redis://", "<configured>"},
		{"not a url", "<configured>"},
		{"://bad", "<configured>"},
		{"", "<configured>"},
	}
	for _, c := range cases {
		if got := maskRedisURL(c.in); got != c.want {
			t.Errorf("maskRedisURL(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestRedisInfraRoutes(t *testing.T) {
	a := infraTestRoutes(t)

	put := infraCall(t, a.putRedisInfra, http.MethodPut, `{"url":"redis://user:secret@host:6379"}`)
	if put.Code != http.StatusOK {
		t.Fatalf("put valid: %d %s", put.Code, put.Body.String())
	}
	body := infraDecode(t, put)
	if body["configured"] != true || body["url"] != "redis://user:****@host:6379" {
		t.Fatalf("put valid body: %v", body)
	}

	var stored string
	if err := a.d.DB.QueryRow(`SELECT value FROM settings WHERE owner_key='platform' AND key=?`, redisURLSettingKey).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == "" || stored == "redis://user:secret@host:6379" {
		t.Fatalf("stored value is not sealed: %q", stored)
	}
	plain, err := openAdmin(a.d.Secret, stored)
	if err != nil || plain != "redis://user:secret@host:6379" {
		t.Fatalf("stored value unseal: %q err=%v", plain, err)
	}

	get := infraCall(t, a.getRedisInfra, http.MethodGet, "")
	if get.Code != http.StatusOK {
		t.Fatalf("get: %d %s", get.Code, get.Body.String())
	}
	body = infraDecode(t, get)
	if body["configured"] != true || body["url"] != "redis://user:****@host:6379" {
		t.Fatalf("get body: %v", body)
	}

	for _, invalid := range []string{`{"url":"http://host:6379"}`, `{"url":"ftp://host"}`, `{"url":"not a url"}`, `{"url":":::"}`} {
		bad := infraCall(t, a.putRedisInfra, http.MethodPut, invalid)
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s: %d %s", invalid, bad.Code, bad.Body.String())
		}
	}
	if err := a.d.DB.QueryRow(`SELECT value FROM settings WHERE owner_key='platform' AND key=?`, redisURLSettingKey).Scan(&stored); err != nil || stored == "" {
		t.Fatalf("invalid put clobbered stored value: %q err=%v", stored, err)
	}

	if err := a.writeSetting(context.Background(), redisURLSettingKey, "not-decryptable"); err != nil {
		t.Fatal(err)
	}
	broken := infraCall(t, a.getRedisInfra, http.MethodGet, "")
	body = infraDecode(t, broken)
	if broken.Code != http.StatusOK || body["configured"] != true || body["url"] != "<configured>" {
		t.Fatalf("undecryptable get: %d %v", broken.Code, body)
	}

	cleared := infraCall(t, a.putRedisInfra, http.MethodPut, `{"url":"   "}`)
	if cleared.Code != http.StatusOK {
		t.Fatalf("clear: %d %s", cleared.Code, cleared.Body.String())
	}
	if body = infraDecode(t, cleared); body["configured"] != false {
		t.Fatalf("clear body: %v", body)
	}
	var remaining int
	if err := a.d.DB.QueryRow(`SELECT COUNT(*) FROM settings WHERE owner_key='platform' AND key=?`, redisURLSettingKey).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("row not deleted: %d err=%v", remaining, err)
	}
	after := infraCall(t, a.getRedisInfra, http.MethodGet, "")
	if body = infraDecode(t, after); body["configured"] != false {
		t.Fatalf("get after clear: %v", body)
	}
}

func infraTestRoutes(t *testing.T) *routes {
	t.Helper()
	c, err := platformdb.Open(context.Background(), "file:"+filepath.Join(t.TempDir(), "zakura.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.DB.Close() })
	if err := migrations.Apply(context.Background(), c.DB, c.Dialect, c.Rebind); err != nil {
		t.Fatal(err)
	}
	gormDB, err := c.Gorm()
	if err != nil {
		t.Fatal(err)
	}
	var seq atomic.Int64
	deps := &appdeps.Dependencies{
		DB:          c.DB,
		Gorm:        gormDB,
		Dialect:     c.Dialect,
		Rebind:      c.Rebind,
		Clock:       func() time.Time { return time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC) },
		NewID:       func() string { return fmt.Sprintf("%026d", seq.Add(1)) },
		Secret:      infraTestSecret(t),
		PublicURL:   "http://api.test",
		WebURL:      "http://web.test",
		Edition:     "self-hosted",
		MultiTenant: true,
	}
	return &routes{d: deps}
}

func infraCall(t *testing.T, h http.HandlerFunc, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/admin/infra/redis", strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	h(rr, req)
	return rr
}

func infraDecode(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", rr.Body.String(), err)
	}
	return out
}
