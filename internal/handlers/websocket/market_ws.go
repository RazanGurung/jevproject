package websocket

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"hyperliquid-go/internal/chartrequirements"
	"hyperliquid-go/internal/ports/cache"
)

// marketWireEnvelope is the only decode the read pump needs for routing.
// Large l2Book payloads stay as raw bytes and are forwarded unchanged.
type marketWireEnvelope struct {
	Channel string          `json:"channel"`
	Data    json.RawMessage `json:"data"`
	Coin    string          `json:"coin"`
}

type allMidsWire struct {
	Mids map[string]string `json:"mids"`
}

type marketCoinWire struct {
	Coin string `json:"coin"`
	S    string `json:"s"`
}

func (m *WebSocketManager) StartMarketWebSocket() {
	m.MarketWsMu.Lock()
	if m.MarketWsConn != nil {
		m.MarketWsMu.Unlock()
		return
	}
	m.MarketWsMu.Unlock()

	go func() {
		defer close(m.MarketDoneCh)

		dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
		backoff := newReconnectBackoff(time.Second, 30*time.Second, 30*time.Second)
		m.marketReconnectBackoff = backoff

		for {
			select {
			case <-m.MarketStopCh:
				return
			default:
			}

			conn, _, err := dialer.Dial(m.WsURL, nil)
			if err != nil {
				delay := backoff.Next(0)
				marketUpstreamReconnectTotal.WithLabelValues("dial").Inc()
				log.Printf("Market WebSocket dial failed: %v (retry in %s)", err, delay)
				if !waitThenMaybeReset(backoff, m.MarketStopCh, delay) {
					return
				}
				continue
			}
			connectedAtMs := time.Now().UnixMilli()

			m.MarketWsMu.Lock()
			m.MarketWsConn = conn
			m.MarketWsMu.Unlock()
			bindUpstreamPingHandler(conn, &m.MarketSubMu, func() bool {
				m.MarketWsMu.RLock()
				current := m.MarketWsConn
				m.MarketWsMu.RUnlock()
				return current == conn
			})
			log.Printf("Market WebSocket connected")
			m.broadcastUpstreamStatus(true)

			// Start draining incoming messages immediately, concurrently with the
			// (re)subscribe writes below. Hyperliquid pushes a response for every
			// subscribe right away, and reapplySubscriptions can carry dozens of
			// permanent subscriptions accumulated over a long session (on-demand
			// series are never evicted); writing that whole burst before anyone
			// reads let the incoming backlog build up and got the connection
			// closed (1006 abnormal closure), which then reconnected and repeated
			// the same (growing) burst with no backoff — spiraling into a
			// reconnect storm. Verified directly: a bare client that writes N
			// subscribes before reading gets dropped by Hyperliquid partway
			// through; the same writes interleaved with a concurrent reader all
			// succeed. gorilla/websocket supports exactly one concurrent reader
			// and one concurrent writer, so running this pump alongside the
			// subscribe writes (still serialized through MarketSubMu like every
			// other writer) is safe.
			readErrCh := make(chan error, 1)
			go func() { readErrCh <- m.runMarketReadPump(conn) }()

			priorityCoins, priorityCandleKeys := m.priorityReapplyStateLocked()
			m.MarketSubMu.Lock()
			ok := m.writeMarketSubscription(conn, "subscribe", map[string]interface{}{"type": "allMids"})
			if ok {
				for _, dex := range m.builderDexes {
					if !m.writeMarketSubscription(conn, "subscribe", map[string]interface{}{"type": "allMids", "dex": dex}) {
						ok = false
						break
					}
				}
			}
			if ok {
				ok = m.reapplySubscriptions(conn, priorityCoins, priorityCandleKeys, true)
			}
			m.MarketSubMu.Unlock()
			if !ok {
				// A failed write already closed and cleared the connection via
				// markMarketSocketDegraded; wait for the read pump to notice and
				// exit so it can't outlive this connection attempt.
				readErr := <-readErrCh
				connectedFor := wallClockSince(connectedAtMs)
				delay := backoff.Next(connectedFor)
				marketUpstreamReconnectTotal.WithLabelValues("write").Inc()
				marketUpstreamSessionSeconds.Observe(connectedFor.Seconds())
				log.Printf("Market WebSocket subscription setup failed after %s: %v (retry in %s)", connectedFor.Round(time.Millisecond), readErr, delay)
				if !waitThenMaybeReset(backoff, m.MarketStopCh, delay) {
					return
				}
				continue
			}
			if m.candleSink != nil {
				m.candleSink.OnMarketWSReconnect()
			}

			go m.runMarketKeepalive(conn)

			m.MarketSubMu.Lock()
			m.MarketWsMu.RLock()
			stillCurrent := m.MarketWsConn == conn
			m.MarketWsMu.RUnlock()
			if stillCurrent {
				if !m.reapplySubscriptions(conn, priorityCoins, priorityCandleKeys, false) {
					ok = false
				}
			}
			m.MarketSubMu.Unlock()
			if !ok {
				readErr := <-readErrCh
				connectedFor := wallClockSince(connectedAtMs)
				delay := backoff.Next(connectedFor)
				marketUpstreamReconnectTotal.WithLabelValues("write").Inc()
				marketUpstreamSessionSeconds.Observe(connectedFor.Seconds())
				log.Printf("Market WebSocket remainder subscription setup failed after %s: %v (retry in %s)", connectedFor.Round(time.Millisecond), readErr, delay)
				if !waitThenMaybeReset(backoff, m.MarketStopCh, delay) {
					return
				}
				continue
			}

			select {
			case <-m.MarketStopCh:
				conn.Close()
				<-readErrCh
				return
			case err := <-readErrCh:
				m.markMarketSocketDegraded(conn)
				connectedFor := wallClockSince(connectedAtMs)
				delay := backoff.Next(connectedFor)
				marketUpstreamReconnectTotal.WithLabelValues("read").Inc()
				marketUpstreamSessionSeconds.Observe(connectedFor.Seconds())
				log.Printf("Market WebSocket read error after %s: %v (retry in %s)", connectedFor.Round(time.Millisecond), err, delay)
				if !waitThenMaybeReset(backoff, m.MarketStopCh, delay) {
					return
				}
			}
		}
	}()
}

// runMarketReadPump reads and dispatches messages on conn until ReadMessage
// errors (including an error forced by conn.Close() from elsewhere), then
// returns that error. Runs as its own goroutine, started before the (re)subscribe
// writes on a fresh connection, so incoming data is drained even while a large
// subscribe burst is still being written — see the call site in
// StartMarketWebSocket for why that ordering matters.
func (m *WebSocketManager) runMarketReadPump(conn *websocket.Conn) error {
	for {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		var env marketWireEnvelope
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}

		switch env.Channel {
		case "allMids":
			m.handleAllMidsData(env.Data)
			m.BroadcastMarket(msg)
		case "l2Book":
			coin := env.Coin
			if coin == "" {
				coin = marketDataCoin(env.Data)
			}
			m.BroadcastMarketMessage(env.Channel, marketRouteMessage(env.Channel, coin), msg)
		case "trades":
			var wsMsg map[string]interface{}
			if err := json.Unmarshal(msg, &wsMsg); err != nil {
				continue
			}
			annotated := m.annotateTradesMessage(wsMsg, msg)
			m.BroadcastMarketMessage(env.Channel, wsMsg, annotated)
		case "candle":
			var wsMsg map[string]interface{}
			if err := json.Unmarshal(msg, &wsMsg); err != nil {
				continue
			}
			out := msg
			if m.candleSink != nil {
				m.candleSink.ApplyWSCandle(wsMsg)
				out = m.candleSink.AnnotateWSCandle(wsMsg, msg)
			}
			m.BroadcastMarketMessage(env.Channel, wsMsg, out)
		}
	}
}

func (m *WebSocketManager) handleAllMidsData(data json.RawMessage) {
	var payload allMidsWire
	if err := json.Unmarshal(data, &payload); err != nil || len(payload.Mids) == 0 {
		return
	}

	now := time.Now()
	streamMids := make(map[string]float64, len(payload.Mids))
	m.BBOCacheMu.Lock()
	for coin, priceStr := range payload.Mids {
		price, err := strconv.ParseFloat(priceStr, 64)
		if err != nil {
			continue
		}
		m.BBOCache[coin] = BBOCache{Bid: price, Ask: price, Time: now}
		if m.priceCache != nil {
			m.priceCache.Set(coin, cache.PriceCacheEntry{
				Buy:  price,
				Sell: price,
				Time: now,
			})
		}
		if price > 0 {
			streamMids[coin] = price
		}
	}
	m.BBOCacheMu.Unlock()

	// Keep the exchange adapter's execution mid cache warm so standard and
	// builder close/order paths do not pay an extra /info fetch.
	if len(streamMids) > 0 && m.xyzMidsSink != nil {
		m.xyzMidsSink(streamMids)
	}
}

func (m *WebSocketManager) reapplySubscriptions(conn *websocket.Conn, priorityCoins []string, priorityCandleKeys map[string]bool, priorityOnly bool) bool {
	if !priorityOnly {
		log.Printf(
			"reapplying market subscriptions: books=%d candles=%d trades=%d",
			len(m.MarketBookRefs),
			len(m.MarketCandleRefs),
			len(m.MarketTradeRefs),
		)
	}
	writeBook := func(coin string) bool {
		if m.MarketBookRefs[coin] > 0 {
			return m.writeMarketSubscription(conn, "subscribe", marketSubscriptionPayload("l2Book", coin, ""))
		}
		return true
	}
	writeTrades := func(coin string) bool {
		if m.MarketTradeRefs[coin] > 0 {
			return m.writeMarketSubscription(conn, "subscribe", marketSubscriptionPayload("trades", coin, ""))
		}
		return true
	}
	writeCandleKey := func(key string) bool {
		if m.MarketCandleRefs[key] <= 0 {
			return true
		}
		coin, interval, ok := splitCandleKey(key)
		if !ok {
			return true
		}
		return m.writeMarketSubscription(conn, "subscribe", marketSubscriptionPayload("candle", coin, interval))
	}

	priorityKeys := make(map[string]bool, len(priorityCandleKeys))
	for _, coin := range priorityCoins {
		if !writeBook(coin) || !writeTrades(coin) {
			return false
		}
	}
	if len(priorityCandleKeys) > 0 {
		for key := range priorityCandleKeys {
			priorityKeys[key] = true
			if !writeCandleKey(key) {
				return false
			}
		}
	} else {
		for _, coin := range priorityCoins {
			for key := range m.MarketCandleRefs {
				c, _, ok := splitCandleKey(key)
				if ok && c == coin {
					priorityKeys[key] = true
					if !writeCandleKey(key) {
						return false
					}
				}
			}
		}
	}
	if priorityOnly {
		return true
	}

	for coin, count := range m.MarketBookRefs {
		if count > 0 && !containsString(priorityCoins, coin) {
			if !writeBook(coin) {
				return false
			}
		}
	}
	for key, count := range m.MarketCandleRefs {
		if count > 0 && !priorityKeys[key] {
			if !writeCandleKey(key) {
				return false
			}
		}
	}
	for coin, count := range m.MarketTradeRefs {
		if count > 0 && !containsString(priorityCoins, coin) {
			if !writeTrades(coin) {
				return false
			}
		}
	}
	return true
}

func (m *WebSocketManager) priorityReapplyStateLocked() ([]string, map[string]bool) {
	seen := map[string]bool{}
	var coins []string
	candleKeys := map[string]bool{}
	add := func(coin string) {
		coin = strings.TrimSpace(coin)
		if coin == "" || seen[coin] {
			return
		}
		seen[coin] = true
		coins = append(coins, coin)
	}
	m.StreamMu.RLock()
	for client := range m.streamClients {
		if client == nil || !client.kind.acceptsMarket() {
			continue
		}
		client.mu.Lock()
		add(client.market.Coin)
		for key := range chartCandleRefSet(client.market.Coin, client.market.Interval, mapKeys(client.market.IndicatorIntervals)) {
			candleKeys[key] = true
		}
		client.mu.Unlock()
	}
	m.StreamMu.RUnlock()
	return coins, candleKeys
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

type SubscriptionUpdateResult struct {
	AcceptedTradeCoins []string `json:"acceptedTradeCoins,omitempty"`
	DroppedTradeCoins  []string `json:"droppedTradeCoins,omitempty"`
	AddedTradeCoins    []string `json:"-"`
	Pending            bool     `json:"pending,omitempty"`
	Changed            bool     `json:"changed"`
	Rejected           bool     `json:"-"`
}

func (m *WebSocketManager) UpdateMarketSubscriptions(clientID, coin, interval string, tradeCoins []string) SubscriptionUpdateResult {
	return m.UpdateMarketSubscriptionsWithIndicators(clientID, coin, interval, tradeCoins, nil)
}

func (m *WebSocketManager) UpdateMarketSubscriptionsWithIndicators(clientID, coin, interval string, tradeCoins, indicatorIntervals []string) SubscriptionUpdateResult {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return SubscriptionUpdateResult{Rejected: true}
	}
	if len(tradeCoins) > maxTradeCoinsPerClient {
		tradeCoins = tradeCoins[:maxTradeCoinsPerClient]
	}

	var clients []*streamClient
	m.StreamMu.RLock()
	for client := range m.streamClients {
		if !client.kind.acceptsMarket() || client.id != clientID {
			continue
		}
		client.mu.Lock()
		open := !client.closed
		client.mu.Unlock()
		if open {
			clients = append(clients, client)
		}
	}
	m.StreamMu.RUnlock()

	if len(clients) == 0 {
		now := time.Now()
		m.MarketSubMu.Lock()
		m.prunePendingMarketSubsLocked(now)
		if _, exists := m.PendingMarketSubs[clientID]; !exists && len(m.PendingMarketSubs) >= maxPendingMarketSubs {
			m.MarketSubMu.Unlock()
			return SubscriptionUpdateResult{Rejected: true}
		}
		m.PendingMarketSubs[clientID] = pendingMarketSub{
			state:    buildMarketSubscriptionState(coin, interval, tradeCoins, indicatorIntervals),
			storedAt: now,
		}
		m.MarketSubMu.Unlock()
		return SubscriptionUpdateResult{AcceptedTradeCoins: tradeCoins, Pending: true}
	}

	var result SubscriptionUpdateResult
	for _, client := range clients {
		result = m.applyClientMarketSubscriptionsWithIndicators(client, coin, interval, tradeCoins, indicatorIntervals)
	}
	return result
}

func (m *WebSocketManager) applyClientMarketSubscriptionsWithIndicators(client *streamClient, coin, interval string, tradeCoins, indicatorIntervals []string) SubscriptionUpdateResult {
	m.MarketSubMu.Lock()
	defer m.MarketSubMu.Unlock()
	return m.applyClientMarketSubscriptionsLocked(client, coin, interval, tradeCoins, indicatorIntervals)
}

// applyClientMarketSubscriptionsLocked is the core apply path; caller must hold MarketSubMu.
func (m *WebSocketManager) applyClientMarketSubscriptionsLocked(client *streamClient, coin, interval string, tradeCoins, indicatorIntervals []string) SubscriptionUpdateResult {
	if client == nil {
		return SubscriptionUpdateResult{Rejected: true}
	}

	m.MarketWsMu.RLock()
	conn := m.MarketWsConn
	m.MarketWsMu.RUnlock()

	writeSub := stopAfterMarketSubscriptionWriteFailure(func(method string, fields map[string]interface{}) bool {
		return m.writeMarketSubscription(conn, method, fields)
	})

	client.mu.Lock()
	previous := cloneMarketSubscriptionState(client.market)
	requestedState := buildMarketSubscriptionState(coin, interval, tradeCoins, indicatorIntervals)
	if marketSubscriptionStatesEqual(previous, requestedState) {
		accepted := orderedStateCoins(coin, tradeCoins, previous.TradeCoins)
		client.mu.Unlock()
		return SubscriptionUpdateResult{AcceptedTradeCoins: accepted}
	}
	// A newly-selected active chart outranks dormant permanent warm feeds. Make
	// room before building the next state so it never pushes the upstream socket
	// past its budget after a large snapshot restore.
	needed := 0
	nextChartCandles := chartCandleRefSet(coin, interval, indicatorIntervals)
	previousChartCandles := chartCandleRefSet(previous.Coin, previous.Interval, mapKeys(previous.IndicatorIntervals))
	for key := range nextChartCandles {
		if !previousChartCandles[key] && m.MarketCandleRefs[key] == 0 {
			needed++
		}
	}
	if coin != "" && !previous.TradeCoins[coin] {
		needed += 2
	}
	m.freePermanentCapacityLocked(needed, writeSub)
	accepted, dropped := m.admitTradeCoinsLocked(previous, coin, interval, tradeCoins, indicatorIntervals)
	next := buildMarketSubscriptionState(coin, interval, accepted, indicatorIntervals)
	client.market = next
	client.mu.Unlock()
	added := addedMarketTradeCoins(previous, next)

	m.updateMarketSubscriptionRefs(previous, next, writeSub)
	m.recordMarketSubscriptionMetricsLocked()
	if len(dropped) > 0 {
		marketSubscriptionShedTotal.Add(float64(len(dropped)))
	}
	delete(m.PendingMarketSubs, client.id)
	log.Printf(
		"market subscription applied: clientId=%s coin=%s interval=%s tradeCoins=%d added=%d dropped=%d bookRef=%d candleRef=%d tradeRefTotal=%d",
		client.id,
		next.Coin,
		next.Interval,
		len(next.TradeCoins),
		len(added),
		len(dropped),
		m.MarketBookRefs[next.Coin],
		m.MarketCandleRefs[candleRefKey(next.Coin, next.Interval)],
		countTradeRefsForCoins(m.MarketTradeRefs, next.TradeCoins),
	)
	return SubscriptionUpdateResult{
		AcceptedTradeCoins: accepted,
		DroppedTradeCoins:  dropped,
		AddedTradeCoins:    added,
		Changed:            true,
	}
}

// freePermanentCapacityLocked releases dormant candle-store feeds only. A
// series with any client-held ref is never selected, so a visible chart always
// keeps its live candle stream. Caller must hold MarketSubMu.
func (m *WebSocketManager) freePermanentCapacityLocked(needed int, writeSub func(string, map[string]interface{})) {
	for needed > 0 && m.marketSubscriptionCountLocked()+needed > maxMarketSubscriptions {
		removed := false
		for key, permanent := range m.PermanentCandleRefs {
			if permanent <= 0 || m.MarketCandleRefs[key] != permanent {
				continue
			}
			coin, interval, ok := splitCandleKey(key)
			if !ok {
				continue
			}
			for m.PermanentCandleRefs[key] > 0 {
				m.PermanentCandleRefs[key]--
				m.decrementCandleRef(coin, interval, writeSub)
			}
			delete(m.PermanentCandleRefs, key)
			m.notifyCandleFeedDropped(coin, interval)
			removed = true
			break
		}
		if !removed {
			return
		}
	}
}

// notifyCandleFeedDropped tells the cache that its permanent WS feed no
// longer exists. It deliberately runs while the subscription lock is held:
// the sink only marks local cache state and never calls back into the manager,
// so the notification cannot race a new client-held candle subscription.
func (m *WebSocketManager) notifyCandleFeedDropped(coin, interval string) {
	marketPermanentCandleFeedDroppedTotal.Inc()
	if m.candleSink != nil {
		m.candleSink.OnCandleFeedDropped(coin, interval)
	}
}

// admitTradeCoinsLocked keeps the active chart feed and retains existing
// client subscriptions first. New background book/trade pairs are admitted
// only while the shared upstream subscription budget has room.
func (m *WebSocketManager) admitTradeCoinsLocked(previous marketSubscriptionState, coin, interval string, requested, indicatorIntervals []string) ([]string, []string) {
	seen := make(map[string]bool, len(requested)+1)
	ordered := make([]string, 0, len(requested)+1)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		ordered = append(ordered, value)
	}
	add(coin) // active chart is never shed
	for _, value := range requested {
		add(value)
	}

	count := m.marketSubscriptionCountLocked()
	previousCandles := chartCandleRefSet(previous.Coin, previous.Interval, mapKeys(previous.IndicatorIntervals))
	for key := range chartCandleRefSet(coin, interval, indicatorIntervals) {
		if !previousCandles[key] && m.MarketCandleRefs[key] == 0 {
			count++
		}
	}
	accepted := make([]string, 0, len(ordered))
	dropped := make([]string, 0)
	for _, value := range ordered {
		if previous.TradeCoins[value] || value == coin || count+2 <= maxMarketSubscriptions {
			accepted = append(accepted, value)
			if !previous.TradeCoins[value] {
				count += 2
			}
			continue
		}
		dropped = append(dropped, value)
	}
	return accepted, dropped
}

func (m *WebSocketManager) marketSubscriptionCountLocked() int {
	// allMids is always subscribed once for the default dex and once for each
	// discovered builder dex. Count every one so generic venue discovery cannot
	// silently oversubscribe the operational budget.
	return len(m.MarketBookRefs) + len(m.MarketCandleRefs) + len(m.MarketTradeRefs) + 1 + len(m.builderDexes)
}

func (m *WebSocketManager) recordMarketSubscriptionMetricsLocked() {
	marketUpstreamSubscriptions.Set(float64(m.marketSubscriptionCountLocked()))
}

func (m *WebSocketManager) clearClientMarketSubscriptions(client *streamClient) {
	if client == nil {
		return
	}

	m.MarketSubMu.Lock()
	defer m.MarketSubMu.Unlock()

	m.MarketWsMu.RLock()
	conn := m.MarketWsConn
	m.MarketWsMu.RUnlock()

	writeSub := stopAfterMarketSubscriptionWriteFailure(func(method string, fields map[string]interface{}) bool {
		return m.writeMarketSubscription(conn, method, fields)
	})

	client.mu.Lock()
	previous := cloneMarketSubscriptionState(client.market)
	client.market = marketSubscriptionState{}
	client.mu.Unlock()

	m.updateMarketSubscriptionRefs(previous, marketSubscriptionState{}, writeSub)
	m.recordMarketSubscriptionMetricsLocked()
	// Demote the cleared state to pending so a same-clientId reconnect can
	// restore it even if the frontend's re-subscribe POST never arrives. When
	// previous is empty this client was already cleared (stale-client deferred
	// cleanup); leave pending alone so a racing reconnect's entry survives.
	if client.id != "" && !previous.isEmpty() {
		now := time.Now()
		m.prunePendingMarketSubsLocked(now)
		m.PendingMarketSubs[client.id] = pendingMarketSub{state: previous, storedAt: now}
		log.Printf("market subscription demoted to pending: clientId=%s coin=%s interval=%s", client.id, previous.Coin, previous.Interval)
	}
}

// pendingMarketSubTTL bounds how long disconnected-client intent is kept. The
// frontend re-subscribes on every fresh socket, so pending only needs to cover
// a quick reconnect whose POST was lost; expiring keeps the map from
// accumulating entries for tabs that never return.
const pendingMarketSubTTL = 10 * time.Minute

// pendingRestoreGrace is how long a reconnect waits before applying a demoted
// subscription. Healthy tabs re-POST intent within tens of milliseconds; the
// grace lets that POST win and avoids the demoted restore + client POST pair
// flipping ref-counts twice (visible in logs as tradeCoins thrash on lid-wake).
// Overridable in tests.
var pendingRestoreGrace = 500 * time.Millisecond

// prunePendingMarketSubsLocked drops expired pending entries. The caller must
// hold MarketSubMu.
func (m *WebSocketManager) prunePendingMarketSubsLocked(now time.Time) {
	for id, pending := range m.PendingMarketSubs {
		if now.Sub(pending.storedAt) > pendingMarketSubTTL {
			delete(m.PendingMarketSubs, id)
		}
	}
}

// schedulePendingMarketSubscription restores demoted intent only if the client
// does not re-subscribe within pendingRestoreGrace. Direct applyPendingMarketSubscription
// remains available for tests and explicit callers.
// The returned channel is closed after the grace wait and apply attempt finish
// (including no-op paths). Callers may ignore it; tests use it to avoid
// lock-free reads of manager state while the restore goroutine is still live.
func (m *WebSocketManager) schedulePendingMarketSubscription(client *streamClient) <-chan struct{} {
	done := make(chan struct{})
	if client == nil || client.id == "" {
		close(done)
		return done
	}
	grace := pendingRestoreGrace
	if grace < 0 {
		grace = 0
	}
	go func() {
		defer close(done)
		if grace > 0 {
			timer := time.NewTimer(grace)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-client.doneCh:
				return
			}
		}
		m.applyPendingMarketSubscription(client)
	}()
	return done
}

func (m *WebSocketManager) applyPendingMarketSubscription(client *streamClient) {
	if client == nil || client.id == "" {
		return
	}

	// Lookup and apply under one lock acquisition so a fresh subscribe POST
	// racing this restore is deterministic: whichever runs second sees the
	// other's effect (the locked apply deletes the pending entry).
	m.MarketSubMu.Lock()
	defer m.MarketSubMu.Unlock()

	pending, ok := m.PendingMarketSubs[client.id]
	if !ok {
		return
	}

	if client.closed {
		return
	}

	// A live POST already populated this client — drop the stale pending entry
	// instead of overwriting fresher intent (can happen if the grace timer
	// fires just after a successful re-subscribe).
	client.mu.Lock()
	alreadySet := !client.market.isEmpty()
	client.mu.Unlock()
	if alreadySet {
		delete(m.PendingMarketSubs, client.id)
		return
	}

	tradeCoins := make([]string, 0, len(pending.state.TradeCoins))
	for coin := range pending.state.TradeCoins {
		tradeCoins = append(tradeCoins, coin)
	}
	m.applyClientMarketSubscriptionsLocked(client, pending.state.Coin, pending.state.Interval, tradeCoins, mapKeys(pending.state.IndicatorIntervals))
}

// updateMarketSubscriptionRefs ref-counts book depth the same way it already
// ref-counts trades: against the whole TradeCoins set, not just the single
// active Coin. TradeCoins always includes the active coin (see
// buildMarketSubscriptionState), so this preserves book delivery for the
// active coin while also keeping it live in the background for
// watchlist/tracked coins, matching trades.
func (m *WebSocketManager) updateMarketSubscriptionRefs(previous, next marketSubscriptionState, writeSub func(string, map[string]interface{})) {
	previousCandles := chartCandleRefSet(previous.Coin, previous.Interval, mapKeys(previous.IndicatorIntervals))
	nextCandles := chartCandleRefSet(next.Coin, next.Interval, mapKeys(next.IndicatorIntervals))
	for key := range previousCandles {
		if nextCandles[key] {
			continue
		}
		if coin, interval, ok := splitCandleKey(key); ok {
			m.decrementCandleRef(coin, interval, writeSub)
		}
	}
	for coin := range previous.TradeCoins {
		if !next.TradeCoins[coin] {
			m.decrementTradeRef(coin, writeSub)
			m.decrementBookRef(coin, writeSub)
		}
	}

	for key := range nextCandles {
		if previousCandles[key] {
			continue
		}
		if coin, interval, ok := splitCandleKey(key); ok {
			m.incrementCandleRef(coin, interval, writeSub)
		}
	}
	for coin := range next.TradeCoins {
		if !previous.TradeCoins[coin] {
			m.incrementTradeRef(coin, writeSub)
			m.incrementBookRef(coin, writeSub)
		}
	}
}

func (m *WebSocketManager) MarketSubscribeHandler(c *gin.Context) {
	var req struct {
		ClientID           string   `json:"clientId"`
		Coin               string   `json:"coin"`
		Interval           string   `json:"interval"`
		TradeCoins         []string `json:"tradeCoins"`
		IndicatorIntervals []string `json:"indicatorIntervals"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if strings.TrimSpace(req.ClientID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "clientId required"})
		return
	}
	if len(req.ClientID) > 128 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "clientId too long"})
		return
	}
	indicatorIntervals, valid := normalizeIndicatorIntervals(req.Interval, req.IndicatorIntervals)
	if !valid {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid indicatorIntervals"})
		return
	}
	result := m.UpdateMarketSubscriptionsWithIndicators(req.ClientID, req.Coin, req.Interval, req.TradeCoins, indicatorIntervals)
	if result.Rejected {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "market subscription capacity reached"})
		return
	}
	if result.Pending {
		log.Printf("market subscription pending: clientId=%s coin=%s interval=%s requested=%d", req.ClientID, req.Coin, req.Interval, len(req.TradeCoins))
	}
	snapshotCoins := result.AddedTradeCoins
	if result.Pending || m.consumeMarketSnapshotNeed(req.ClientID) {
		snapshotCoins = result.AcceptedTradeCoins
	}
	flowSnapshots := make(map[string]interface{}, len(snapshotCoins))
	for _, coin := range snapshotCoins {
		flowSnapshots[coin] = m.flowSnapshotPayload(coin)
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":                 true,
		"acceptedTradeCoins": result.AcceptedTradeCoins,
		"droppedTradeCoins":  result.DroppedTradeCoins,
		"flowSnapshots":      flowSnapshots,
		"pending":            result.Pending,
	})
}

// consumeMarketSnapshotNeed returns true exactly once for each replacement
// downstream socket. Pending intent may already have restored identical refs
// before the browser's first POST; that first response must still hydrate every
// flow cache, while later idempotent/reordered POSTs need no bulk replay.
func (m *WebSocketManager) consumeMarketSnapshotNeed(clientID string) bool {
	m.StreamMu.RLock()
	defer m.StreamMu.RUnlock()
	for client := range m.streamClients {
		if !client.kind.acceptsMarket() || client.id != clientID {
			continue
		}
		client.mu.Lock()
		needed := !client.marketSnapshotSent
		client.marketSnapshotSent = true
		client.mu.Unlock()
		return needed
	}
	return true
}

func buildMarketSubscriptionState(coin, interval string, tradeCoins []string, indicatorIntervals ...[]string) marketSubscriptionState {
	var indicators []string
	if len(indicatorIntervals) > 0 {
		indicators = indicatorIntervals[0]
	}
	state := marketSubscriptionState{
		Coin:               strings.TrimSpace(coin),
		Interval:           strings.TrimSpace(interval),
		TradeCoins:         make(map[string]bool, len(tradeCoins)+1),
		IndicatorIntervals: make(map[string]bool, len(indicators)),
	}
	for _, tradeCoin := range tradeCoins {
		tradeCoin = strings.TrimSpace(tradeCoin)
		if tradeCoin == "" {
			continue
		}
		state.TradeCoins[tradeCoin] = true
	}
	// Book ref-counting now rides on TradeCoins (see updateMarketSubscriptionRefs),
	// so force the active coin in here too rather than relying solely on
	// callers always including it in tradeCoins.
	if state.Coin != "" {
		state.TradeCoins[state.Coin] = true
	}
	for _, indicatorInterval := range indicators {
		if indicatorInterval = strings.TrimSpace(indicatorInterval); indicatorInterval != "" {
			state.IndicatorIntervals[indicatorInterval] = true
		}
	}
	return state
}

func marketSubscriptionStatesEqual(left, right marketSubscriptionState) bool {
	if left.Coin != right.Coin || left.Interval != right.Interval ||
		len(left.TradeCoins) != len(right.TradeCoins) ||
		len(left.IndicatorIntervals) != len(right.IndicatorIntervals) {
		return false
	}
	for coin := range left.TradeCoins {
		if !right.TradeCoins[coin] {
			return false
		}
	}
	for interval := range left.IndicatorIntervals {
		if !right.IndicatorIntervals[interval] {
			return false
		}
	}
	return true
}

func orderedStateCoins(activeCoin string, requested []string, state map[string]bool) []string {
	seen := make(map[string]bool, len(state))
	ordered := make([]string, 0, len(state))
	add := func(coin string) {
		coin = strings.TrimSpace(coin)
		if coin == "" || seen[coin] || !state[coin] {
			return
		}
		seen[coin] = true
		ordered = append(ordered, coin)
	}
	add(activeCoin)
	for _, coin := range requested {
		add(coin)
	}
	// Defensive only: a restored state can contain a coin no longer present in
	// the submitted ordering. Keep the response complete and deterministic.
	remaining := make([]string, 0, len(state)-len(ordered))
	for coin := range state {
		if !seen[coin] {
			remaining = append(remaining, coin)
		}
	}
	sort.Strings(remaining)
	return append(ordered, remaining...)
}

func addedMarketTradeCoins(previous, next marketSubscriptionState) []string {
	added := make([]string, 0)
	for coin := range next.TradeCoins {
		if !previous.TradeCoins[coin] {
			added = append(added, coin)
		}
	}
	sort.Strings(added)
	return added
}

func normalizeIndicatorIntervals(timeframe string, intervals []string) ([]string, bool) {
	if len(intervals) == 0 {
		return nil, true
	}
	if len(intervals) > 1 {
		return nil, false
	}
	source, ok := chartrequirements.RvwapSourceForTimeframe(strings.TrimSpace(timeframe))
	if !ok {
		return nil, false
	}
	seen := make(map[string]bool, 1)
	normalized := make([]string, 0, 1)
	for _, interval := range intervals {
		interval = strings.TrimSpace(interval)
		if interval == "" || interval != source.Interval {
			return nil, false
		}
		if !seen[interval] {
			seen[interval] = true
			normalized = append(normalized, interval)
		}
	}
	return normalized, len(normalized) <= 1
}

func mapKeys(values map[string]bool) []string {
	out := make([]string, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	return out
}

func cloneMarketSubscriptionState(state marketSubscriptionState) marketSubscriptionState {
	cloned := marketSubscriptionState{
		Coin:               state.Coin,
		Interval:           state.Interval,
		TradeCoins:         make(map[string]bool, len(state.TradeCoins)),
		IndicatorIntervals: make(map[string]bool, len(state.IndicatorIntervals)),
	}
	for coin := range state.TradeCoins {
		cloned.TradeCoins[coin] = true
	}
	for interval := range state.IndicatorIntervals {
		cloned.IndicatorIntervals[interval] = true
	}
	return cloned
}

func marketSubscriptionPayload(channel, coin, interval string) map[string]interface{} {
	sub := map[string]interface{}{"type": channel, "coin": coin}
	if interval != "" {
		sub["interval"] = interval
	}
	// Official l2Book / trades / candle take the HIP-3 coin prefix only.
	// allMids is the subscription that documents a dex field, and that path
	// is built separately in StartMarketWebSocket.
	return sub
}

func candleRefKey(coin, interval string) string {
	return coin + "|" + interval
}

// chartCandleRefSet returns every candle feed a visible chart requires. The
// primary interval drives price candles; the 5m/30m pair drives the backend's
// composite anchored-CVD deltas. Client-held source refs sit outside the
// cache-owned 64-feed cap, so the currently visible chart can never lose CVD
// freshness merely because a large historical snapshot restored first.
func chartCandleRefSet(coin, interval string, indicatorIntervals ...[]string) map[string]bool {
	refs := make(map[string]bool, 4)
	coin = strings.TrimSpace(coin)
	interval = strings.TrimSpace(interval)
	if coin == "" || interval == "" {
		return refs
	}
	refs[candleRefKey(coin, interval)] = true
	if requirement, ok := chartrequirements.ForTimeframe(interval); ok {
		for _, source := range requirement.CvdSources {
			refs[candleRefKey(coin, source.Interval)] = true
		}
	}
	if len(indicatorIntervals) > 0 {
		for _, sourceInterval := range indicatorIntervals[0] {
			if sourceInterval != "" {
				refs[candleRefKey(coin, sourceInterval)] = true
			}
		}
	}
	return refs
}

// ActiveCandleSeries returns a snapshot of the (coin, interval) candle series
// currently subscribed by connected clients — i.e. the charts users are viewing
// right now. The warm coordinator warms these first so a freshly selected chart
// jumps to the front of the warm-up line and is servable soonest at cold start.
func (m *WebSocketManager) ActiveCandleSeries() [][2]string {
	m.MarketSubMu.Lock()
	defer m.MarketSubMu.Unlock()
	if len(m.MarketCandleRefs) == 0 {
		return nil
	}
	out := make([][2]string, 0, len(m.MarketCandleRefs))
	for key, ref := range m.MarketCandleRefs {
		// Refs held only by the candle store's permanent subscriptions are not
		// "active": no client is viewing them. Without this exclusion the warm
		// coordinator's Tier 0 would treat the store's whole warmed universe as
		// actively viewed and grind it (plus its CVD-source expansion) ahead of
		// the ordered tiers.
		if ref-m.PermanentCandleRefs[key] <= 0 {
			continue
		}
		if coin, interval, ok := splitCandleKey(key); ok {
			out = append(out, [2]string{coin, interval})
		}
	}
	return out
}

func splitCandleKey(key string) (string, string, bool) {
	parts := strings.SplitN(key, "|", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (m *WebSocketManager) incrementBookRef(coin string, writeSub func(string, map[string]interface{})) {
	if coin == "" {
		return
	}
	m.MarketBookRefs[coin]++
	if m.MarketBookRefs[coin] == 1 {
		writeSub("subscribe", marketSubscriptionPayload("l2Book", coin, ""))
	}
}

func (m *WebSocketManager) decrementBookRef(coin string, writeSub func(string, map[string]interface{})) {
	if coin == "" || m.MarketBookRefs[coin] <= 0 {
		return
	}
	m.MarketBookRefs[coin]--
	if m.MarketBookRefs[coin] <= 0 {
		delete(m.MarketBookRefs, coin)
		writeSub("unsubscribe", marketSubscriptionPayload("l2Book", coin, ""))
	}
}

func (m *WebSocketManager) incrementCandleRef(coin, interval string, writeSub func(string, map[string]interface{})) {
	if coin == "" || interval == "" {
		return
	}
	key := candleRefKey(coin, interval)
	m.MarketCandleRefs[key]++
	if m.MarketCandleRefs[key] == 1 {
		writeSub("subscribe", marketSubscriptionPayload("candle", coin, interval))
	}
}

func (m *WebSocketManager) decrementCandleRef(coin, interval string, writeSub func(string, map[string]interface{})) {
	if coin == "" || interval == "" {
		return
	}
	key := candleRefKey(coin, interval)
	if m.MarketCandleRefs[key] <= 0 {
		return
	}
	m.MarketCandleRefs[key]--
	if m.MarketCandleRefs[key] <= 0 {
		delete(m.MarketCandleRefs, key)
		writeSub("unsubscribe", marketSubscriptionPayload("candle", coin, interval))
		m.notifyCandleFeedDropped(coin, interval)
	}
}

func (m *WebSocketManager) incrementTradeRef(coin string, writeSub func(string, map[string]interface{})) {
	if coin == "" {
		return
	}
	m.MarketTradeRefs[coin]++
	if m.MarketTradeRefs[coin] == 1 {
		// Arm an empty window so the first live print can land, and so a
		// post-unsubscribe trades frame cannot recreate a deleted cache.
		m.armCoinFlow(coin)
		writeSub("subscribe", marketSubscriptionPayload("trades", coin, ""))
	}
}

func (m *WebSocketManager) decrementTradeRef(coin string, writeSub func(string, map[string]interface{})) {
	if coin == "" || m.MarketTradeRefs[coin] <= 0 {
		return
	}
	m.MarketTradeRefs[coin]--
	if m.MarketTradeRefs[coin] <= 0 {
		delete(m.MarketTradeRefs, coin)
		m.clearCoinFlow(coin)
		writeSub("unsubscribe", marketSubscriptionPayload("trades", coin, ""))
	}
}

func countTradeRefsForCoins(refs map[string]int, tradeCoins map[string]bool) int {
	total := 0
	for coin := range tradeCoins {
		total += refs[coin]
	}
	return total
}

// runMarketKeepalive sends application-level pings on one upstream market
// connection until that connection is replaced or the manager stops. Writes
// serialize under MarketSubMu like every other market subscription write.
func (m *WebSocketManager) runMarketKeepalive(conn *websocket.Conn) {
	ticker := time.NewTicker(upstreamPingInterval)
	defer ticker.Stop()
	lastTickWallMs := time.Now().UnixMilli()
	for {
		select {
		case <-m.MarketStopCh:
			return
		case <-ticker.C:
		}

		nowWallMs := time.Now().UnixMilli()
		m.MarketWsMu.RLock()
		current := m.MarketWsConn
		m.MarketWsMu.RUnlock()
		ownsConn := current == conn
		// Ping interval is 30s, same as wakeGapThreshold, so a late tick is
		// sleep only when it missed the interval AND the lid-close gap.
		// Replaced keepalives also fire after Darwin sleep; they must exit
		// without cycling the socket that already replaced them.
		if marketKeepaliveShouldCycle(ownsConn, lastTickWallMs, nowWallMs) {
			gap := (time.Duration(nowWallMs-lastTickWallMs) * time.Millisecond).Round(time.Second)
			if m.closeAllUpstreamsForWake() {
				log.Printf("WARNING: market keepalive tick arrived %s late — assuming system wake; cycling upstream sockets", gap)
			}
			return
		}
		if !ownsConn {
			return
		}
		lastTickWallMs = nowWallMs

		m.MarketSubMu.Lock()
		conn.SetWriteDeadline(time.Now().Add(upstreamWriteTimeout))
		err := conn.WriteJSON(map[string]interface{}{"method": "ping"})
		m.MarketSubMu.Unlock()
		if err != nil {
			log.Printf("Market WebSocket keepalive write failed: %v", err)
			m.markMarketSocketDegraded(conn)
			return
		}
	}
}

func (m *WebSocketManager) writeMarketSubscription(conn *websocket.Conn, method string, fields map[string]interface{}) bool {
	if conn == nil {
		return true
	}
	conn.SetWriteDeadline(time.Now().Add(upstreamWriteTimeout))
	if err := conn.WriteJSON(map[string]interface{}{"method": method, "subscription": fields}); err != nil {
		log.Printf("market subscription write failed: method=%s subscription=%v err=%v", method, fields, err)
		m.markMarketSocketDegraded(conn)
		return false
	}
	return true
}

func stopAfterMarketSubscriptionWriteFailure(write func(string, map[string]interface{}) bool) func(string, map[string]interface{}) {
	failed := false
	return func(method string, fields map[string]interface{}) {
		if failed {
			return
		}
		failed = !write(method, fields)
	}
}

func (m *WebSocketManager) markMarketSocketDegraded(conn *websocket.Conn) {
	if conn == nil {
		return
	}
	m.MarketWsMu.Lock()
	closed := m.MarketWsConn == conn
	if closed {
		_ = m.MarketWsConn.Close()
		m.MarketWsConn = nil
	}
	m.MarketWsMu.Unlock()
	if closed && m.candleSink != nil {
		m.candleSink.OnMarketWSDown()
	}
	if closed {
		m.broadcastUpstreamStatus(false)
	}
}

func (m *WebSocketManager) broadcastUpstreamStatus(connected bool) {
	payload, err := json.Marshal(map[string]interface{}{
		"type":      "upstream",
		"connected": connected,
		"time":      time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return
	}
	m.BroadcastMarket(payload)
}

// AddPermanentCandleSubscriptions registers candle subscriptions held on the
// candle store's behalf: the refs keep the upstream subscriptions alive
// across client churn, and reapplySubscriptions restores them on every
// reconnect. The set is deliberately capped independently of historical cache
// residency; active browser charts use client refs and always outrank it.
// Released when the store evicts a series as idle.
func (m *WebSocketManager) AddPermanentCandleSubscriptions(pairs [][2]string) {
	m.MarketSubMu.Lock()
	defer m.MarketSubMu.Unlock()

	m.MarketWsMu.RLock()
	conn := m.MarketWsConn
	m.MarketWsMu.RUnlock()

	writeSub := stopAfterMarketSubscriptionWriteFailure(func(method string, fields map[string]interface{}) bool {
		return m.writeMarketSubscription(conn, method, fields)
	})
	for _, pair := range pairs {
		key := candleRefKey(pair[0], pair[1])
		isNewPermanent := m.PermanentCandleRefs[key] == 0
		permanentAtCapacity := isNewPermanent && len(m.PermanentCandleRefs) >= maxPermanentCandleSubscriptions
		upstreamAtCapacity := m.MarketCandleRefs[key] == 0 && m.marketSubscriptionCountLocked() >= maxMarketSubscriptions
		if permanentAtCapacity || upstreamAtCapacity {
			if !m.permanentCandleLimitWarned {
				log.Printf("permanent candle live-feed cap reached (%d); remaining cached series will refresh on demand", maxPermanentCandleSubscriptions)
				m.permanentCandleLimitWarned = true
			}
			m.notifyCandleFeedDropped(pair[0], pair[1])
			continue
		}
		m.PermanentCandleRefs[key]++
		m.incrementCandleRef(pair[0], pair[1], writeSub)
	}
	m.recordMarketSubscriptionMetricsLocked()
}

// RemovePermanentCandleSubscriptions releases the candle store's permanent
// refs for evicted series. It drains ALL permanent refs for each key rather
// than decrementing once: concurrent on-demand registrations can double-fire
// onRegister for the same series, and a leftover ref would keep the upstream
// subscription alive forever. Client-held refs are untouched —
// decrementCandleRef only writes the upstream unsubscribe when the total ref
// count reaches zero, so a chart a browser is viewing keeps its feed.
func (m *WebSocketManager) RemovePermanentCandleSubscriptions(pairs [][2]string) {
	m.MarketSubMu.Lock()
	defer m.MarketSubMu.Unlock()

	m.MarketWsMu.RLock()
	conn := m.MarketWsConn
	m.MarketWsMu.RUnlock()

	writeSub := stopAfterMarketSubscriptionWriteFailure(func(method string, fields map[string]interface{}) bool {
		return m.writeMarketSubscription(conn, method, fields)
	})
	for _, pair := range pairs {
		key := candleRefKey(pair[0], pair[1])
		for m.PermanentCandleRefs[key] > 0 {
			m.PermanentCandleRefs[key]--
			m.decrementCandleRef(pair[0], pair[1], writeSub)
		}
		delete(m.PermanentCandleRefs, key)
	}
	m.recordMarketSubscriptionMetricsLocked()
}

func marketDataCoin(data json.RawMessage) string {
	if len(data) == 0 {
		return ""
	}
	if data[0] == '[' {
		var trades []marketCoinWire
		if err := json.Unmarshal(data, &trades); err != nil || len(trades) == 0 {
			return ""
		}
		if trades[0].Coin != "" {
			return trades[0].Coin
		}
		return trades[0].S
	}
	var payload marketCoinWire
	if err := json.Unmarshal(data, &payload); err != nil {
		return ""
	}
	if payload.Coin != "" {
		return payload.Coin
	}
	return payload.S
}

func marketRouteMessage(channel, coin string) map[string]interface{} {
	return map[string]interface{}{
		"channel": channel,
		"coin":    coin,
		"data":    map[string]interface{}{"coin": coin},
	}
}

func (m *WebSocketManager) BroadcastMarketMessage(channel string, wsMsg map[string]interface{}, raw []byte) {
	msgCoin, msgInterval := extractMarketMessageCoinAndInterval(channel, wsMsg)
	if msgCoin == "" {
		return
	}

	m.StreamMu.RLock()
	clients := make([]*streamClient, 0, len(m.streamClients))
	for client := range m.streamClients {
		if client.kind.acceptsMarket() && clientWantsMarketMessageFast(client, channel, msgCoin, msgInterval) {
			clients = append(clients, client)
		}
	}
	m.StreamMu.RUnlock()

	if len(clients) == 0 {
		return
	}

	for _, client := range clients {
		m.sendRawToClient(client, raw)
	}
}

func extractMarketMessageCoinAndInterval(channel string, wsMsg map[string]interface{}) (string, string) {
	switch channel {
	case "candle":
		return marketMessageCoinAndInterval(wsMsg)
	case "l2Book", "trades":
		return marketMessageCoin(wsMsg), ""
	default:
		return marketMessageCoin(wsMsg), ""
	}
}

func clientWantsMarketMessageFast(client *streamClient, channel, msgCoin, msgInterval string) bool {
	if client == nil || msgCoin == "" {
		return false
	}

	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return false
	}
	coin := client.market.Coin
	interval := client.market.Interval
	tradeCoins := client.market.TradeCoins
	indicatorIntervals := client.market.IndicatorIntervals
	client.mu.Unlock()

	switch channel {
	case "l2Book":
		// Book rides along on tradeCoins for background watchlist/tracked
		// coins (see updateMarketSubscriptionRefs), so a client must receive
		// l2Book ticks for any of those, not just the single active coin.
		return (coin != "" && msgCoin == coin) || tradeCoins[msgCoin]
	case "candle":
		return coin != "" && interval != "" && msgCoin == coin &&
			(msgInterval == interval || indicatorIntervals[msgInterval])
	case "trades":
		return tradeCoins[msgCoin]
	default:
		return false
	}
}

func clientWantsMarketMessage(client *streamClient, channel string, wsMsg map[string]interface{}) bool {
	msgCoin, msgInterval := extractMarketMessageCoinAndInterval(channel, wsMsg)
	return clientWantsMarketMessageFast(client, channel, msgCoin, msgInterval)
}

func marketMessageCoin(wsMsg map[string]interface{}) string {
	if coin, _ := wsMsg["coin"].(string); coin != "" {
		return coin
	}
	data, _ := wsMsg["data"].(map[string]interface{})
	if coin, _ := data["coin"].(string); coin != "" {
		return coin
	}
	if coin, _ := data["s"].(string); coin != "" {
		return coin
	}
	if arr, ok := wsMsg["data"].([]interface{}); ok && len(arr) > 0 {
		if first, ok := arr[0].(map[string]interface{}); ok {
			if coin, _ := first["coin"].(string); coin != "" {
				return coin
			}
			if coin, _ := first["s"].(string); coin != "" {
				return coin
			}
		}
	}
	return ""
}

func marketMessageCoinAndInterval(wsMsg map[string]interface{}) (string, string) {
	coin := marketMessageCoin(wsMsg)
	if interval, _ := wsMsg["interval"].(string); interval != "" {
		return coin, interval
	}
	data, _ := wsMsg["data"].(map[string]interface{})
	if interval, _ := data["interval"].(string); interval != "" {
		return coin, interval
	}
	if interval, _ := data["i"].(string); interval != "" {
		return coin, interval
	}
	if candle, ok := data["candle"].(map[string]interface{}); ok {
		if interval, _ := candle["i"].(string); interval != "" {
			if symbol, _ := candle["s"].(string); symbol != "" {
				coin = symbol
			}
			return coin, interval
		}
	}
	return coin, ""
}

func (m *WebSocketManager) StopMarketWebSocket() {
	close(m.MarketStopCh)
	<-m.MarketDoneCh

	m.MarketWsMu.Lock()
	if m.MarketWsConn != nil {
		m.MarketWsConn.Close()
		m.MarketWsConn = nil
	}
	m.MarketWsMu.Unlock()
}
