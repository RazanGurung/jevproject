package config

import (
	"reflect"
	"testing"
)

// clearEnv blanks every variable Load consults so a default-case test is not
// polluted by the developer's shell. t.Setenv forbids parallel execution.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PORT", "PEZ_BIND_ADDR", "PEZ_SERVE_WEB", "PEZ_ALLOWED_ORIGINS", "PEZ_WEB_API_BASE_URL",
		"PEZ_BOT_STATE_FILE", "PEZ_X_NEWS_MIRROR_BASE", "PEZ_X_NEWS_ACCOUNTS", "PEZ_API_TOKEN",
		"PEZ_NEWS_EXTRA_RSS_FEEDS", "PEZ_BSKY_NEWS_ACCOUNTS",
	} {
		t.Setenv(key, "")
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	cfg := Load()

	if cfg.Port != "5000" {
		t.Fatalf("Port = %q, want 5000", cfg.Port)
	}
	if cfg.BindAddress != "127.0.0.1" {
		t.Fatalf("BindAddress = %q, want 127.0.0.1", cfg.BindAddress)
	}
	if !cfg.ServeWeb {
		t.Fatal("ServeWeb default = false, want true")
	}
	if cfg.BotStateFile != "data/bot-state.json" {
		t.Fatalf("BotStateFile = %q, want data/bot-state.json", cfg.BotStateFile)
	}
	if cfg.AllowedOrigins != nil {
		t.Fatalf("AllowedOrigins = %v, want nil", cfg.AllowedOrigins)
	}
	if cfg.APIToken != "" {
		t.Fatalf("APIToken = %q, want empty", cfg.APIToken)
	}
	if cfg.MainnetURL == "" || cfg.TestnetURL == "" {
		t.Fatal("Mainnet/Testnet URLs must be populated")
	}
}

func TestLoadFromEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv("PORT", "8080")
	t.Setenv("PEZ_BIND_ADDR", "0.0.0.0")
	t.Setenv("PEZ_SERVE_WEB", "false")
	t.Setenv("PEZ_ALLOWED_ORIGINS", "a.com, b.com ,,c.com")
	t.Setenv("PEZ_API_TOKEN", "  secret  ")
	t.Setenv("PEZ_NEWS_EXTRA_RSS_FEEDS", "https://one.example/rss, https://two.example/atom")
	t.Setenv("PEZ_BSKY_NEWS_ACCOUNTS", "news.example, markets.example")

	cfg := Load()

	if cfg.Port != "8080" {
		t.Fatalf("Port = %q, want 8080", cfg.Port)
	}
	if cfg.BindAddress != "0.0.0.0" {
		t.Fatalf("BindAddress = %q, want 0.0.0.0", cfg.BindAddress)
	}
	if cfg.ServeWeb {
		t.Fatal("ServeWeb = true, want false")
	}
	want := []string{"a.com", "b.com", "c.com"}
	if !reflect.DeepEqual(cfg.AllowedOrigins, want) {
		t.Fatalf("AllowedOrigins = %v, want %v", cfg.AllowedOrigins, want)
	}
	if cfg.APIToken != "secret" {
		t.Fatalf("APIToken = %q, want trimmed \"secret\"", cfg.APIToken)
	}
	if want := []string{"https://one.example/rss", "https://two.example/atom"}; !reflect.DeepEqual(cfg.NewsExtraRSSFeeds, want) {
		t.Fatalf("NewsExtraRSSFeeds = %v, want %v", cfg.NewsExtraRSSFeeds, want)
	}
	if want := []string{"news.example", "markets.example"}; !reflect.DeepEqual(cfg.BskyNewsAccounts, want) {
		t.Fatalf("BskyNewsAccounts = %v, want %v", cfg.BskyNewsAccounts, want)
	}
}

func TestGetEnvBool(t *testing.T) {
	cases := map[string]bool{
		"1": true, "true": true, "TRUE": true, "yes": true, "on": true, "ON": true,
		"0": false, "false": false, "FALSE": false, "no": false, "off": false,
	}
	for value, want := range cases {
		t.Setenv("PEZ_TEST_BOOL", value)
		if got := getEnvBool("PEZ_TEST_BOOL", !want); got != want {
			t.Fatalf("getEnvBool(%q) = %v, want %v", value, got, want)
		}
	}

	// Unrecognized and empty values fall back to the default.
	t.Setenv("PEZ_TEST_BOOL", "garbage")
	if !getEnvBool("PEZ_TEST_BOOL", true) {
		t.Fatal("garbage value did not fall back to default true")
	}
	t.Setenv("PEZ_TEST_BOOL", "")
	if getEnvBool("PEZ_TEST_BOOL", false) {
		t.Fatal("empty value did not fall back to default false")
	}
}

func TestGetEnvCSV(t *testing.T) {
	t.Setenv("PEZ_TEST_CSV", "a, b ,,c ,")
	want := []string{"a", "b", "c"}
	if got := getEnvCSV("PEZ_TEST_CSV"); !reflect.DeepEqual(got, want) {
		t.Fatalf("getEnvCSV = %v, want %v", got, want)
	}

	t.Setenv("PEZ_TEST_CSV", "   ")
	if got := getEnvCSV("PEZ_TEST_CSV"); got != nil {
		t.Fatalf("getEnvCSV(whitespace) = %v, want nil", got)
	}
}

func TestValidateExposure(t *testing.T) {
	for _, addr := range []string{"127.0.0.1", "::1", "localhost"} {
		cfg := &Config{BindAddress: addr}
		if err := cfg.ValidateExposure(); err != nil {
			t.Fatalf("loopback bind %q rejected: %v", addr, err)
		}
	}
	if err := (&Config{BindAddress: "0.0.0.0"}).ValidateExposure(); err == nil {
		t.Fatal("non-loopback bind without token was accepted")
	}
	if err := (&Config{BindAddress: "0.0.0.0", APIToken: "secret"}).ValidateExposure(); err != nil {
		t.Fatalf("tokenized non-loopback bind rejected: %v", err)
	}
}
