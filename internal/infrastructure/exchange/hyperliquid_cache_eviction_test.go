package exchange

import (
	"testing"
	"time"

	exchangeport "hyperliquid-go/internal/ports/exchange"
)

func TestEvictStaleCachesBoundsAddressScopedFallbacks(t *testing.T) {
	h := NewHyperliquidAdapter()
	old := time.Now().Add(-25 * time.Hour)
	recent := time.Now().Add(-time.Hour)

	h.builderStateCache["old:xyz"] = builderStateEntry{
		state: exchangeport.BuilderDexState{Dex: "xyz"}, time: old,
	}
	h.builderStateCache["recent:xyz"] = builderStateEntry{
		state: exchangeport.BuilderDexState{Dex: "xyz"}, time: recent,
	}
	h.accountModeCache["old"] = accountModeEntry{mode: "standard", time: old}
	h.accountModeCache["recent"] = accountModeEntry{mode: "standard", time: recent}

	h.evictStaleCaches()

	if _, ok := h.builderStateCache["old:xyz"]; ok {
		t.Fatal("expired builder state was retained")
	}
	if _, ok := h.accountModeCache["old"]; ok {
		t.Fatal("expired account mode was retained")
	}
	if _, ok := h.builderStateCache["recent:xyz"]; !ok {
		t.Fatal("recent builder state was evicted")
	}
	if _, ok := h.accountModeCache["recent"]; !ok {
		t.Fatal("recent account mode was evicted")
	}
}

func TestEvictStaleCachesRetainsVerifiedExecutionMetadataForOutages(t *testing.T) {
	h := NewHyperliquidAdapter()
	old := time.Now().Add(-executionMetaRetentionTTL - time.Minute)
	retained := time.Now().Add(-szCacheTTL - time.Minute)

	h.szCache["old"] = szDecimalEntry{value: 5, time: old}
	h.szCache["retained"] = szDecimalEntry{value: 3, time: retained}
	h.standardMetaCache["old"] = xyzMetaEntry{time: old}
	h.standardMetaCache["retained"] = xyzMetaEntry{time: retained}

	h.evictStaleCaches()

	if _, ok := h.szCache["old"]; ok {
		t.Fatal("expired size metadata was retained")
	}
	if _, ok := h.standardMetaCache["old"]; ok {
		t.Fatal("expired standard metadata was retained")
	}
	if _, ok := h.szCache["retained"]; !ok {
		t.Fatal("verified size metadata was evicted at the refresh TTL")
	}
	if _, ok := h.standardMetaCache["retained"]; !ok {
		t.Fatal("verified standard metadata was evicted at the refresh TTL")
	}
}
