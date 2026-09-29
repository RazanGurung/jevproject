package keycache

import (
	"os"
	"path/filepath"
	"testing"
)

// A valid 64-hex-char private key body (no 0x prefix).
const key64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// isolate clears cached state and points the working directory at a temp dir so
// the file-based fallback can't pick up a stray hyperliquid_key.txt, and clears
// both env vars the fallback consults. These tests must not run in parallel:
// keycache uses package-global state.
func isolate(t *testing.T) {
	t.Helper()
	Clear()
	t.Cleanup(Clear)
	t.Chdir(t.TempDir())
	t.Setenv("PEZ_PRIVATE_KEY", "")
	t.Setenv("PRIVATE_KEY", "")
}

func TestCacheAndGetRoundTrip(t *testing.T) {
	isolate(t)
	Cache(key64)
	if got := Get(); got != key64 {
		t.Fatalf("Get() = %q, want %q", got, key64)
	}
}

func TestCacheStrips0xPrefix(t *testing.T) {
	isolate(t)
	Cache("0x" + key64)
	if got := Get(); got != key64 {
		t.Fatalf("Get() = %q, want normalized %q", got, key64)
	}
}

func TestCacheRejectsShortKey(t *testing.T) {
	isolate(t)
	Cache("tooshort")
	if got := Get(); got != "" {
		t.Fatalf("expected short key to be rejected, Get() = %q", got)
	}
}

func TestClearEmptiesCache(t *testing.T) {
	isolate(t)
	Cache(key64)
	Clear()
	if got := Get(); got != "" {
		t.Fatalf("after Clear, Get() = %q, want empty", got)
	}
}

func TestGetWithFallbackPrefersCacheOverEnv(t *testing.T) {
	isolate(t)
	envKey := "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	t.Setenv("PEZ_PRIVATE_KEY", envKey)
	Cache(key64)
	if got := GetWithFallback(); got != key64 {
		t.Fatalf("GetWithFallback() = %q, want cached %q", got, key64)
	}
}

func TestGetWithFallbackReadsPezEnv(t *testing.T) {
	isolate(t)
	t.Setenv("PEZ_PRIVATE_KEY", key64)
	if got := GetWithFallback(); got != key64 {
		t.Fatalf("GetWithFallback() = %q, want env %q", got, key64)
	}
}

func TestGetWithFallbackPrefersPezEnvOverLegacyEnv(t *testing.T) {
	isolate(t)
	legacy := "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	t.Setenv("PEZ_PRIVATE_KEY", key64)
	t.Setenv("PRIVATE_KEY", legacy)
	if got := GetWithFallback(); got != key64 {
		t.Fatalf("GetWithFallback() = %q, want PEZ_PRIVATE_KEY %q", got, key64)
	}
}

func TestGetWithFallbackReadsLegacyEnvWhenPezAbsent(t *testing.T) {
	isolate(t)
	t.Setenv("PRIVATE_KEY", key64)
	if got := GetWithFallback(); got != key64 {
		t.Fatalf("GetWithFallback() = %q, want legacy env %q", got, key64)
	}
}

func TestGetWithFallbackReadsFileWhenEnvAbsent(t *testing.T) {
	isolate(t)
	// isolate() already chdir'd into a temp dir; write the key file there.
	if err := os.WriteFile(filepath.Join("hyperliquid_key.txt"), []byte(key64), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	if got := GetWithFallback(); got != key64 {
		t.Fatalf("GetWithFallback() = %q, want file contents %q", got, key64)
	}
}

func TestGetWithFallbackReturnsEmptyWhenNothingAvailable(t *testing.T) {
	isolate(t)
	if got := GetWithFallback(); got != "" {
		t.Fatalf("GetWithFallback() = %q, want empty when no source available", got)
	}
}

func TestGetECDSAAndFallback(t *testing.T) {
	isolate(t)
	if got := GetECDSA(); got != nil {
		t.Fatalf("GetECDSA() before cache = %v, want nil", got)
	}
	Cache(key64)
	ecdsaKey := GetECDSA()
	if ecdsaKey == nil {
		t.Fatalf("GetECDSA() after cache = nil, want valid key")
	}

	Clear()
	if got := GetECDSA(); got != nil {
		t.Fatalf("GetECDSA() after Clear = %v, want nil", got)
	}

	t.Setenv("PEZ_PRIVATE_KEY", key64)
	fallbackKey := GetWithFallbackECDSA()
	if fallbackKey == nil {
		t.Fatalf("GetWithFallbackECDSA() = nil, want valid key from env")
	}
}

