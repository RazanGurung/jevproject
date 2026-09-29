package websocket

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
)

// Market-wide liquidation feed. Hyperliquid's public `trades` channel carries no
// liquidation tag, so the server fills that gap from external sources and
// broadcasts the result on the `liquidations` channel.
//
//   - bybit:     wss .../v5/public/linear   (per-symbol allLiquidation + ping)
//   - quicknode: HyperCore /hypercore/ws    (node fills carrying `liquidation`)
//
// Bybit is a free public feed, filtered server-side to coins that also trade on
// Hyperliquid — including the `xyz:` HIP-3 synthetics it lists. QuickNode is the
// only HL-native ground truth and runs only when `HL_QUICKNODE_WS` is configured.

const (
	liqPingInterval  = 20 * time.Second
	liqReadDeadline  = 90 * time.Second
	liqAckDeadline   = 15 * time.Second
	liqMaxBackoff    = 30 * time.Second
	liqStableSession = 30 * time.Second
	bybitSubBatch    = 10
	liqDialTimeout   = 10 * time.Second
	liqWriteDeadline = 10 * time.Second
	// Refreshing through a graceful reconnect keeps the instrument intersection
	// current without introducing a second concurrent websocket writer. Four
	// connections/day is far below Bybit's connection limits.
	bybitInstrumentRefreshInterval = 6 * time.Hour
)

var (
	errBybitInstrumentRefresh    = errors.New("scheduled Bybit instrument refresh")
	errBybitSubscriptionRejected = errors.New("Bybit liquidation subscription rejected")
)

var liquidationHLHTTPClient = &http.Client{
	Timeout:   liqDialTimeout,
	Transport: hlratelimit.WrapTransport(nil),
}

// marketLiquidationOut is the browser-facing liquidation. px/sz stay as their
// wire strings so the renderer parses them exactly like other feeds. method/user
// are populated only by the QuickNode (fills) source.
type marketLiquidationOut struct {
	Coin   string  `json:"coin"`
	Side   string  `json:"side"`
	Px     string  `json:"px"`
	Sz     string  `json:"sz"`
	Value  float64 `json:"value"`
	Time   float64 `json:"time"`
	Method string  `json:"method"`
	User   string  `json:"user"`
}

// ---- config / lifecycle ---------------------------------------------------

// SetLiquidationConfig wires the optional QuickNode endpoint and the shared
// min-notional gate (from env). Call before StartLiquidationFeeds.
func (m *WebSocketManager) SetLiquidationConfig(quickNodeWsURL string, minNotional float64) {
	m.quickNodeWsURL = quickNodeWsURL
	m.quickNodeMinNotional = minNotional
}

// SetLiquidationUniverse reuses the canonical market universe already loaded
// by the startup metadata preloader. Without this handoff the Bybit feed made
// two redundant Hyperliquid /info requests (main + xyz) before subscribing.
// The live fetch remains as a fallback for tests/embedders that do not preload.
func (m *WebSocketManager) SetLiquidationUniverse(coins []string) {
	known := bybitUniverseFromCoins(coins)
	m.liqUniverseMu.Lock()
	m.liqUniverse = known
	m.liqUniverseMu.Unlock()
}

func (m *WebSocketManager) liquidationUniverseSnapshot() map[string]string {
	m.liqUniverseMu.RLock()
	defer m.liqUniverseMu.RUnlock()
	known := make(map[string]string, len(m.liqUniverse))
	for base, coin := range m.liqUniverse {
		known[base] = coin
	}
	return known
}

type LiquidationFeedStatus struct {
	Ready      bool  `json:"ready"`
	Requested  int64 `json:"requestedTopics"`
	Subscribed int64 `json:"subscribedTopics"`
	Rejected   int64 `json:"rejectedTopics"`
}

func (m *WebSocketManager) LiquidationFeedStatus() LiquidationFeedStatus {
	return LiquidationFeedStatus{
		Ready:      m.bybitLiqReady.Load(),
		Requested:  m.bybitLiqRequested.Load(),
		Subscribed: m.bybitLiqSubscribed.Load(),
		Rejected:   m.bybitLiqRejected.Load(),
	}
}

func (m *WebSocketManager) setBybitTopicStatus(ready bool, requested, subscribed, rejected int) {
	m.bybitLiqReady.Store(ready)
	m.bybitLiqRequested.Store(int64(requested))
	m.bybitLiqSubscribed.Store(int64(subscribed))
	m.bybitLiqRejected.Store(int64(rejected))
	liquidationUpstreamTopics.WithLabelValues("requested").Set(float64(requested))
	liquidationUpstreamTopics.WithLabelValues("subscribed").Set(float64(subscribed))
	liquidationUpstreamTopics.WithLabelValues("rejected").Set(float64(rejected))
}

// StartLiquidationFeeds launches a goroutine for each available source (Bybit,
// + QuickNode when configured). They broadcast normalized liquidation events on
// the `liquidations` channel.
func (m *WebSocketManager) StartLiquidationFeeds() {
	m.StartLiquidationFeedsContext(context.Background())
}

func (m *WebSocketManager) StartLiquidationFeedsContext(parent context.Context) {
	m.liqMu.Lock()
	defer m.liqMu.Unlock()

	if m.liqCancel != nil {
		return
	}

	ctx, cancel := context.WithCancel(parent)
	m.liqCancel = cancel

	sources := []string{"bybit"}
	if m.quickNodeWsURL != "" {
		sources = append(sources, "quicknode")
	}
	log.Printf("liquidation feed: starting %d source(s): %v", len(sources), sources)

	for _, src := range sources {
		m.liqWg.Add(1)
		go m.runLiqFeed(ctx, src)
	}
}

// StopLiquidationFeeds cancels all liquidation feed goroutines and waits for
// them to finish (server shutdown).
func (m *WebSocketManager) StopLiquidationFeeds() {
	m.liqMu.Lock()
	defer m.liqMu.Unlock()

	if m.liqCancel == nil {
		return
	}
	log.Printf("liquidation feed: stopping")
	m.liqCancel()
	m.liqWg.Wait()
	m.liqCancel = nil
}

// ---- feed goroutine -------------------------------------------------------

func (m *WebSocketManager) runLiqFeed(ctx context.Context, source string) {
	defer m.liqWg.Done()

	dialer := websocket.Dialer{HandshakeTimeout: liqDialTimeout}
	known := m.liquidationUniverseSnapshot()
	seen := map[string]time.Time{}
	backoff := newReconnectBackoff(time.Second, liqMaxBackoff, liqStableSession)
	var bybitSymbols map[string]struct{}
	var bybitSymbolsAtMs int64

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Bybit matches CEX symbols against the HL universe; refetch while empty
		// so a transient meta failure at startup self-heals on reconnect instead
		// of leaving the source filtering everything out until restart.
		if source == "bybit" && len(known) == 0 {
			known = fetchBybitUniverse(ctx)
		}
		if source == "bybit" && (len(bybitSymbols) == 0 || time.Now().UnixMilli()-bybitSymbolsAtMs >= bybitInstrumentRefreshInterval.Milliseconds()) {
			var err error
			bybitSymbols, err = fetchBybitLinearSymbols(ctx, m.bybitHTTPClient, m.bybitInstrumentsURL)
			if err != nil {
				delay := backoff.Next(0)
				m.setBybitTopicStatus(false, 0, 0, 0)
				liquidationUpstreamReconnectTotal.WithLabelValues(source).Inc()
				log.Printf("liquidation feed [bybit]: instrument refresh failed: %v (retry in %s)", err, delay)
				ok, slept := waitForContext(ctx, delay)
				if slept {
					backoff.Reset()
				}
				if !ok {
					return
				}
				continue
			}
			bybitSymbolsAtMs = time.Now().UnixMilli()
		}

		connectedFor, err := m.runLiqOnce(ctx, source, dialer, known, seen, bybitSymbols)

		select {
		case <-ctx.Done():
			return
		default:
		}
		delay := backoff.Next(connectedFor)
		liquidationUpstreamReconnectTotal.WithLabelValues(source).Inc()
		if connectedFor > 0 {
			liquidationUpstreamSessionSeconds.WithLabelValues(source).Observe(connectedFor.Seconds())
		}
		if errors.Is(err, errBybitInstrumentRefresh) {
			bybitSymbolsAtMs = 0
			log.Printf("liquidation feed [bybit]: refreshing instrument universe")
		} else if errors.Is(err, errBybitSubscriptionRejected) {
			// A fresh instrument intersection should never contain an unsupported
			// topic. Refresh immediately in case Bybit delisted between refreshes.
			bybitSymbolsAtMs = 0
			log.Printf("liquidation feed [bybit]: subscription rejected; refreshing instrument universe (retry in %s)", delay)
		} else if err != nil {
			log.Printf("liquidation feed [%s]: %v (retry in %s)", source, err, delay)
		}
		ok, slept := waitForContext(ctx, delay)
		if slept {
			backoff.Reset()
		}
		if !ok {
			return
		}
	}
}

func waitForContext(ctx context.Context, delay time.Duration) (ok bool, slept bool) {
	return waitForReconnect(ctx.Done(), delay)
}

func (m *WebSocketManager) runLiqOnce(ctx context.Context, source string, dialer websocket.Dialer, known map[string]string, seen map[string]time.Time, bybitSymbols map[string]struct{}) (connectedFor time.Duration, err error) {
	feedURL := m.bybitWsURL
	if source == "quicknode" {
		feedURL = m.quickNodeWsURL
	}

	conn, _, err := dialer.Dial(feedURL, nil)
	if err != nil {
		return 0, err
	}
	m.trackLiqConn(conn)
	defer m.untrackLiqConn(conn)
	connectedAtMs := time.Now().UnixMilli()
	defer func() { connectedFor = wallClockSince(connectedAtMs) }()

	// Close the connection when the server context is cancelled, and unregister
	// the callback when this individual attempt exits. A permanent goroutine
	// waiting only on the server-lifetime context would otherwise accumulate
	// once per ordinary upstream reconnect.
	stopContextClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopContextClose()

	defer conn.Close()
	if source == "bybit" {
		m.setBybitTopicStatus(false, 0, 0, 0)
		defer func() {
			status := m.LiquidationFeedStatus()
			m.setBybitTopicStatus(false, int(status.Requested), 0, int(status.Rejected))
		}()
	}
	log.Printf("liquidation feed [%s]: transport connected", source)

	refreshAt := time.UnixMilli(connectedAtMs).Add(bybitInstrumentRefreshInterval)
	var tracker *bybitAckTracker
	extend := func() {
		deadline := time.Now().Add(liqReadDeadline)
		if tracker != nil && !tracker.complete() && tracker.deadlineAt.Before(deadline) {
			deadline = tracker.deadlineAt
		}
		if source == "bybit" && refreshAt.Before(deadline) {
			deadline = refreshAt
		}
		_ = conn.SetReadDeadline(deadline)
	}
	extend()
	conn.SetPongHandler(func(string) error { extend(); return nil })

	tracker, err = liqOnConnect(conn, source, known, bybitSymbols)
	if err != nil {
		return 0, err
	}
	if source == "quicknode" {
		log.Printf("liquidation feed [quicknode]: ready")
	}

	localDone := make(chan struct{})
	defer close(localDone)
	go liqKeepalive(ctx, conn, source, localDone)

	for {
		extend()
		_, msg, err := conn.ReadMessage()
		if err != nil {
			select {
			case <-ctx.Done():
				return 0, nil // clean shutdown
			default:
			}
			if source == "bybit" && !time.Now().Before(refreshAt) {
				return 0, errBybitInstrumentRefresh
			}
			return 0, err
		}

		var env map[string]interface{}
		if json.Unmarshal(msg, &env) != nil {
			continue
		}
		if source == "bybit" && tracker != nil {
			handled, ackErr := tracker.observe(env)
			if ackErr != nil {
				m.setBybitTopicStatus(false, tracker.requested, tracker.subscribed, tracker.rejected)
				liquidationSubscriptionRejectTotal.Inc()
				return 0, ackErr
			}
			if handled {
				m.setBybitTopicStatus(tracker.complete(), tracker.requested, tracker.subscribed, tracker.rejected)
				if tracker.complete() {
					log.Printf("liquidation feed [bybit]: ready topics=%d batches=%d", tracker.subscribed, tracker.batches)
				}
				continue
			}
		}

		var liqs []marketLiquidationOut
		switch source {
		case "bybit":
			liqs = parseBybitLiquidations(env, known, m.quickNodeMinNotional)
		case "quicknode":
			liqs = extractQuickNodeLiquidations(env, seen, m.quickNodeMinNotional)
			pruneQuickNodeSeen(seen)
		}
		if len(liqs) == 0 {
			continue
		}
		if payload, err := json.Marshal(map[string]interface{}{"channel": "liquidations", "data": liqs}); err == nil {
			m.BroadcastMarket(payload)
		}
	}
}

type bybitAckTracker struct {
	pending    map[string][]string
	requested  int
	subscribed int
	rejected   int
	batches    int
	deadlineAt time.Time
}

func (t *bybitAckTracker) complete() bool { return t != nil && len(t.pending) == 0 && t.rejected == 0 }

func (t *bybitAckTracker) observe(env map[string]interface{}) (bool, error) {
	op, _ := env["op"].(string)
	if op != "subscribe" {
		return false, nil
	}
	reqID, _ := env["req_id"].(string)
	topics, ok := t.pending[reqID]
	if !ok {
		return true, fmt.Errorf("%w: acknowledgement has unknown req_id %q", errBybitSubscriptionRejected, reqID)
	}
	delete(t.pending, reqID)
	success, _ := env["success"].(bool)
	if !success {
		t.rejected += len(topics)
		message, _ := env["ret_msg"].(string)
		return true, fmt.Errorf("%w: topics=%v message=%s", errBybitSubscriptionRejected, topics, message)
	}
	t.subscribed += len(topics)
	return true, nil
}

func liqOnConnect(conn *websocket.Conn, source string, known map[string]string, bybitSymbols map[string]struct{}) (*bybitAckTracker, error) {
	switch source {
	case "bybit":
		topics := buildBybitTopics(known, bybitSymbols)
		if len(topics) == 0 {
			return nil, fmt.Errorf("Bybit instrument intersection produced no liquidation topics")
		}
		tracker := &bybitAckTracker{
			pending:    make(map[string][]string),
			requested:  len(topics),
			deadlineAt: time.Now().Add(liqAckDeadline),
		}
		for i := 0; i < len(topics); i += bybitSubBatch {
			end := i + bybitSubBatch
			if end > len(topics) {
				end = len(topics)
			}
			reqID := fmt.Sprintf("pez-liq-%03d", tracker.batches+1)
			batch := append([]string(nil), topics[i:end]...)
			tracker.pending[reqID] = batch
			tracker.batches++
			conn.SetWriteDeadline(time.Now().Add(liqWriteDeadline))
			if err := conn.WriteJSON(map[string]interface{}{"req_id": reqID, "op": "subscribe", "args": batch}); err != nil {
				return nil, err
			}
		}
		return tracker, nil
	case "quicknode":
		conn.SetWriteDeadline(time.Now().Add(liqWriteDeadline))
		return nil, conn.WriteJSON(map[string]interface{}{
			"jsonrpc": "2.0", "id": 1, "method": "hl_subscribe",
			"params": map[string]interface{}{"stream_type": "TRADES"},
		})
	}
	return nil, nil
}

func buildBybitTopics(known map[string]string, validSymbols map[string]struct{}) []string {
	seen := make(map[string]struct{}, len(known))
	topics := make([]string, 0, len(known))
	for base := range known {
		symbol := strings.ToUpper(hlCoinToExternalSymbol(base))
		if symbol == "" {
			continue
		}
		if _, valid := validSymbols[symbol]; !valid {
			continue
		}
		topic := "allLiquidation." + symbol
		if _, duplicate := seen[topic]; duplicate {
			continue
		}
		seen[topic] = struct{}{}
		topics = append(topics, topic)
	}
	sort.Strings(topics)
	return topics
}

func fetchBybitLinearSymbols(ctx context.Context, client *http.Client, endpoint string) (map[string]struct{}, error) {
	if client == nil {
		client = http.DefaultClient
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse Bybit instruments URL: %w", err)
	}
	result := make(map[string]struct{})
	seenCursors := make(map[string]struct{})
	cursor := ""
	for page := 0; page < 20; page++ {
		requestURL := *parsed
		query := requestURL.Query()
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		requestURL.RawQuery = query.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		var payload struct {
			RetCode int    `json:"retCode"`
			RetMsg  string `json:"retMsg"`
			Result  struct {
				NextPageCursor string `json:"nextPageCursor"`
				List           []struct {
					Symbol string `json:"symbol"`
					Status string `json:"status"`
				} `json:"list"`
			} `json:"result"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&payload)
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("Bybit instruments HTTP %d", resp.StatusCode)
		}
		if decodeErr != nil {
			return nil, fmt.Errorf("decode Bybit instruments: %w", decodeErr)
		}
		if payload.RetCode != 0 {
			return nil, fmt.Errorf("Bybit instruments retCode=%d: %s", payload.RetCode, payload.RetMsg)
		}
		for _, instrument := range payload.Result.List {
			if instrument.Status != "" && !strings.EqualFold(instrument.Status, "Trading") {
				continue
			}
			symbol := strings.ToUpper(strings.TrimSpace(instrument.Symbol))
			if symbol != "" {
				result[symbol] = struct{}{}
			}
		}
		next := strings.TrimSpace(payload.Result.NextPageCursor)
		if next == "" {
			if len(result) == 0 {
				return nil, fmt.Errorf("Bybit instruments response contained no trading symbols")
			}
			return result, nil
		}
		if _, duplicate := seenCursors[next]; duplicate {
			return nil, fmt.Errorf("Bybit instruments repeated pagination cursor")
		}
		seenCursors[next] = struct{}{}
		cursor = next
	}
	return nil, fmt.Errorf("Bybit instruments pagination exceeded 20 pages")
}

// liqKeepalive pings the upstream so the connection stays open during silent
// periods. Both Bybit and QuickNode use an app-level JSON ping, which is the only
// WriteMessage writer after the initial subscribe, so writes stay serialized.
func liqKeepalive(ctx context.Context, conn *websocket.Conn, source string, localDone chan struct{}) {
	ping := []byte(`{"op":"ping"}`)
	if source == "quicknode" {
		ping = []byte(`{"jsonrpc":"2.0","id":0,"method":"ping"}`)
	}
	ticker := time.NewTicker(liqPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-localDone:
			return
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(liqWriteDeadline))
			if err := conn.WriteMessage(websocket.TextMessage, ping); err != nil {
				return
			}
		}
	}
}

// ---- HL universe + symbol mapping -----------------------------------------

// fetchBybitUniverse builds the Bybit HL-coin filter as a map of normalized-base
// → HL coin id: the crypto main dex (`fetchHlPerpCoins`) plus the `xyz:` HIP-3
// synthetics (stocks/commodities/indices) that Bybit also lists.
func fetchBybitUniverse(ctx context.Context) map[string]string {
	known := fetchHlPerpCoins(ctx)
	for base, id := range fetchHlXyzCoins(ctx) {
		if _, ok := known[base]; !ok {
			known[base] = id
		}
	}
	return known
}

// bybitUniverseFromCoins converts canonical metadata keys into the same filter
// shape produced by fetchBybitUniverse. Bybit coverage intentionally includes
// the native perp universe plus xyz synthetics; other builder dexes are not
// assumed to share Bybit symbols.
func bybitUniverseFromCoins(coins []string) map[string]string {
	known := make(map[string]string, len(coins))
	for _, coin := range coins {
		coin = strings.TrimSpace(coin)
		if coin == "" {
			continue
		}
		lower := strings.ToLower(coin)
		if strings.Contains(coin, ":") && !strings.HasPrefix(lower, "xyz:") {
			continue
		}
		base := stripDexPrefix(coin)
		if base == "" {
			continue
		}
		if strings.HasPrefix(lower, "xyz:") {
			if _, exists := known[base]; !exists {
				known[base] = coin
			}
			continue
		}
		// Match the network fallback's native-first merge semantics regardless
		// of metadata-cache map iteration order.
		known[base] = coin
	}
	return known
}

// hlMetaUniverse fetches one Hyperliquid info `universe` and returns its coin
// names. dexBody is the JSON request body (main meta vs an xyz metaAndAssetCtxs).
func hlMetaUniverse(ctx context.Context, body string, metaIsArray bool) []string {
	reqCtx, cancel := context.WithTimeout(ctx, liqDialTimeout)
	defer cancel()
	reqCtx = infogovernor.WithLane(reqCtx, infogovernor.Background)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
		"https://api.hyperliquid.xyz/info", bytes.NewBufferString(body))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := liquidationHLHTTPClient.Do(req)
	if err != nil {
		log.Printf("liquidation feed: meta fetch failed (%v); coin filter incomplete", err)
		return nil
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil
	}
	// metaAndAssetCtxs returns [meta, ctxs]; plain meta returns the object.
	if metaIsArray {
		var arr []json.RawMessage
		if json.Unmarshal(raw, &arr) != nil || len(arr) < 1 {
			return nil
		}
		raw = arr[0]
	}
	var meta struct {
		Universe []struct {
			Name string `json:"name"`
		} `json:"universe"`
	}
	if json.Unmarshal(raw, &meta) != nil {
		return nil
	}
	names := make([]string, 0, len(meta.Universe))
	for _, u := range meta.Universe {
		if u.Name != "" {
			names = append(names, u.Name)
		}
	}
	return names
}

// fetchHlPerpCoins returns the Hyperliquid main-dex perp universe as a map of
// coin name → coin id (identity for the main dex).
func fetchHlPerpCoins(ctx context.Context) map[string]string {
	out := map[string]string{}
	for _, name := range hlMetaUniverse(ctx, `{"type":"meta"}`, false) {
		out[name] = name
	}
	return out
}

// fetchHlXyzCoins returns the xyz HIP-3 dex universe as a map of bare base →
// `xyz:`-prefixed coin id (e.g. "NVDA" → "xyz:NVDA"). The universe names may or
// may not carry the dex prefix, so strip it before keying.
func fetchHlXyzCoins(ctx context.Context) map[string]string {
	out := map[string]string{}
	for _, name := range hlMetaUniverse(ctx, `{"type":"metaAndAssetCtxs","dex":"xyz"}`, true) {
		base := stripDexPrefix(name)
		if base != "" {
			out[base] = "xyz:" + base
		}
	}
	return out
}

// stripDexPrefix drops a leading "<dex>:" qualifier from a coin name.
func stripDexPrefix(name string) string {
	if i := strings.IndexByte(name, ':'); i >= 0 {
		return name[i+1:]
	}
	return name
}

var liqQuoteSuffixes = []string{"USDT", "USDC", "USD", "PERP"}

func stripQuoteSuffix(sym string) string {
	s := strings.ToUpper(sym)
	for _, q := range liqQuoteSuffixes {
		if strings.HasSuffix(s, q) && len(s) > len(q) {
			return strings.TrimSuffix(s, q)
		}
	}
	return s
}

// Bybit lists thousand-denominated meme coins as 1000XXX; HL uses kXXX.
func thousandToK(base string) string {
	if strings.HasPrefix(base, "1000") && len(base) > 4 {
		return "k" + base[4:]
	}
	return base
}

func kToThousand(coin string) string {
	if len(coin) > 1 && coin[0] == 'k' {
		return "1000" + strings.ToUpper(coin[1:])
	}
	return strings.ToUpper(coin)
}

// xyzCexAlias maps an HL `xyz:` base to the Bybit base that lists the same
// underlying under a different ticker, so those liquidations are captured too.
// Verified live against Bybit instruments + mark prices (June 2026): GOLD/SILVER/
// AMD/NOK match HL's mark price exactly; SP500/XYZ100 have no native Bybit index
// perp, so they use the canonical ETF proxy (SPY/QQQ) — same underlying at a
// different price scale, but the broadcast USD notional (px*sz) is still a real
// Bybit figure, which is all the LIQS panel shows. (NATGAS→GASUSDT and SP500→
// SPXUSDT were rejected: those Bybit symbols are unrelated crypto tokens.)
var xyzCexAlias = map[string]string{
	"GOLD":   "XAU",
	"SILVER": "XAG",
	"AMD":    "AMDSTOCK",
	"NOK":    "NOKIA",
	"SP500":  "SPY",
	"XYZ100": "QQQ",
}

// xyzCexAliasRev inverts xyzCexAlias (Bybit base → HL base) for inbound symbol
// resolution. None of the Bybit bases collide with a real HL coin id.
var xyzCexAliasRev = func() map[string]string {
	m := make(map[string]string, len(xyzCexAlias))
	for hl, cex := range xyzCexAlias {
		m[cex] = hl
	}
	return m
}()

// hlCoinFromExternal maps a CEX symbol to its HL coin id, or "" when the coin
// does not trade on Hyperliquid. known maps normalized-base → HL coin id, so an
// xyz synthetic resolves to its `xyz:`-prefixed id (e.g. "NVDAUSDT" → "xyz:NVDA").
func hlCoinFromExternal(sym string, known map[string]string) string {
	base := thousandToK(stripQuoteSuffix(sym))
	if base == "" {
		return ""
	}
	if hl, ok := xyzCexAliasRev[base]; ok {
		base = hl
	}
	if id, ok := known[base]; ok {
		return id
	}
	return ""
}

// hlCoinToExternalSymbol maps a normalized HL base (no dex prefix) to its CEX
// USDT-perp symbol for subscription.
func hlCoinToExternalSymbol(base string) string {
	if base == "" || strings.Contains(base, ":") {
		return ""
	}
	if cex, ok := xyzCexAlias[base]; ok {
		return cex + "USDT"
	}
	return kToThousand(base) + "USDT"
}

// ---- provider parsers -----------------------------------------------------

func parseBybitLiquidations(env map[string]interface{}, known map[string]string, minNotional float64) []marketLiquidationOut {
	topic, _ := env["topic"].(string)
	if !strings.HasPrefix(topic, "allLiquidation") {
		return nil
	}
	data, _ := env["data"].([]interface{})
	var out []marketLiquidationOut
	for _, it := range data {
		item, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		sym, _ := item["s"].(string)
		coin := hlCoinFromExternal(sym, known)
		if coin == "" {
			continue
		}
		pxStr, _ := item["p"].(string)
		szStr, _ := item["v"].(string)
		if liq := buildLiq(coin, bybitOrderSide(item["S"]), pxStr, szStr, liqTimeMs(item["T"]), "", "", minNotional); liq != nil {
			out = append(out, *liq)
		}
	}
	return out
}

func buildLiq(coin, side, pxStr, szStr string, t float64, method, user string, minNotional float64) *marketLiquidationOut {
	px, err1 := strconv.ParseFloat(pxStr, 64)
	sz, err2 := strconv.ParseFloat(szStr, 64)
	if err1 != nil || err2 != nil {
		return nil
	}
	value := px * sz
	if value < minNotional {
		return nil
	}
	return &marketLiquidationOut{
		Coin: coin, Side: side, Px: pxStr, Sz: szStr,
		Value: value, Time: t, Method: method, User: user,
	}
}

func stringSide(raw interface{}) string {
	s, _ := raw.(string)
	return s
}

// bybitOrderSide normalizes Bybit's allLiquidation `S` (position side) to the
// app's order-side convention shared with the QuickNode feed and the renderer.
// Bybit: `Buy` => a long was liquidated, `Sell` => a short was liquidated. The
// forced order is the opposite, so a liquidated long is a forced sell and a
// liquidated short is a forced buy. Unknown values pass through unchanged.
func bybitOrderSide(raw interface{}) string {
	switch stringSide(raw) {
	case "Buy":
		return "Sell"
	case "Sell":
		return "Buy"
	default:
		return stringSide(raw)
	}
}

func liqTimeMs(raw interface{}) float64 {
	switch v := raw.(type) {
	case float64:
		return v
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return float64(time.Now().UnixMilli())
}

// ---- QuickNode (HyperCore fills) parser -----------------------------------
// Fills carry the `liquidation` object directly. A liquidation produces fills for
// both the victim and the liquidators sharing one tid, so dedupe by tid.

const quickNodeDedupeTTL = 5 * time.Minute

func extractQuickNodeLiquidations(envelope map[string]interface{}, seen map[string]time.Time, minNotional float64) []marketLiquidationOut {
	var out []marketLiquidationOut
	for _, trade := range quickNodeTradeCandidates(envelope) {
		liq, ok := trade["liquidation"].(map[string]interface{})
		if !ok || liq == nil {
			continue
		}
		tid := quickNodeTradeID(trade)
		if tid != "" {
			if _, dup := seen[tid]; dup {
				continue
			}
		}
		pxStr, _ := trade["px"].(string)
		szStr, _ := trade["sz"].(string)
		method, _ := liq["method"].(string)
		user, _ := liq["liquidatedUser"].(string)
		built := buildLiq(stringField(trade, "coin"), stringSide(trade["side"]), pxStr, szStr, liqTimeMs(trade["time"]), method, user, minNotional)
		if built == nil {
			continue
		}
		if tid != "" {
			seen[tid] = time.Now()
		}
		out = append(out, *built)
	}
	return out
}

func quickNodeTradeCandidates(envelope map[string]interface{}) []map[string]interface{} {
	var payload interface{} = envelope
	if p, ok := envelope["params"]; ok {
		payload = p
	} else if r, ok := envelope["result"]; ok {
		payload = r
	}
	if pm, ok := payload.(map[string]interface{}); ok {
		if data, ok := pm["data"]; ok {
			payload = data
		} else {
			payload = pm
		}
	}

	switch typed := payload.(type) {
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			if t, ok := item.(map[string]interface{}); ok && t["coin"] != nil {
				out = append(out, t)
			}
		}
		return out
	case map[string]interface{}:
		if typed["coin"] != nil && typed["px"] != nil {
			return []map[string]interface{}{typed}
		}
	}
	return nil
}

func quickNodeTradeID(trade map[string]interface{}) string {
	switch v := trade["tid"].(type) {
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case string:
		return v
	default:
		return ""
	}
}

func stringField(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return s
}

func pruneQuickNodeSeen(seen map[string]time.Time) {
	cutoff := time.Now().Add(-quickNodeDedupeTTL)
	for tid, at := range seen {
		if at.Before(cutoff) {
			delete(seen, tid)
		}
	}
}

func (m *WebSocketManager) trackLiqConn(conn *websocket.Conn) {
	if m == nil || conn == nil {
		return
	}
	m.liqLiveMu.Lock()
	m.liqLive = append(m.liqLive, conn)
	m.liqLiveMu.Unlock()
}

func (m *WebSocketManager) untrackLiqConn(conn *websocket.Conn) {
	if m == nil || conn == nil {
		return
	}
	m.liqLiveMu.Lock()
	out := m.liqLive[:0]
	for _, live := range m.liqLive {
		if live != conn {
			out = append(out, live)
		}
	}
	m.liqLive = out
	m.liqLiveMu.Unlock()
}

func (m *WebSocketManager) closeLiquidationConnsForWake() {
	m.liqLiveMu.Lock()
	conns := append([]*websocket.Conn(nil), m.liqLive...)
	m.liqLiveMu.Unlock()
	for _, conn := range conns {
		if conn != nil {
			_ = conn.Close()
		}
	}
}
