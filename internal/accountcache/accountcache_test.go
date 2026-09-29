package accountcache

import (
	"os"
	"strings"
	"testing"
)

// isolate resets the package-global cache and isolates the env/file fallback
// sources. These tests must not run in parallel: the cache is global state.
func isolate(t *testing.T) {
	t.Helper()
	Clear()
	t.Cleanup(Clear)
	t.Chdir(t.TempDir())
	t.Setenv("PEZ_ACCOUNT_ADDRESS", "")
	t.Setenv("ACCOUNT_ADDRESS", "")
}

func validAddr() (mixed, lower string) {
	mixed = "0x" + strings.Repeat("Ab", 20) // 42 chars, mixed case
	lower = "0x" + strings.Repeat("ab", 20)
	return
}

func TestCacheNormalizesToLowercase(t *testing.T) {
	isolate(t)
	mixed, lower := validAddr()
	Cache(mixed)
	if got := Get(); got != lower {
		t.Fatalf("Get() = %q, want lowercased %q", got, lower)
	}
}

func TestCacheRejectsInvalidAddress(t *testing.T) {
	isolate(t)
	// Wrong length, missing prefix, and uppercase 0X are all invalid → cleared.
	for _, bad := range []string{"not-an-address", "0x123", strings.Repeat("a", 42), "0X" + strings.Repeat("a", 40)} {
		Clear()
		Cache(bad)
		if got := Get(); got != "" {
			t.Fatalf("Cache(%q) stored %q, want empty", bad, got)
		}
	}
}

func TestClearEmptiesCache(t *testing.T) {
	isolate(t)
	mixed, _ := validAddr()
	Cache(mixed)
	Clear()
	if got := Get(); got != "" {
		t.Fatalf("after Clear, Get() = %q, want empty", got)
	}
}

func TestGetWithFallbackPrefersCacheOverEnv(t *testing.T) {
	isolate(t)
	mixed, lower := validAddr()
	t.Setenv("PEZ_ACCOUNT_ADDRESS", "0x"+strings.Repeat("cd", 20))
	Cache(mixed)
	if got := GetWithFallback(); got != lower {
		t.Fatalf("GetWithFallback() = %q, want cached %q", got, lower)
	}
}

func TestGetWithFallbackReadsPezEnv(t *testing.T) {
	isolate(t)
	_, lower := validAddr()
	t.Setenv("PEZ_ACCOUNT_ADDRESS", lower)
	if got := GetWithFallback(); got != lower {
		t.Fatalf("GetWithFallback() = %q, want env %q", got, lower)
	}
}

func TestGetWithFallbackPrefersPezOverLegacyEnv(t *testing.T) {
	isolate(t)
	_, lower := validAddr()
	t.Setenv("PEZ_ACCOUNT_ADDRESS", lower)
	t.Setenv("ACCOUNT_ADDRESS", "0x"+strings.Repeat("cd", 20))
	if got := GetWithFallback(); got != lower {
		t.Fatalf("GetWithFallback() = %q, want PEZ_ACCOUNT_ADDRESS %q", got, lower)
	}
}

func TestGetWithFallbackReadsFileAndTrimsWhitespace(t *testing.T) {
	isolate(t)
	_, lower := validAddr()
	// Trailing newline must be tolerated (normalizeAddress trims it).
	if err := os.WriteFile("hyperliquid_account.txt", []byte(lower+"\n"), 0600); err != nil {
		t.Fatalf("write account file: %v", err)
	}
	if got := GetWithFallback(); got != lower {
		t.Fatalf("GetWithFallback() = %q, want file contents %q", got, lower)
	}
}

func TestGetWithFallbackReturnsEmptyWhenNothingAvailable(t *testing.T) {
	isolate(t)
	if got := GetWithFallback(); got != "" {
		t.Fatalf("GetWithFallback() = %q, want empty", got)
	}
}
