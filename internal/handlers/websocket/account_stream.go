package websocket

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"hyperliquid-go/internal/services"
)

// RequestAccountRefresh fetches an authoritative account snapshot after an
// execution event and broadcasts it on webData2. This is the fast repair path
// for Portfolio/Available when Hyperliquid's aggregate user stream is alive
// but omits clearinghouseState. Calls are coalesced per account; an event that
// arrives during a fetch marks it dirty and guarantees one final follow-up.
func (m *WebSocketManager) RequestAccountRefresh(account string) {
	account = normalizeAccountAddress(account)
	if account == "" || m.accountFetcher == nil {
		return
	}

	m.accountRefreshMu.Lock()
	if m.accountRefreshRunning[account] {
		m.accountRefreshDirty[account] = true
		m.accountRefreshMu.Unlock()
		return
	}
	m.accountRefreshRunning[account] = true
	m.accountRefreshMu.Unlock()

	go func() {
		defer func() {
			m.accountRefreshMu.Lock()
			delete(m.accountRefreshRunning, account)
			delete(m.accountRefreshDirty, account)
			m.accountRefreshMu.Unlock()
		}()
		for {
			// Collapse the order-response/order-update/user-fill burst from one
			// exchange action into a single upstream account request.
			timer := time.NewTimer(50 * time.Millisecond)
			select {
			case <-timer.C:
			case <-m.lifecycleCtx.Done():
				timer.Stop()
				return
			}
			snapshotRequestedAt := time.Now().UnixMilli()
			ctx, cancel := context.WithTimeout(m.lifecycleCtx, 20*time.Second)
			var state map[string]interface{}
			var err error
			if freshFetcher, ok := m.accountFetcher.(interface {
				GetAccountFresh(context.Context, string) (map[string]interface{}, error)
			}); ok {
				state, err = freshFetcher.GetAccountFresh(ctx, account)
			} else {
				state, err = m.accountFetcher.GetAccount(ctx, account)
			}
			cancel()
			if err == nil && state != nil {
				state = services.NormalizeAccountState(state)
				state["accountSnapshotAt"] = snapshotRequestedAt
				state["accountSnapshotStale"] = false
				payload := map[string]interface{}{"channel": "webData2", "data": state}
				if encoded, marshalErr := json.Marshal(payload); marshalErr == nil {
					m.BroadcastToAccount(account, encoded)
				}
			}

			m.accountRefreshMu.Lock()
			if m.accountRefreshDirty[account] {
				m.accountRefreshDirty[account] = false
				m.accountRefreshMu.Unlock()
				continue
			}
			m.accountRefreshMu.Unlock()
			return
		}
	}()
}

// midsSnapshotMaxAge bounds how old a cached price may be and still be sent to
// a freshly connected client. Routine reconnects see a ~1s-old cache and get
// everything; right after a server wake the pre-sleep prices are excluded and
// paint a couple of seconds later when the upstream stream recovers.
const midsSnapshotMaxAge = 60 * time.Second

// buildMidsSnapshot renders the BBO cache as an allMids-shaped mids map so a
// (re)connecting client paints prices immediately instead of waiting for the
// next upstream allMids push.
func (m *WebSocketManager) buildMidsSnapshot(maxAge time.Duration) map[string]interface{} {
	if !m.IsMarketConnected() {
		return map[string]interface{}{}
	}
	nowMs := time.Now().UnixMilli()
	maxAgeMs := maxAge.Milliseconds()
	mids := make(map[string]interface{})
	m.BBOCacheMu.RLock()
	for coin, entry := range m.BBOCache {
		mid := (entry.Bid + entry.Ask) / 2
		if mid <= 0 {
			continue
		}
		// UnixMilli is wall-clock. time.Sub would use the monotonic clock,
		// which pauses during Darwin sleep and would replay pre-sleep mids.
		if nowMs-entry.Time.UnixMilli() > maxAgeMs {
			continue
		}
		mids[coin] = strconv.FormatFloat(mid, 'f', -1, 64)
	}
	m.BBOCacheMu.RUnlock()
	return mids
}

// TradingStreamHandler serves the correctness-sensitive account/order/fill
// lane. It never receives market frames and never owns market subscription
// state, so a slow chart client cannot fill this client's send queue.
func (m *WebSocketManager) TradingStreamHandler(c *gin.Context) {
	m.streamHandler(c, tradingStream)
}

// MarketStreamHandler serves mids/books/trades/candles/liquidations only.
// Account snapshots and execution events are deliberately excluded.
func (m *WebSocketManager) MarketStreamHandler(c *gin.Context) {
	m.streamHandler(c, marketStream)
}

func (m *WebSocketManager) streamHandler(c *gin.Context, kind streamKind) {
	if !m.authorizeStreamRequest(c.Request) {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized websocket"})
		return
	}

	requestedAccount := normalizeAccountAddress(c.Query("account"))
	if kind.acceptsTrading() {
		if requestedAccount == "" {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "trading stream account is required"})
			return
		}
		m.UserWsMu.Lock()
		activeAccount := normalizeAccountAddress(m.UserAccountAddr)
		m.UserWsMu.Unlock()
		if activeAccount != "" && requestedAccount != activeAccount {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "trading stream account does not match active session"})
			return
		}
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return m.isOriginAllowed(r)
		},
	}
	if protocol := m.streamTokenProtocol(); protocol != "" {
		upgrader.Subprotocols = []string{protocol}
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	client := &streamClient{
		conn:    conn,
		id:      strings.TrimSpace(c.Query("clientId")),
		account: requestedAccount,
		kind:    kind,
		closed:  false,
		sendCh:  make(chan []byte, streamQueueCapacityFor(kind)),
		doneCh:  make(chan struct{}),
	}

	count := m.registerStreamClient(client)
	m.startClientWriter(client)

	log.Printf("%s stream client connected (count=%d, ip=%s)", kind.logName(), count, c.ClientIP())
	if kind.acceptsMarket() {
		// Delay restore so a healthy client's immediate re-subscribe POST wins
		// without an intermediate demoted-state apply (see pendingRestoreGrace).
		m.schedulePendingMarketSubscription(client)
	}
	conn.SetReadLimit(1 << 20)
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	var disconnectErr error
	defer func() {
		if kind.acceptsMarket() {
			m.clearClientMarketSubscriptions(client)
		}
		m.StreamMu.Lock()
		delete(m.streamClients, client)
		count = len(m.streamClients)
		m.recordDownstreamClientMetricsLocked()
		m.StreamMu.Unlock()
		m.closeStreamClient(client)
		if closeErr, ok := disconnectErr.(*websocket.CloseError); ok {
			log.Printf("%s stream client close received: code=%d reason=%q", kind.logName(), closeErr.Code, closeErr.Text)
		} else if disconnectErr != nil {
			log.Printf("%s stream client read ended: %v", kind.logName(), disconnectErr)
		}
		log.Printf("%s stream client disconnected (count=%d)", kind.logName(), count)
	}()

	if kind.acceptsMarket() {
		if mids := m.buildMidsSnapshot(midsSnapshotMaxAge); len(mids) > 0 {
			m.sendToClient(client, map[string]interface{}{
				"channel": "allMids",
				"data":    map[string]interface{}{"mids": mids, "snapshot": true},
			})
		}
	}

	m.UserWsMu.Lock()
	userAddr := client.account
	if userAddr == "" {
		userAddr = m.UserAccountAddr
	}
	m.UserWsMu.Unlock()

	if kind.acceptsTrading() && userAddr != "" && m.accountFetcher != nil {
		state, err := m.accountFetcher.GetAccount(c.Request.Context(), userAddr)
		if err == nil && state != nil {
			state = services.NormalizeAccountState(state)
			state["accountSnapshotAt"] = time.Now().UnixMilli()
			state["accountSnapshotStale"] = false
			var orders []interface{}
			var runtimeSnapshot services.AccountRuntimeSnapshot
			if m.accountRuntime != nil {
				runtimeSnapshot = m.accountRuntime.GetSnapshot(userAddr)
				if runtimeSnapshot.HasSnapshot {
					orders = runtimeSnapshot.Orders
				}
			}
			if orders == nil {
				orders, _ = m.accountFetcher.GetOpenOrders(c.Request.Context(), userAddr)
				if m.accountRuntime != nil {
					runtimeSnapshot = m.accountRuntime.UpdateOrdersFromSnapshot(userAddr, orders, true)
					orders = runtimeSnapshot.Orders
				}
			}
			if orders == nil {
				orders = []interface{}{}
			}

			initialData := map[string]interface{}{
				"type":    "initialState",
				"channel": "webData2",
				"data": map[string]interface{}{
					"orders":               orders,
					"orderRevision":        runtimeSnapshot.Revision,
					"ordersFresh":          runtimeSnapshot.OrderFresh,
					"assetPositions":       state["assetPositions"],
					"marginSummary":        state["marginSummary"],
					"crossMarginSummary":   state["crossMarginSummary"],
					"withdrawable":         state["withdrawable"],
					"spotState":            state["spotState"],
					"riskSummary":          state["riskSummary"],
					"riskSummaryFresh":     state["riskSummaryFresh"],
					"builderDexFreshness":  state["builderDexFreshness"],
					"accountSnapshotAt":    state["accountSnapshotAt"],
					"accountSnapshotStale": state["accountSnapshotStale"],
				},
			}
			m.sendToClient(client, initialData)
			if debugLogsEnabled() {
				log.Printf("stream: sent initial account state for %s", userAddr[:10]+"...")
			}
		}
	}

	if kind.acceptsTrading() && m.botService != nil {
		status := m.botService.Status()
		if status.Running && (status.Account == "" || client.account == "" || normalizeAccountAddress(status.Account) == client.account) {
			m.sendToClient(client, map[string]interface{}{
				"channel": "botStatus",
				"data":    status,
			})
		}
	}

	disconnectCh := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				disconnectCh <- err
				return
			}
		}
	}()

	pingTicker := time.NewTicker(15 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			return
		case disconnectErr = <-disconnectCh:
			return
		case <-pingTicker.C:
			client.mu.Lock()
			if !client.closed && client.conn != nil {
				_ = client.conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second))
			}
			client.mu.Unlock()
		}
	}
}

const streamTokenProtocolPrefix = "pez-token."

func (m *WebSocketManager) streamTokenProtocol() string {
	if m.apiToken == "" {
		return ""
	}
	return streamTokenProtocolPrefix + base64.RawURLEncoding.EncodeToString([]byte(m.apiToken))
}

func (m *WebSocketManager) authorizeStreamRequest(r *http.Request) bool {
	if m.apiToken == "" {
		return true
	}
	expected := m.streamTokenProtocol()
	for _, protocol := range websocket.Subprotocols(r) {
		if subtle.ConstantTimeCompare([]byte(protocol), []byte(expected)) == 1 {
			return true
		}
	}
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		authorization = strings.TrimSpace(authorization[len("bearer "):])
	}
	return subtle.ConstantTimeCompare([]byte(authorization), []byte(m.apiToken)) == 1
}

func (k streamKind) logName() string {
	switch k {
	case tradingStream:
		return "trading"
	case marketStream:
		return "market"
	default:
		return "unknown"
	}
}

func (m *WebSocketManager) registerStreamClient(client *streamClient) int {
	var staleClients []*streamClient

	m.StreamMu.Lock()
	if client != nil && client.id != "" {
		for existing := range m.streamClients {
			if existing != nil && existing.id == client.id && existing.kind == client.kind {
				existing.mu.Lock()
				existing.closed = true
				existing.mu.Unlock()
				delete(m.streamClients, existing)
				staleClients = append(staleClients, existing)
			}
		}
	}
	m.streamClients[client] = true
	m.recordDownstreamClientMetricsLocked()
	count := len(m.streamClients)
	m.StreamMu.Unlock()

	for _, stale := range staleClients {
		if stale.kind.acceptsMarket() {
			m.clearClientMarketSubscriptions(stale)
		}
		m.closeStreamClient(stale)
	}

	return count
}

func (m *WebSocketManager) recordDownstreamClientMetricsLocked() {
	counts := map[streamKind]int{tradingStream: 0, marketStream: 0}
	for client := range m.streamClients {
		counts[client.kind]++
	}
	for kind, count := range counts {
		downstreamStreamClients.WithLabelValues(kind.metricName()).Set(float64(count))
	}
}

// BroadcastMarket fans out to market-lane clients only (candles, books, mids, liquidations).
func (m *WebSocketManager) BroadcastMarket(data []byte) {
	m.StreamMu.RLock()
	clients := make([]*streamClient, 0, len(m.streamClients))
	for client := range m.streamClients {
		if client.kind.acceptsMarket() {
			clients = append(clients, client)
		}
	}
	m.StreamMu.RUnlock()

	for _, client := range clients {
		m.sendRawToClient(client, data)
	}
}

// BroadcastToClients is the historical name for BroadcastMarket.
func (m *WebSocketManager) BroadcastToClients(data []byte) {
	m.BroadcastMarket(data)
}

func (m *WebSocketManager) BroadcastToAccount(account string, data []byte) {
	account = normalizeAccountAddress(account)
	if account == "" {
		return
	}

	m.StreamMu.RLock()
	clients := make([]*streamClient, 0, len(m.streamClients))
	for client := range m.streamClients {
		if client.kind.acceptsTrading() && client.account == account {
			clients = append(clients, client)
		}
	}
	m.StreamMu.RUnlock()

	for _, client := range clients {
		m.sendRawToClient(client, data)
	}
}

// BroadcastToTradingClients is used for unscoped trading status/events. It is
// intentionally distinct from BroadcastMarket (market lane only).
func (m *WebSocketManager) BroadcastToTradingClients(data []byte) {
	m.StreamMu.RLock()
	clients := make([]*streamClient, 0, len(m.streamClients))
	for client := range m.streamClients {
		if client.kind.acceptsTrading() {
			clients = append(clients, client)
		}
	}
	m.StreamMu.RUnlock()

	for _, client := range clients {
		m.sendRawToClient(client, data)
	}
}
