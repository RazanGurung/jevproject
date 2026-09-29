// Package hlratelimit owns process-wide Hyperliquid REST weight accounting.
// Keeping the limiter at the HTTP transport boundary means retries, startup
// metadata, chart passthroughs, account reads, health probes, and signed actions
// all consume the same per-IP allowance instead of maintaining incompatible
// subsystem-local estimates.
package hlratelimit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"hyperliquid-go/internal/infrastructure/infogovernor"
)

const (
	OfficialWeightPerMinute = 1200
	// A 200-weight idle burst plus 1000 continuously refilled weight keeps every
	// rolling minute at or below the official 1200 allowance.
	sustainedWeightPerMinute = 1000
	weightBurst              = 200
)

type Limiter struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	now    func() time.Time
}

func NewLimiter() *Limiter {
	return &Limiter{tokens: weightBurst, now: time.Now}
}

var processLimiter = NewLimiter()

func laneReserve(lane infogovernor.Lane) float64 {
	switch lane {
	case infogovernor.Execution:
		return 0
	case infogovernor.VisibleChart:
		return 20
	case infogovernor.AccountCore:
		return 40
	case infogovernor.Enrichment:
		return 80
	default:
		return 120
	}
}

func (l *Limiter) refillLocked(now time.Time) {
	if l.last.IsZero() {
		l.last = now
		return
	}
	l.tokens += now.Sub(l.last).Seconds() * sustainedWeightPerMinute / 60
	if l.tokens > weightBurst {
		l.tokens = weightBurst
	}
	l.last = now
}

func (l *Limiter) Wait(ctx context.Context, lane infogovernor.Lane, weight int) error {
	if weight < 1 {
		weight = 1
	}
	if weight > weightBurst {
		weight = weightBurst
	}
	for {
		l.mu.Lock()
		l.refillLocked(l.now())
		reserve := laneReserve(lane)
		// A single legitimate heavy request must eventually fit at a full bucket.
		reserve = math.Min(reserve, math.Max(0, weightBurst-float64(weight)))
		needed := float64(weight) + reserve
		if l.tokens >= needed {
			l.tokens -= float64(weight)
			l.mu.Unlock()
			return nil
		}
		deficit := needed - l.tokens
		wait := time.Duration(deficit / (sustainedWeightPerMinute / 60) * float64(time.Second))
		l.mu.Unlock()
		if wait < time.Millisecond {
			wait = time.Millisecond
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// Charge records response-sized weight that cannot be known before an info
// response arrives. A negative balance makes future calls wait; the completed
// response is never held hostage after Hyperliquid already served it.
func (l *Limiter) Charge(weight int) {
	if weight == 0 {
		return
	}
	l.mu.Lock()
	l.refillLocked(l.now())
	l.tokens -= float64(weight)
	if l.tokens > weightBurst {
		l.tokens = weightBurst
	}
	l.mu.Unlock()
}

type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	if c.cancel != nil {
		c.cancel()
	}
	return err
}

type weightedTransport struct {
	base    http.RoundTripper
	limiter *Limiter
}

type rttTimeoutCtxKey struct{}

// WithRTTTimeout records the Hyperliquid HTTP bound that starts after limiter
// Wait returns. Architecture: wait must not share a Client.Timeout / request
// deadline with upstream RTT.
func WithRTTTimeout(ctx context.Context, d time.Duration) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if d <= 0 {
		return ctx
	}
	return context.WithValue(ctx, rttTimeoutCtxKey{}, d)
}

func rttTimeoutOf(ctx context.Context) time.Duration {
	if ctx == nil {
		return 0
	}
	d, _ := ctx.Value(rttTimeoutCtxKey{}).(time.Duration)
	return d
}

func WrapTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &weightedTransport{base: base, limiter: processLimiter}
}

func isHyperliquidREST(req *http.Request) bool {
	if req == nil || req.URL == nil {
		return false
	}
	host := strings.ToLower(req.URL.Hostname())
	if host != "api.hyperliquid.xyz" && host != "api.hyperliquid-testnet.xyz" && host != "testnet-api.hyperliquid.xyz" {
		return false
	}
	return req.URL.Path == "/info" || req.URL.Path == "/exchange"
}

func requestBody(req *http.Request) []byte {
	if req == nil || req.Body == nil {
		return nil
	}
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err == nil {
			defer body.Close()
			data, _ := io.ReadAll(body)
			return data
		}
	}
	data, err := io.ReadAll(req.Body)
	if err != nil {
		return nil
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(data))
	return data
}

func (t *weightedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !isHyperliquidREST(req) {
		return t.base.RoundTrip(req)
	}
	body := requestBody(req)
	weight, requestType := RequestWeight(req.URL.Path, body)
	fallback := infogovernor.Enrichment
	if req.URL.Path == "/exchange" {
		fallback = infogovernor.Execution
	}
	lane := infogovernor.LaneFromContext(req.Context(), fallback)
	waitCtx := req.Context()
	if err := t.limiter.Wait(waitCtx, lane, weight); err != nil {
		return nil, err
	}
	httpReq := req
	var cancel context.CancelFunc
	if d := rttTimeoutOf(waitCtx); d > 0 {
		var ctx context.Context
		ctx, cancel = context.WithTimeout(waitCtx, d)
		httpReq = req.WithContext(ctx)
	}
	resp, err := t.base.RoundTrip(httpReq)
	if err != nil {
		if cancel != nil {
			cancel()
		}
		if reserved := reservedItemExtra(requestType); reserved > 0 {
			t.limiter.Charge(-reserved)
		}
		return resp, err
	}
	if cancel != nil {
		resp.Body = &cancelOnClose{ReadCloser: resp.Body, cancel: cancel}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if reserved := reservedItemExtra(requestType); reserved > 0 {
			t.limiter.Charge(-reserved)
		}
		return resp, err
	}
	if extraKind(requestType) == 0 || resp.Body == nil {
		return resp, nil
	}
	responseBody, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	resp.Body = io.NopCloser(bytes.NewReader(responseBody))
	// RequestWeight already reserved the documented worst-case extra. Charge
	// only the delta so an oversized response still counts and a short one
	// refunds unused reserve.
	reserved := reservedItemExtra(requestType)
	actual := responseExtraWeight(requestType, responseBody)
	t.limiter.Charge(actual - reserved)
	return resp, nil
}

var weightTwoInfoTypes = map[string]bool{
	"l2Book": true, "allMids": true, "clearinghouseState": true,
	"orderStatus": true, "spotClearinghouseState": true, "exchangeStatus": true,
}

var perTwentyInfoTypes = map[string]bool{
	"recentTrades": true, "historicalOrders": true, "userFills": true,
	"userFillsByTime": true, "fundingHistory": true, "userFunding": true,
	"nonUserFundingUpdates": true, "twapHistory": true, "userTwapSliceFills": true,
	"userTwapSliceFillsByTime": true, "delegatorHistory": true,
	"delegatorRewards": true, "validatorStats": true,
}

// RequestWeight returns the documented base request weight. Candle requests
// reserve their range-estimated response weight up front so a 5000-row history
// cannot overshoot the global budget before the response is observed.
func RequestWeight(path string, body []byte) (int, string) {
	var payload map[string]interface{}
	_ = json.Unmarshal(body, &payload)
	if path == "/exchange" {
		return exchangeRequestWeight(payload), "exchange"
	}
	requestType, _ := payload["type"].(string)
	if weightTwoInfoTypes[requestType] {
		return 2, requestType
	}
	if requestType == "userRole" {
		return 60, requestType
	}
	if requestType == "candleSnapshot" {
		return 20 + estimateCandleCount(payload)/60, requestType
	}
	if extra := reservedItemExtra(requestType); extra > 0 {
		return 20 + extra, requestType
	}
	return 20, requestType
}

func reservedItemExtra(requestType string) int {
	if !perTwentyInfoTypes[requestType] {
		return 0
	}
	switch requestType {
	case "userFills", "userFillsByTime", "historicalOrders",
		"userTwapSliceFills", "userTwapSliceFillsByTime":
		return 2000 / 20
	default:
		return 500 / 20
	}
}

func exchangeRequestWeight(payload map[string]interface{}) int {
	action, _ := payload["action"].(map[string]interface{})
	batchLength := 0
	for _, key := range []string{"orders", "cancels", "modifies"} {
		if values, ok := action[key].([]interface{}); ok && len(values) > batchLength {
			batchLength = len(values)
		}
	}
	return 1 + batchLength/40
}

func extraKind(requestType string) int {
	if perTwentyInfoTypes[requestType] {
		return 20
	}
	return 0
}

func responseExtraWeight(requestType string, body []byte) int {
	divisor := extraKind(requestType)
	if divisor == 0 {
		return 0
	}
	var rows []json.RawMessage
	if json.Unmarshal(body, &rows) != nil {
		return 0
	}
	return len(rows) / divisor
}

func estimateCandleCount(payload map[string]interface{}) int {
	req, _ := payload["req"].(map[string]interface{})
	if req == nil {
		return 5000
	}
	interval, _ := req["interval"].(string)
	intervalMs := candleIntervalMs(interval)
	start := number(req["startTime"])
	end := number(req["endTime"])
	if intervalMs <= 0 || end <= start {
		return 5000
	}
	count := int((end - start) / float64(intervalMs))
	if count < 1 {
		count = 1
	}
	if count > 5000 {
		count = 5000
	}
	return count
}

func number(value interface{}) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case string:
		var parsed float64
		_, _ = fmt.Sscan(typed, &parsed)
		return parsed
	default:
		return 0
	}
}

func candleIntervalMs(interval string) float64 {
	values := map[string]float64{
		"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
		"30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
		"4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000,
		"1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
		"1M": 2_592_000_000,
	}
	return values[interval]
}
