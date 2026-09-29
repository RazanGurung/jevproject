package exchange

import (
	"testing"
	"time"
)

func TestCachedAccountModeRetainsExpiredKnownOwnerForRefreshFallback(t *testing.T) {
	h := &HyperliquidAdapter{accountModeCache: map[string]accountModeEntry{
		"0xabc": {mode: "unifiedAccount", source: "webData3", time: time.Now().Add(-accountModeCacheTTL - time.Second)},
	}}
	mode, source, stale := h.getCachedAccountMode("0xAbC")
	if mode != "unifiedAccount" || source != "webData3" || !stale {
		t.Fatalf("cached mode = (%q,%q,%v), want expired known unified mode", mode, source, stale)
	}
	if last, ok := h.getLastKnownAccountMode("0xABC"); !ok || last != "unifiedAccount" {
		t.Fatalf("last known mode = (%q,%v)", last, ok)
	}
}

func TestCachedAccountModeDoesNotTreatExpiredUnknownAsKnown(t *testing.T) {
	h := &HyperliquidAdapter{accountModeCache: map[string]accountModeEntry{
		"0xabc": {mode: "unknown", source: "unavailable", time: time.Now().Add(-accountModeCacheTTL - time.Second)},
	}}
	mode, source, stale := h.getCachedAccountMode("0xabc")
	if mode != "" || source != "" || !stale {
		t.Fatalf("cached unknown = (%q,%q,%v), want empty stale miss", mode, source, stale)
	}
	if last, ok := h.getLastKnownAccountMode("0xabc"); ok || last != "" {
		t.Fatalf("unknown was treated as last-known mode: (%q,%v)", last, ok)
	}
}
