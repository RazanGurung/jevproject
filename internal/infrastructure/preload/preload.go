package preload

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	portcache "hyperliquid-go/internal/ports/cache"
)

// PreloadConfig holds configuration for preloading services.
type PreloadConfig struct {
	Context      context.Context
	TrackedCoins map[string]bool
	HTTPClient   *http.Client
	APIURL       string
	Metadata     portcache.CoinMetadataCache
	Prices       portcache.PriceCache
}

// PreloadService handles startup data preloading.
type PreloadService struct {
	cfg PreloadConfig
}

// NewPreloadService creates a new PreloadService.
func NewPreloadService(cfg PreloadConfig) *PreloadService {
	if cfg.Context == nil {
		cfg.Context = context.Background()
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 10 * time.Second, Transport: hlratelimit.WrapTransport(nil)}
	}
	if cfg.APIURL == "" {
		cfg.APIURL = "https://api.hyperliquid.xyz"
	}
	return &PreloadService{cfg: cfg}
}

// LoadCoinDecimals loads szDecimals, maxLeverage, and tickSize from the API.
func (p *PreloadService) LoadCoinDecimals() {
	p.loadMetaUniverse("")

	dexes, err := p.fetchPerpDexs()
	if err != nil {
		log.Printf("preload: failed to load perp dex list: %v", err)
	}
	for _, dex := range dexes {
		p.loadMetaUniverse(dex)
	}

	log.Printf("preload: loaded coin metadata across %d dexes", len(dexes)+1)
}

// PreloadAllPrices fetches and caches current market prices.
func (p *PreloadService) PreloadAllPrices() {
	ctx, cancel := context.WithTimeout(p.cfg.Context, 10*time.Second)
	defer cancel()
	ctx = infogovernor.WithLane(ctx, infogovernor.Background)

	req, _ := http.NewRequestWithContext(ctx, "POST", p.cfg.APIURL+"/info",
		bytes.NewBuffer([]byte(`{"type":"metaAndAssetCtxs"}`)))
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		log.Printf("preload: failed to load prices: %v", err)
		return
	}
	defer resp.Body.Close()

	var data []interface{}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil || len(data) < 2 {
		return
	}

	meta, ok := data[0].(map[string]interface{})
	if !ok {
		return
	}

	universe, ok := meta["universe"].([]interface{})
	if !ok {
		return
	}

	assetCtxs, ok := data[1].([]interface{})
	if !ok {
		return
	}

	for i, u := range universe {
		item, ok := u.(map[string]interface{})
		if !ok {
			continue
		}
		name, ok := item["name"].(string)
		if !ok {
			continue
		}
		if i >= len(assetCtxs) {
			continue
		}
		ctx, ok := assetCtxs[i].(map[string]interface{})
		if !ok {
			continue
		}

		var markPx float64
		if p, ok := ctx["markPx"].(float64); ok {
			markPx = p
		} else if pStr, ok := ctx["markPx"].(string); ok {
			markPx, _ = strconv.ParseFloat(pStr, 64)
		}

		if markPx > 0 {
			if p.cfg.Prices != nil {
				p.cfg.Prices.Set(name, portcache.PriceCacheEntry{
					Buy:  markPx,
					Sell: markPx,
					Time: time.Now(),
				})
			}
		}
	}
}

func (p *PreloadService) loadMetaUniverse(dex string) {
	body := map[string]interface{}{"type": "meta"}
	if dex != "" {
		body["dex"] = dex
	}

	bodyBytes, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(p.cfg.Context, 10*time.Second)
	defer cancel()
	ctx = infogovernor.WithLane(ctx, infogovernor.Background)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.APIURL+"/info", bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		log.Printf("preload: failed to load meta for dex %q: %v", dex, err)
		return
	}
	defer resp.Body.Close()

	var metaRaw map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&metaRaw); err != nil {
		log.Printf("preload: failed to decode meta for dex %q: %v", dex, err)
		return
	}

	universe, ok := metaRaw["universe"].([]interface{})
	if !ok || p.cfg.Metadata == nil {
		return
	}

	for _, u := range universe {
		uMap, ok := u.(map[string]interface{})
		if !ok {
			continue
		}
		name, ok := uMap["name"].(string)
		if !ok || !p.shouldTrack(name) {
			continue
		}

		// Store metadata under the canonical, dex-qualified key. Hyperliquid's
		// per-dex `meta.universe` may return bare or already-qualified symbols.
		// Without normalizing exactly once, the cache either loses venue identity
		// or creates invalid keys such as "xyz:xyz:NVDA". Without a "<dex>:"
		// prefix the cache can't distinguish a synthetic (xyz:GOLD)
		// from a native perp, which is exactly the signal the UI uses to split
		// Crypto from Stocks/Indices/Commodities/FX (and what tick-size and
		// leverage lookups key on). The default perp dex (dex == "") keeps bare
		// crypto symbols.
		key := name
		if dex != "" && !strings.HasPrefix(strings.ToLower(name), strings.ToLower(dex)+":") {
			key = dex + ":" + name
		}

		if szDec, ok := parseNumber(uMap["szDecimals"]); ok {
			p.cfg.Metadata.SetDecimals(key, szDec)
		}
		if maxLev, ok := parseNumber(uMap["maxLeverage"]); ok {
			p.cfg.Metadata.SetMaxLeverage(key, maxLev)
		}
		if tickSz, ok := parseFloat(uMap["tickSize"]); ok {
			p.cfg.Metadata.SetTickSize(key, tickSz)
		}
	}
}

func (p *PreloadService) fetchPerpDexs() ([]string, error) {
	ctx, cancel := context.WithTimeout(p.cfg.Context, 10*time.Second)
	defer cancel()
	ctx = infogovernor.WithLane(ctx, infogovernor.Background)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.APIURL+"/info", bytes.NewBuffer([]byte(`{"type":"perpDexs"}`)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var raw []map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	// Only xyz HIP-3 markets are preloaded. Other builder/HIP-3 dexs (para,
	// vntl, mkts, …) must not enter the metadata cache or coin-meta API.
	dexes := make([]string, 0, 1)
	for _, item := range raw {
		name, ok := item["name"].(string)
		if !ok {
			continue
		}
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "xyz" {
			dexes = append(dexes, name)
			break
		}
	}
	return dexes, nil
}

func (p *PreloadService) shouldTrack(name string) bool {
	if len(p.cfg.TrackedCoins) == 0 {
		return true
	}
	return p.cfg.TrackedCoins[name]
}

func parseNumber(v interface{}) (int, bool) {
	switch value := v.(type) {
	case float64:
		return int(value), true
	case int:
		return value, true
	case string:
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0, false
		}
		return int(f), true
	default:
		return 0, false
	}
}

func parseFloat(v interface{}) (float64, bool) {
	switch value := v.(type) {
	case float64:
		return value, true
	case float32:
		return float64(value), true
	case int:
		return float64(value), true
	case string:
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}
