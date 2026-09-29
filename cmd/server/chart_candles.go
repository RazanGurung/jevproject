package main

// Chart candle serve lanes: interactive passthrough, hydrate, bound chart-candle handler.

import (

	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"hyperliquid-go/internal/infrastructure/exchange"
	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	"github.com/gin-gonic/gin"
)


// candlePassthroughSem bounds concurrent interactive candleSnapshot
// passthroughs to Hyperliquid. Client-side concurrency gates (the frontend's
// own background-fetch cap and scanner batching) each cap
// their own source independently and don't coordinate with each other or with
// candlecache's fetchSem/weight budget (background *store* paths only, by
// design — interactive must never be delayed by them) — so an ordinary click
// plus its own adjacent-timeframe prefetches and concurrent scanners can
// still stack into enough simultaneous real HTTP calls to trip Hyperliquid's
// burst limit even though no single source is misbehaving. Sized well above
// fetchSem's hard 1 (background) so the common single-click case is never
// queued; only a genuine pile-up waits, and briefly (each upstream call is
// ~150-600ms).
var candlePassthroughSem = make(chan struct{}, 4)

// chartPrefetchSem is intentionally separate from the visible chart lane.
// Adjacent-timeframe and scanner preparation can make progress, but can never
// occupy one of the four slots reserved for a chart the user is viewing.
var chartPrefetchSem = make(chan struct{}, 1)

// jevCandleSem isolates Jev System One trade signal and pre-trade audit candle reads
// onto their own priority lane so discretionary signals never queue behind background
// prefetch sweeps or multi-minute warm coordinator passes.
var jevCandleSem = make(chan struct{}, 2)

// 499 is the conventional server-side classification for a client that closed
// an in-flight request. Go's net/http has no named constant for it, but keeping
// it distinct prevents intentional chart-switch aborts from polluting 5xx
// upstream-failure metrics.
const statusClientClosedRequest = 499

func canceledRequestStatus(err error) int {
	if err == context.Canceled {
		return statusClientClosedRequest
	}
	return http.StatusGatewayTimeout
}

// acquireCandlePassthroughSlot blocks until sem has a free slot or ctx is
// done, whichever comes first — so a superseded/aborted request (whose
// context is already canceled) gives up immediately instead of sitting in the
// queue behind traffic it no longer needs. Shared by candleSnapshot
// passthrough lanes and parameterized by their semaphore.
func acquireCandlePassthroughSlot(ctx context.Context, sem chan struct{}) bool {
	select {
	case sem <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func releaseCandlePassthroughSlot(sem chan struct{}) {
	<-sem
}

// passthroughCandleSnapshot serves a candleSnapshot body from the in-memory
// store when covered, else fetches it from Hyperliquid on the given
// semaphore-bounded lane — charging/penalizing the shared weight budget and
// folding the result back into the store exactly the same way regardless of
// caller.
//
// Return shape: servedFromStore=true means respBody is a free memory-store
// hit (ignore the rest). canceled=true means the request was aborted via ctx
// (499 for client cancellation, 504 for a deadline). Otherwise a non-nil err
// with status>0 is an upstream HTTP failure (upstreamBody carries the truncated raw
// response); status==0 covers request-setup/network/malformed-response
// errors, none of which have a meaningful upstream status to report.
func passthroughCandleSnapshot(ctx context.Context, apiURL string, sem chan struct{}, body map[string]interface{}) (respBody []byte, servedFromStore, canceled bool, status int, upstreamBody string, err error) {
	if runtime.candleStore != nil {
		if served, ok := runtime.candleStore.ServeInfoRequest(body); ok {
			candleServeTotal.WithLabelValues("store").Inc()
			return served, true, false, 0, "", nil
		}
		// Charge this passthrough against the shared candle budget (non-blocking)
		// so the background preloader/on-demand warms yield the per-IP allowance
		// to it instead of competing and tripping HL's limit.
		runtime.candleStore.ChargePassthrough(body)
	}

	bodyBytes, merr := json.Marshal(body)
	if merr != nil {
		return nil, false, false, 0, "", merr
	}
	lane := infogovernor.Background
	if sem == candlePassthroughSem {
		lane = infogovernor.VisibleChart
	} else if sem == jevCandleSem {
		lane = infogovernor.Enrichment
	}
	ctx = infogovernor.WithLane(ctx, lane)
	ctx = hlratelimit.WithRTTTimeout(ctx, 25*time.Second)
	req, rerr := http.NewRequestWithContext(ctx, "POST", apiURL+"/info", bytes.NewBuffer(bodyBytes))
	if rerr != nil {
		return nil, false, false, 0, "", rerr
	}
	req.Header.Set("Content-Type", "application/json")

	if !acquireCandlePassthroughSlot(ctx, sem) {
		return nil, false, true, canceledRequestStatus(ctx.Err()), "", ctx.Err()
	}
	defer releaseCandlePassthroughSlot(sem)

	releaseLane, laneErr := infogovernor.Acquire(ctx, lane)
	if laneErr != nil {
		return nil, false, true, canceledRequestStatus(ctx.Err()), "", laneErr
	}
	defer releaseLane()

	// Candle history uses the longer-timeout client; metadata/proxy paths keep
	// the short general client so one slow chart cannot monopolize short probes.
	resp, derr := candleHTTPClient.Do(req)
	if derr != nil {
		if ctx.Err() != nil {
			return nil, false, true, canceledRequestStatus(ctx.Err()), "", ctx.Err()
		}
		// Self-heal after a hard timeout the same way as an upstream 5xx: kick
		// background warm so the browser's retry can hit the store.
		warmSeriesFromBody(body)
		candleServeTotal.WithLabelValues("passthrough_error").Inc()
		return nil, false, false, 0, "", derr
	}
	defer resp.Body.Close()

	respBytes, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		warmSeriesFromBody(body)
		candleServeTotal.WithLabelValues("passthrough_error").Inc()
		return nil, false, false, 0, "", fmt.Errorf("upstream body: %w", readErr)
	}
	trimmed := strings.TrimSpace(string(respBytes))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusTooManyRequests {
			// Surface HL rate-limiting (otherwise masked as a 502 to the client):
			// throttled so a burst doesn't flood the log.
			logUpstreamRateLimit("candleSnapshot")
			// Live correction: this is ground truth that the real per-IP allowance
			// is tighter than the budget's static perMin assumes right now, so make
			// background traffic yield extra room immediately instead of only
			// pacing off the configured average rate.
			if runtime.candleStore != nil {
				runtime.candleStore.PenalizeRateLimit()
			}
		}
		// Self-heal: even though this passthrough failed, start warming the series
		// in the background (budget-paced, so it waits out a 429 storm) so the
		// client's retry serves from the store instead of hitting the same wall.
		warmSeriesFromBody(body)
		candleServeTotal.WithLabelValues("passthrough_error").Inc()
		return nil, false, false, resp.StatusCode, truncateForLog(trimmed), fmt.Errorf("/info upstream HTTP %d", resp.StatusCode)
	}
	if trimmed == "" {
		return nil, false, false, 0, "", fmt.Errorf("empty upstream response")
	}
	if firstChar := trimmed[0]; firstChar != '{' && firstChar != '[' {
		return nil, false, false, 0, truncateForLog(trimmed), fmt.Errorf("non-json upstream response")
	}

	if runtime.candleStore != nil {
		// Fold passthrough responses into the store so cold or degraded series
		// are repaired by the very requests they let through.
		runtime.candleStore.MergePassthrough(body, respBytes)
		// Re-read the just-repaired range through the store before returning it.
		// That read attaches backend-computed cvdDelta values. Returning the raw
		// upstream body here made the first/default chart paint directional
		// fallback even when startup had already verified the 5m/30m sources;
		// only a later refetch could become enriched. If the merged range still
		// is not safely servable (for example a truncated/gapped response), keep
		// the honest raw passthrough and let the normal warm path finish repair.
		if enriched, ok := runtime.candleStore.ServeInfoRequest(body); ok {
			respBytes = enriched
		}
	}
	// Warm the series in the background to its full lookback (and, for an
	// off-list coin, register it + wire the WS feed) so the next view serves
	// from memory instead of another passthrough. Never blocks this response.
	warmSeriesFromBody(body)
	candleServeTotal.WithLabelValues("passthrough").Inc()
	return respBytes, false, false, 0, "", nil
}

// writeCandleSnapshotResponse maps passthroughCandleSnapshot's result onto the
// gin response, identically for every caller (interactive, radar).
func writeCandleSnapshotResponse(c *gin.Context, respBody []byte, servedFromStore, canceled bool, status int, upstreamBody string, err error) {
	if servedFromStore {
		c.Header("X-PEZ-Candle-Store", "1")
		c.Data(http.StatusOK, "application/json", respBody)
		return
	}
	if canceled {
		if status == 0 {
			status = http.StatusGatewayTimeout
		}
		c.JSON(status, gin.H{"error": "request canceled"})
		return
	}
	if err != nil {
		resp := gin.H{"error": err.Error()}
		if status != 0 {
			resp["status"] = status
		}
		if upstreamBody != "" {
			resp["body"] = upstreamBody
		}
		c.JSON(http.StatusBadGateway, resp)
		return
	}
	c.Data(http.StatusOK, "application/json", respBody)
}

// chartCandleHandler is the backend-owned chart data boundary. Unlike the raw
// /api/hl compatibility proxy it accepts only candle reads and assigns them to
// a visible or prefetch lane before the request can touch Hyperliquid.
func chartCandleHandler(c *gin.Context) {
	var envelope struct {
		Coin      string `json:"coin"`
		Interval  string `json:"interval"`
		StartTime int64  `json:"startTime"`
		EndTime   int64  `json:"endTime"`
		Dex       string `json:"dex"`
		Urgency   string `json:"urgency"`
	}
	if err := c.ShouldBindJSON(&envelope); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.EqualFold(strings.TrimSpace(envelope.Urgency), "hydrate") {
		serveHydrateChartCandleRequest(c, envelope.Coin, envelope.Interval, envelope.StartTime, envelope.EndTime, envelope.Dex)
		return
	}
	sem := candlePassthroughSem
	if strings.EqualFold(strings.TrimSpace(envelope.Urgency), "prefetch") {
		sem = chartPrefetchSem
	}
	serveBoundChartCandleRequest(c, sem, envelope.Coin, envelope.Interval, envelope.StartTime, envelope.EndTime, envelope.Dex)
}

// serveHydrateChartCandleRequest is a non-blocking, store-only probe for
// speculative browser hydration. A miss schedules the store's budgeted
// full/tail repair and returns 202; it never falls through to an interactive
// Hyperliquid passthrough. A user-visible request can therefore use its own
// lane without waiting behind watchlist preparation.
func serveHydrateChartCandleRequest(c *gin.Context, coin, interval string, startTime, endTime int64, dex string) {
	if coin == "" || interval == "" || startTime <= 0 || endTime <= startTime {
		c.JSON(http.StatusBadRequest, gin.H{"error": "coin, interval, and a valid range are required"})
		return
	}
	innerReq := map[string]interface{}{
		"coin": coin, "interval": interval, "startTime": startTime, "endTime": endTime,
	}
	if dex != "" {
		innerReq["dex"] = dex
	}
	body := map[string]interface{}{"type": "candleSnapshot", "req": innerReq}
	if runtime.candleStore == nil {
		// PEZ_CANDLE_PRELOAD=0 intentionally removes the store. Report a clean
		// no-op instead of promising a 202 warm that can never happen; the user's
		// later visible request still owns the ordinary passthrough path.
		candleServeTotal.WithLabelValues("hydrate_unavailable").Inc()
		c.Status(http.StatusNoContent)
		return
	}
	if payload, ok := runtime.candleStore.HydrateInfoRequest(body); ok {
		candleServeTotal.WithLabelValues("hydrate_hit").Inc()
		c.Header("X-PEZ-Candle-Store", "1")
		c.Data(http.StatusOK, "application/json", payload)
		return
	}
	candleServeTotal.WithLabelValues("hydrate_pending").Inc()
	c.Header("Retry-After", "1")
	c.JSON(http.StatusAccepted, gin.H{"status": "warming"})
}

func serveBoundChartCandleRequest(c *gin.Context, sem chan struct{}, coin, interval string, startTime, endTime int64, dex string) {
	if coin == "" || interval == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "coin and interval are required"})
		return
	}

	innerReq := map[string]interface{}{
		"coin":      coin,
		"interval":  interval,
		"startTime": startTime,
		"endTime":   endTime,
	}
	if dex != "" {
		innerReq["dex"] = dex
	}
	body := map[string]interface{}{"type": "candleSnapshot", "req": innerReq}

	// Client abort still cancels. Wait may use this parent; HTTP RTT is 25s
	// after tokens are reserved. Do not fold Wait into a 30s Client-style
	// budget or limiter queue time becomes a 504.
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
	defer cancel()

	respBody, servedFromStore, canceled, status, upstreamBody, err := passthroughCandleSnapshot(ctx, exchange.MainnetAPIURL, sem, body)
	writeCandleSnapshotResponse(c, respBody, servedFromStore, canceled, status, upstreamBody, err)
}

// warmSeriesFromBody kicks a background, budget-paced WarmOnDemand for the
// candleSnapshot's (coin, interval). Single-flighted and idempotent, so it is
// safe on both the success and failure paths: a passthrough that 429'd still
// starts the series warming (the budget makes it wait out the storm), so the
// client's retry serves from memory instead of hitting the same wall.
func warmSeriesFromBody(body map[string]interface{}) {
	if runtime.candleStore == nil {
		return
	}
	req, ok := body["req"].(map[string]interface{})
	if !ok {
		return
	}
	coin, _ := req["coin"].(string)
	interval, _ := req["interval"].(string)
	if coin != "" && interval != "" {
		go runtime.candleStore.WarmOnDemand(coin, interval)
	}
}

var (
	rlLogMu   sync.Mutex
	rlLogAt   time.Time
	rlLogHits int
)

// logUpstreamRateLimit reports Hyperliquid 429s at most once per 5s, with a
// running count, so cold-start throttling is visible in the logs without a
// burst flooding them.
func logUpstreamRateLimit(reqType string) {
	upstreamRateLimitedTotal.WithLabelValues(reqType).Inc()
	rlLogMu.Lock()
	defer rlLogMu.Unlock()
	rlLogHits++
	if time.Since(rlLogAt) < 5*time.Second {
		return
	}
	log.Printf("proxyHL: Hyperliquid HTTP 429 (rate limited) x%d in last window (type=%s) — interactive passthrough returned an error; lower PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN if this persists past cold-start", rlLogHits, reqType)
	rlLogAt = time.Now()
	rlLogHits = 0
}

func truncateForLog(value string) string {
	if len(value) <= 160 {
		return value
	}
	return value[:160] + "..."
}
