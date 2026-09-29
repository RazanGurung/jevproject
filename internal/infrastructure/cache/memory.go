package cache

import (
	"sort"
	"sync"
	"time"

	"hyperliquid-go/internal/ports/cache"
)

type MemoryPriceCache struct {
	data map[string]cache.PriceCacheEntry
	mu   sync.RWMutex
	ttl  time.Duration
}

func NewMemoryPriceCache(ttl time.Duration) *MemoryPriceCache {
	return &MemoryPriceCache{
		data: make(map[string]cache.PriceCacheEntry),
		ttl:  ttl,
	}
}

func (m *MemoryPriceCache) Get(coin string) (cache.PriceCacheEntry, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.data[coin]
	return entry, ok
}

func (m *MemoryPriceCache) Set(coin string, entry cache.PriceCacheEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[coin] = entry
}

func (m *MemoryPriceCache) GetAll() map[string]cache.PriceCacheEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make(map[string]cache.PriceCacheEntry, len(m.data))
	for k, v := range m.data {
		result[k] = v
	}
	return result
}

func (m *MemoryPriceCache) Delete(coin string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, coin)
}

func (m *MemoryPriceCache) IsExpired(coin string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if entry, ok := m.data[coin]; ok {
		return time.Since(entry.Time) > m.ttl
	}
	return true
}

type MemoryMetadataCache struct {
	decimals    map[string]int
	tickSize    map[string]float64
	maxLeverage map[string]int
	mu          sync.RWMutex
}

func NewMemoryMetadataCache() *MemoryMetadataCache {
	return &MemoryMetadataCache{
		decimals:    make(map[string]int),
		tickSize:    make(map[string]float64),
		maxLeverage: make(map[string]int),
	}
}

func (m *MemoryMetadataCache) GetDecimals(coin string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.decimals[coin]
}

// Has reports whether coin is in the loaded perp universe (its metadata was
// preloaded). Cheap O(1) membership for validating untrusted coin input.
func (m *MemoryMetadataCache) Has(coin string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.decimals[coin]
	return ok
}

// Coins returns the loaded perp universe in deterministic order. Startup chart
// hydration consumes this exact set, keeping backend readiness aligned with
// the markets accepted by preload-hint and exposed by metadata-backed UI paths.
func (m *MemoryMetadataCache) Coins() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	coins := make([]string, 0, len(m.decimals))
	for coin := range m.decimals {
		coins = append(coins, coin)
	}
	sort.Strings(coins)
	return coins
}

func (m *MemoryMetadataCache) GetTickSize(coin string) float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tickSize[coin]
}

func (m *MemoryMetadataCache) GetMaxLeverage(coin string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.maxLeverage[coin]
}

func (m *MemoryMetadataCache) SetDecimals(coin string, decimals int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.decimals[coin] = decimals
}

func (m *MemoryMetadataCache) SetTickSize(coin string, size float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tickSize[coin] = size
}

func (m *MemoryMetadataCache) SetMaxLeverage(coin string, lev int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.maxLeverage[coin] = lev
}

// GetAllDecimals returns all cached decimals.
func (m *MemoryMetadataCache) GetAllDecimals() map[string]int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make(map[string]int, len(m.decimals))
	for k, v := range m.decimals {
		result[k] = v
	}
	return result
}

// GetAllTickSizes returns all cached tick sizes.
func (m *MemoryMetadataCache) GetAllTickSizes() map[string]float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make(map[string]float64, len(m.tickSize))
	for k, v := range m.tickSize {
		result[k] = v
	}
	return result
}

// GetAllMaxLeverages returns all cached max leverages.
func (m *MemoryMetadataCache) GetAllMaxLeverages() map[string]int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make(map[string]int, len(m.maxLeverage))
	for k, v := range m.maxLeverage {
		result[k] = v
	}
	return result
}

type MemoryLeverageCache struct {
	data map[string]cache.LeverageCacheEntry
	mu   sync.RWMutex
	ttl  time.Duration
}

func NewMemoryLeverageCache(ttl time.Duration) *MemoryLeverageCache {
	return &MemoryLeverageCache{
		data: make(map[string]cache.LeverageCacheEntry),
		ttl:  ttl,
	}
}

func (m *MemoryLeverageCache) Get(coin string) (cache.LeverageCacheEntry, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.data[coin]
	if ok && time.Since(entry.Time) > m.ttl {
		return entry, false
	}
	return entry, ok
}

func (m *MemoryLeverageCache) Set(coin string, entry cache.LeverageCacheEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[coin] = entry
}
