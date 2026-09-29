package cache

import (
	"time"
)

type PriceCacheEntry struct {
	Buy  float64
	Sell float64
	Time time.Time
}

type PriceCache interface {
	Get(coin string) (PriceCacheEntry, bool)
	Set(coin string, entry PriceCacheEntry)
	GetAll() map[string]PriceCacheEntry
	Delete(coin string)
}

type CoinMetadataCache interface {
	GetDecimals(coin string) int
	GetTickSize(coin string) float64
	GetMaxLeverage(coin string) int
	SetDecimals(coin string, decimals int)
	SetTickSize(coin string, size float64)
	SetMaxLeverage(coin string, lev int)
}

type LeverageCacheEntry struct {
	Lev  int
	Time time.Time
}

type LeverageCache interface {
	Get(coin string) (LeverageCacheEntry, bool)
	Set(coin string, entry LeverageCacheEntry)
}
