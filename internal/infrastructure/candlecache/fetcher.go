package candlecache

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	"hyperliquid-go/pkg/utils"
)

var fetchRetryDelays = []time.Duration{2 * time.Second, 5 * time.Second, 15 * time.Second}

// NewHTTPFetcher returns the production FetchFunc: a candleSnapshot POST to
// the /info endpoint with the dex attached for builder-dex coins, retrying
// on 429/5xx. onRateLimited, if non-nil, fires on every 429 actually observed
// from Hyperliquid — a live signal (distinct from the retry backoff below,
// which only paces this one call) that the shared weight budget's rate
// assumption is currently too optimistic, so other queued background waiters
// should yield too. May be nil (e.g. the mispricing fallback fetcher used
// only when candle preloading is disabled, which has no budget to correct).
func NewHTTPFetcher(client *http.Client, apiURL string, onRateLimited func()) FetchFunc {
	return func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		req := map[string]interface{}{
			"coin":      coin,
			"interval":  interval,
			"startTime": startMs,
			"endTime":   endMs,
		}
		if dex := utils.GetDexName(coin); dex != "" {
			req["dex"] = dex
		}
		bodyBytes, err := json.Marshal(map[string]interface{}{"type": "candleSnapshot", "req": req})
		if err != nil {
			return nil, err
		}

		var lastErr error
		for attempt := 0; ; attempt++ {
			candles, rateLimited, retryable, err := postCandleSnapshot(ctx, client, apiURL, bodyBytes)
			if err == nil {
				return candles, nil
			}
			if rateLimited && onRateLimited != nil {
				onRateLimited()
			}
			lastErr = err
			if !retryable || attempt >= len(fetchRetryDelays) {
				return nil, lastErr
			}
			select {
			case <-time.After(fetchRetryDelays[attempt]):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
}

func postCandleSnapshot(ctx context.Context, client *http.Client, apiURL string, body []byte) ([]Candle, bool, bool, error) {
	ctx = infogovernor.WithLane(ctx, infogovernor.Background)
	ctx = hlratelimit.WithRTTTimeout(ctx, 25*time.Second)
	release, err := infogovernor.Acquire(ctx, infogovernor.Background)
	if err != nil {
		return nil, false, false, err
	}
	defer release()
	httpReq, err := http.NewRequestWithContext(ctx, "POST", apiURL+"/info", bytes.NewReader(body))
	if err != nil {
		return nil, false, false, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, false, true, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, false, true, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		rateLimited := resp.StatusCode == http.StatusTooManyRequests
		retryable := rateLimited || resp.StatusCode >= 500
		return nil, rateLimited, retryable, fmt.Errorf("candleSnapshot upstream HTTP %d: %s", resp.StatusCode, truncate(string(respBody)))
	}
	var candles []Candle
	if err := json.Unmarshal(respBody, &candles); err != nil {
		return nil, false, false, fmt.Errorf("candleSnapshot decode: %w", err)
	}
	return candles, false, false, nil
}

// FetchLiquidity pulls metaAndAssetCtxs for each dex and returns per-coin
// notional open interest (openInterest × markPx), used to pick which tickers
// deserve a warm candle cache.
type CoinLiquidity struct {
	Coin       string
	OINotional float64
}

func FetchLiquidity(ctx context.Context, client *http.Client, apiURL string, dexes []string) ([]CoinLiquidity, error) {
	var rows []CoinLiquidity
	var lastErr error
	for _, dex := range dexes {
		dexRows, err := fetchDexLiquidity(ctx, client, apiURL, dex)
		if err != nil {
			lastErr = err
			continue
		}
		rows = append(rows, dexRows...)
	}
	if len(rows) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return rows, nil
}

func fetchDexLiquidity(ctx context.Context, client *http.Client, apiURL, dex string) ([]CoinLiquidity, error) {
	ctx = infogovernor.WithLane(ctx, infogovernor.Background)
	ctx = hlratelimit.WithRTTTimeout(ctx, 10*time.Second)
	body := map[string]interface{}{"type": "metaAndAssetCtxs"}
	if dex != "" {
		body["dex"] = dex
	}
	bodyBytes, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", apiURL+"/info", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("metaAndAssetCtxs dex=%q HTTP %d", dex, resp.StatusCode)
	}

	var payload []json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil || len(payload) < 2 {
		return nil, fmt.Errorf("metaAndAssetCtxs dex=%q: malformed response", dex)
	}
	var meta struct {
		Universe []struct {
			Name       string `json:"name"`
			IsDelisted bool   `json:"isDelisted"`
		} `json:"universe"`
	}
	var ctxs []struct {
		OpenInterest string `json:"openInterest"`
		MarkPx       string `json:"markPx"`
	}
	if err := json.Unmarshal(payload[0], &meta); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(payload[1], &ctxs); err != nil {
		return nil, err
	}

	rows := make([]CoinLiquidity, 0, len(meta.Universe))
	for i, u := range meta.Universe {
		if i >= len(ctxs) || u.Name == "" || u.IsDelisted {
			continue
		}
		oi := parseFloatDefault(ctxs[i].OpenInterest) * parseFloatDefault(ctxs[i].MarkPx)
		name := u.Name
		// Per-dex universes may return bare symbols; re-attach the dex prefix
		// so names match the dex-qualified keys used everywhere else.
		if dex != "" && !strings.Contains(name, ":") {
			name = dex + ":" + name
		}
		rows = append(rows, CoinLiquidity{Coin: name, OINotional: oi})
	}
	return rows, nil
}

func parseFloatDefault(s string) float64 {
	return numericToFloat64(s)
}

func truncate(s string) string {
	if len(s) <= 160 {
		return s
	}
	return s[:160] + "..."
}
