package config

import "testing"

func TestLoadRejectsAmbiguousProductionConfiguration(t *testing.T) {
	t.Setenv("ZAKURA_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUBLIC_BASE_URL", "relative/path")
	if _, err := Load(); err == nil {
		t.Fatal("relative PUBLIC_BASE_URL was accepted")
	}
	t.Setenv("PUBLIC_BASE_URL", "https://api.example.test")
	t.Setenv("WEB_PUBLIC_URL", "https://web.example.test")
	t.Setenv("AUTO_MIGRATE", "sometimes")
	if _, err := Load(); err == nil {
		t.Fatal("invalid AUTO_MIGRATE was accepted")
	}
	t.Setenv("AUTO_MIGRATE", "false")
	t.Setenv("HTTP_READ_TIMEOUT", "0s")
	if _, err := Load(); err == nil {
		t.Fatal("non-positive HTTP_READ_TIMEOUT was accepted")
	}
}

func TestLoadValidConfiguration(t *testing.T) {
	t.Setenv("ZAKURA_SECRET", "0123456789abcdef0123456789abcdef")
	t.Setenv("PUBLIC_BASE_URL", "https://api.example.test")
	t.Setenv("WEB_PUBLIC_URL", "https://web.example.test")
	t.Setenv("AUTO_MIGRATE", "false")
	t.Setenv("MULTI_TENANT", "true")
	t.Setenv("HTTP_READ_TIMEOUT", "20s")
	t.Setenv("HTTP_WRITE_TIMEOUT", "2m")
	t.Setenv("ZAKURA_EDITION", "saas")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AutoMigrate || !cfg.MultiTenant || cfg.ReadTimeout.String() != "20s" || cfg.WriteTimeout.String() != "2m0s" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}
