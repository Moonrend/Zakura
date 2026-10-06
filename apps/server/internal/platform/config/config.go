package config

import (
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr   string
	DatabaseURL  string
	DataDir      string
	Secret       string
	PublicURL    string
	WebURL       string
	Edition      string
	MultiTenant  bool
	AutoMigrate  bool
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
}

func Load() (Config, error) {
	multiTenant, err := boolEnv("MULTI_TENANT", false)
	if err != nil {
		return Config{}, err
	}
	autoMigrate, err := boolEnv("AUTO_MIGRATE", true)
	if err != nil {
		return Config{}, err
	}
	readTimeout, err := durationEnv("HTTP_READ_TIMEOUT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	writeTimeout, err := durationEnvAllowZero("HTTP_WRITE_TIMEOUT", 0)
	if err != nil {
		return Config{}, err
	}
	c := Config{
		ListenAddr:   env("LISTEN_ADDR", ":8787"),
		DatabaseURL:  env("DATABASE_URL", "file:./data/zakura.db"),
		DataDir:      env("DATA_DIR", ""),
		Secret:       os.Getenv("ZAKURA_SECRET"),
		PublicURL:    strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:8787"), "/"),
		WebURL:       strings.TrimRight(env("WEB_PUBLIC_URL", "http://localhost:3000"), "/"),
		Edition:      env("ZAKURA_EDITION", "oss"),
		MultiTenant:  multiTenant,
		AutoMigrate:  autoMigrate,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
	}
	if len(c.Secret) < 32 {
		return Config{}, errors.New("ZAKURA_SECRET must contain at least 32 bytes")
	}
	if err := validBaseURL(c.PublicURL); err != nil {
		return Config{}, errors.New("invalid PUBLIC_BASE_URL")
	}
	if err := validBaseURL(c.WebURL); err != nil {
		return Config{}, errors.New("invalid WEB_PUBLIC_URL")
	}
	if c.Edition != "oss" && c.Edition != "saas" {
		return Config{}, errors.New("ZAKURA_EDITION must be oss or saas")
	}
	return c, nil
}

func env(k, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return fallback
}
func boolEnv(k string, fallback bool) (bool, error) {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return false, errors.New(k + " must be true or false")
	}
	return parsed, nil
}
func durationEnv(k string, fallback time.Duration) (time.Duration, error) {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, errors.New(k + " must be a positive duration")
	}
	return d, nil
}
func durationEnvAllowZero(k string, fallback time.Duration) (time.Duration, error) {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return 0, errors.New(k + " must be a non-negative duration")
	}
	return d, nil
}
func validBaseURL(raw string) error {
	u, err := url.ParseRequestURI(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid base URL")
	}
	return nil
}
