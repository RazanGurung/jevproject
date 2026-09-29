package cache

import (
	"testing"
	"time"

	portcache "hyperliquid-go/internal/ports/cache"
)

func TestMemoryPriceCacheSetGetDelete(t *testing.T) {
	c := NewMemoryPriceCache(time.Minute)

	if _, ok := c.Get("BTC"); ok {
		t.Fatal("Get on empty cache reported ok=true")
	}

	c.Set("BTC", portcache.PriceCacheEntry{Buy: 100, Sell: 99, Time: time.Now()})
	entry, ok := c.Get("BTC")
	if !ok || entry.Buy != 100 || entry.Sell != 99 {
		t.Fatalf("Get = (%+v, %v), want buy=100 sell=99 ok=true", entry, ok)
	}

	c.Delete("BTC")
	if _, ok := c.Get("BTC"); ok {
		t.Fatal("Get after Delete reported ok=true")
	}
}

func TestMemoryPriceCacheGetAllReturnsCopy(t *testing.T) {
	c := NewMemoryPriceCache(time.Minute)
	c.Set("BTC", portcache.PriceCacheEntry{Buy: 1, Time: time.Now()})

	all := c.GetAll()
	all["BTC"] = portcache.PriceCacheEntry{Buy: 999}
	all["ETH"] = portcache.PriceCacheEntry{Buy: 2}

	// Mutating the returned map must not corrupt the cache's internal state.
	entry, _ := c.Get("BTC")
	if entry.Buy != 1 {
		t.Fatalf("internal entry mutated via GetAll: buy=%v, want 1", entry.Buy)
	}
	if _, ok := c.Get("ETH"); ok {
		t.Fatal("GetAll leaked a writable reference to the internal map")
	}
}

func TestMemoryPriceCacheIsExpired(t *testing.T) {
	c := NewMemoryPriceCache(50 * time.Millisecond)

	// Missing key is treated as expired.
	if !c.IsExpired("BTC") {
		t.Fatal("IsExpired on missing key = false, want true")
	}

	c.Set("BTC", portcache.PriceCacheEntry{Time: time.Now()})
	if c.IsExpired("BTC") {
		t.Fatal("fresh entry reported expired")
	}

	c.Set("ETH", portcache.PriceCacheEntry{Time: time.Now().Add(-time.Hour)})
	if !c.IsExpired("ETH") {
		t.Fatal("stale entry reported not expired")
	}
}

func TestMemoryMetadataCache(t *testing.T) {
	c := NewMemoryMetadataCache()

	// Unset values return zero, not a panic.
	if c.GetDecimals("BTC") != 0 || c.GetTickSize("BTC") != 0 || c.GetMaxLeverage("BTC") != 0 {
		t.Fatal("unset metadata did not default to zero")
	}

	c.SetDecimals("BTC", 5)
	c.SetTickSize("BTC", 0.5)
	c.SetMaxLeverage("BTC", 40)

	if c.GetDecimals("BTC") != 5 {
		t.Fatalf("decimals = %d, want 5", c.GetDecimals("BTC"))
	}
	if c.GetTickSize("BTC") != 0.5 {
		t.Fatalf("tickSize = %v, want 0.5", c.GetTickSize("BTC"))
	}
	if c.GetMaxLeverage("BTC") != 40 {
		t.Fatalf("maxLeverage = %d, want 40", c.GetMaxLeverage("BTC"))
	}

	dec := c.GetAllDecimals()
	dec["BTC"] = 99
	if c.GetDecimals("BTC") != 5 {
		t.Fatal("GetAllDecimals leaked a writable reference to internal state")
	}
}

func TestMemoryLeverageCacheExpiry(t *testing.T) {
	c := NewMemoryLeverageCache(50 * time.Millisecond)

	if _, ok := c.Get("BTC"); ok {
		t.Fatal("Get on empty leverage cache reported ok=true")
	}

	c.Set("BTC", portcache.LeverageCacheEntry{Lev: 20, Time: time.Now()})
	if entry, ok := c.Get("BTC"); !ok || entry.Lev != 20 {
		t.Fatalf("fresh Get = (%+v, %v), want lev=20 ok=true", entry, ok)
	}

	// An entry older than the TTL is reported as a miss.
	c.Set("ETH", portcache.LeverageCacheEntry{Lev: 10, Time: time.Now().Add(-time.Hour)})
	if _, ok := c.Get("ETH"); ok {
		t.Fatal("stale leverage entry reported ok=true")
	}
}
