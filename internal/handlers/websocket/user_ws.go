package websocket

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/gorilla/websocket"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	exchangeport "hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/internal/services"
)

// webData2, not webData3: probed live (June 2026), webData3 returns only
// account meta (userState{agentAddress, dexAbstractionEnabled, ...}) and
// per-dex skeletons (perpDexStates[i]{totalVaultEquity}) — no
// clearinghouseState, positions, or orders. webData2 carries the full
// main-dex account state the frontend normalizer consumes. Builder-dex (xyz)
// positions have no stream at all (webData2's dex param is ignored); they
// are covered by the xyz position poller below.
const userAggregateSubscriptionType = "webData2"

func (m *WebSocketManager) TriggerUserWebSocket() {
	select {
	case m.UserTrigger <- struct{}{}:
	default:
	}
}

func (m *WebSocketManager) StartUserWebSocketLoop(ctx context.Context) {
	go func() {
		defer close(m.UserDoneCh)
		backoff := newReconnectBackoff(time.Second, 30*time.Second, 30*time.Second)
		m.userReconnectBackoff = backoff
		for {
			select {
			case <-ctx.Done():
				return
			case <-m.UserTrigger:
			case <-m.UserStopCh:
				return
			}

			for m.hasUserSession() {
				connectedAtMs := time.Now().UnixMilli()
				m.connectUserWebSocket(ctx)
				if !m.hasUserSession() {
					break
				}
				delay := backoff.Next(wallClockSince(connectedAtMs))
				log.Printf("User WebSocket disconnected, auto-reconnecting in %s...", delay)
				if !waitThenMaybeReset(backoff, m.UserStopCh, delay) {
					return
				}
				select {
				case <-ctx.Done():
					return
				default:
				}
			}
		}
	}()
}

func (m *WebSocketManager) connectUserWebSocket(ctx context.Context) {
	m.UserWsMu.Lock()
	pk := m.UserWsKey
	accountAddr := m.UserAccountAddr
	m.UserWsMu.Unlock()
	if len(pk) < 64 {
		return
	}

	pkClean := pk
	if len(pkClean) == 66 && pkClean[:2] == "0x" {
		pkClean = pkClean[2:]
	}

	keyBytes, err := hex.DecodeString(pkClean)
	if err != nil {
		log.Printf("User WebSocket: failed to decode key: %v", err)
		return
	}
	ecdsaKey, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		log.Printf("User WebSocket: failed to create key: %v", err)
		return
	}
	signerAddr := crypto.PubkeyToAddress(ecdsaKey.PublicKey).Hex()
	if accountAddr == "" {
		accountAddr = signerAddr
	}

	log.Printf("Starting user WebSocket for account=%s signer=%s", shortAddr(accountAddr), shortAddr(signerAddr))

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(m.WsURL, nil)
	if err != nil {
		log.Printf("User WebSocket dial failed: %v", err)
		return
	}

	m.UserWsMu.Lock()
	m.UserWsConn = conn
	m.UserAddr = accountAddr
	m.UserAccountAddr = accountAddr
	m.UserSignerAddr = signerAddr
	m.UserWsMu.Unlock()
	bindUpstreamPingHandler(conn, &m.UserWsWriteMu, func() bool {
		m.UserWsMu.Lock()
		current := m.UserWsConn
		m.UserWsMu.Unlock()
		return current == conn
	})
	defer func() {
		m.UserWsMu.Lock()
		if m.UserWsConn == conn {
			m.UserWsConn = nil
		}
		m.UserWsMu.Unlock()
	}()

	subscriptions := []map[string]interface{}{
		{"type": userAggregateSubscriptionType, "user": accountAddr},
		{"type": "orderUpdates", "user": accountAddr},
		{"type": "userFills", "user": accountAddr},
		{"type": "twapStates", "user": accountAddr},
		{"type": "twapStates", "user": accountAddr, "dex": "xyz"},
		{"type": "clearinghouseState", "user": accountAddr, "dex": "xyz"},
		{"type": "openOrders", "user": accountAddr, "dex": "xyz"},
	}
	for _, sub := range subscriptions {
		msg := map[string]interface{}{
			"method":       "subscribe",
			"subscription": sub,
		}
		m.UserWsWriteMu.Lock()
		conn.SetWriteDeadline(time.Now().Add(upstreamWriteTimeout))
		err := conn.WriteJSON(msg)
		m.UserWsWriteMu.Unlock()
		if err != nil {
			log.Printf("User WebSocket failed to subscribe (%v): %v", sub["type"], err)
			conn.Close()
			return
		}
	}

	log.Printf("User WebSocket connected for %s, subscribed to %s/orderUpdates/userFills/twapStates", shortAddr(accountAddr), userAggregateSubscriptionType)

	// A fresh connection starts with a fresh silence window; the previous
	// connection's timestamp would otherwise trip the stall watchdog
	// immediately after every reconnect.
	m.lastAccountStreamDataAt.Store(time.Now().Unix())

	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	go m.runXyzPositionPoller(pollCtx, accountAddr)
	go m.runUserKeepalive(pollCtx, conn)

	for {
		select {
		case <-m.UserStopCh:
			conn.Close()
			return
		default:
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("User WebSocket read error: %v", err)
				conn.Close()
				return
			}

			if debugLogsEnabled() {
				log.Printf("User WebSocket received %d bytes, broadcasting to %d stream clients", len(msg), m.StreamClientCount())
			}

			var envelope map[string]interface{}
			if err := json.Unmarshal(msg, &envelope); err != nil {
				continue
			}
			channel, _ := envelope["channel"].(string)

			// Stream-health watchdog input: HL changed webData3's payload
			// once before (it stopped carrying clearinghouse data). Track
			// when account state last arrived so the poller can force a
			// reconnect instead of degrading silently to REST-only.
			if (channel == "webData2" || channel == "webData3") && bytes.Contains(msg, []byte(`"clearinghouseState"`)) {
				m.lastAccountStreamDataAt.Store(time.Now().Unix())
				m.forcedUserReconnects.Store(0)
			}
			if channel == "clearinghouseState" || channel == "openOrders" {
				m.lastAccountStreamDataAt.Store(time.Now().Unix())
				m.forcedUserReconnects.Store(0)
				m.broadcastOfficialBuilderStream(accountAddr, channel, envelope["data"])
			}

			var runtimeSnapshot services.AccountRuntimeSnapshot
			if m.accountRuntime != nil {
				runtimeSnapshot = m.accountRuntime.ApplyUserStreamMessage(accountAddr, msg)
			}
			if m.orderService != nil && channel == "userFills" {
				fills := collectFillEntries(envelope["data"])
				if len(fills) > 0 {
					// Snapshot replays (isSnapshot=true arrives on every
					// resubscribe with recent fill history) still flow to
					// ProcessUserFills — that is the backfill path for fills
					// missed while disconnected, and tid dedupe makes it
					// idempotent — but must not re-trigger bot reactions.
					m.orderService.ProcessUserFills(pollCtx, accountAddr, fills)
					if m.botService != nil && !isSnapshotFillMessage(envelope["data"]) {
						m.botService.HandleUserFills(accountAddr, fills)
					}
				}
			}
			if m.orderService != nil && channel == "orderUpdates" {
				if updates, ok := envelope["data"].([]interface{}); ok && len(updates) > 0 {
					m.orderService.ProcessOrderUpdates(accountAddr, updates)
				}
			}
			if channel == "orderUpdates" || channel == "userFills" {
				for _, dex := range builderDexesInUserEvent(envelope["data"]) {
					m.requestBuilderDexRefresh(pollCtx, accountAddr, dex)
				}
			}
			broadcastMsg := msg
			if m.accountRuntime != nil {
				broadcastMsg = m.accountRuntime.InjectOrdersIntoWebData2(msg, runtimeSnapshot)
			}
			m.BroadcastToAccount(accountAddr, broadcastMsg)
			if channel == "orderUpdates" || channel == "userFills" {
				m.RequestAccountRefresh(accountAddr)
			}
			if runtimeSnapshot.HasSnapshot && (channel == "orderUpdates" || channel == "userFills") {
				if snapshotMsg := m.accountRuntime.BuildCanonicalSnapshotMessage(runtimeSnapshot); snapshotMsg != nil {
					m.BroadcastToAccount(accountAddr, snapshotMsg)
				}
			}
		}
	}
}

func (m *WebSocketManager) broadcastOfficialBuilderStream(account, channel string, data interface{}) {
	body, ok := data.(map[string]interface{})
	if !ok {
		return
	}
	dex, _ := body["dex"].(string)
	if dex == "" {
		return
	}
	asOf := time.Now().UnixMilli()
	switch channel {
	case "clearinghouseState":
		inner, _ := body["clearinghouseState"].(map[string]interface{})
		if inner == nil {
			inner = body
		}
		positions, _ := inner["assetPositions"].([]interface{})
		if positions == nil {
			return
		}
		if msg, err := json.Marshal(map[string]interface{}{
			"channel": "builderPositions",
			"data": map[string]interface{}{
				"dex": dex, "assetPositions": positions, "asOf": asOf, "fresh": true,
			},
		}); err == nil {
			m.BroadcastToAccount(account, msg)
		}
		if dex == "xyz" {
			if msg, err := json.Marshal(map[string]interface{}{
				"channel": "xyzPositions",
				"data":    map[string]interface{}{"assetPositions": positions},
			}); err == nil {
				m.BroadcastToAccount(account, msg)
			}
		}
	case "openOrders":
		if m.accountRuntime == nil {
			return
		}
		orders, _ := body["orders"].([]interface{})
		if snapshot, changed := m.accountRuntime.ReconcileBuilderDexOrders(account, dex, orders); changed {
			if snapshotMsg := m.accountRuntime.BuildCanonicalSnapshotMessage(snapshot); snapshotMsg != nil {
				m.BroadcastToAccount(account, snapshotMsg)
			}
		}
	}
}

func builderDexesInUserEvent(payload interface{}) []string {
	seen := make(map[string]bool)
	var walk func(interface{})
	walk = func(value interface{}) {
		switch typed := value.(type) {
		case []interface{}:
			for _, item := range typed {
				walk(item)
			}
		case map[string]interface{}:
			if coin, _ := typed["coin"].(string); coin != "" {
				if split := strings.IndexByte(coin, ':'); split > 0 {
					seen[strings.ToLower(strings.TrimSpace(coin[:split]))] = true
				}
			}
			for _, key := range []string{"fills", "orderUpdates", "orders", "order", "resting"} {
				if nested, ok := typed[key]; ok {
					walk(nested)
				}
			}
		}
	}
	walk(payload)
	out := make([]string, 0, len(seen))
	for dex := range seen {
		out = append(out, dex)
	}
	return out
}

// requestBuilderDexRefresh turns an execution event into a targeted backend
// repair. It never fans out across unrelated DEXes and never blocks the user
// WebSocket read pump.
func (m *WebSocketManager) requestBuilderDexRefresh(ctx context.Context, account, dex string) {
	account = normalizeAccountAddress(account)
	dex = strings.ToLower(strings.TrimSpace(dex))
	if m.accountFetcher == nil || account == "" || dex == "" {
		return
	}
	key := account + "|" + dex

	m.builderRefreshMu.Lock()
	if m.builderRefreshRunning[key] {
		m.builderRefreshDirty[key] = true
		m.builderRefreshMu.Unlock()
		return
	}
	m.builderRefreshRunning[key] = true
	m.builderRefreshMu.Unlock()

	go func() {
		for {
			// Collapse the orderUpdate/userFill pair emitted by one exchange action
			// before consuming the dirty bit. Events arriving after this debounce
			// belong to the in-flight window and request one follow-up iteration.
			timer := time.NewTimer(targetedBuilderRefreshDebounce)
			select {
			case <-ctx.Done():
				timer.Stop()
				m.finishBuilderDexRefresh(key)
				return
			case <-timer.C:
			}

			m.builderRefreshMu.Lock()
			m.builderRefreshDirty[key] = false
			m.builderRefreshMu.Unlock()

			refreshCtx, cancel := context.WithTimeout(ctx, targetedBuilderRefreshTimeout)
			refreshCtx = infogovernor.WithLane(refreshCtx, infogovernor.AccountCore)
			state, err := m.accountFetcher.GetBuilderDexState(refreshCtx, account, dex, true)
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("WARNING: targeted builder refresh failed dex=%s: %v", dex, err)
				}
			} else {
				if msg, marshalErr := json.Marshal(map[string]interface{}{
					"channel": "builderPositions",
					"data": map[string]interface{}{
						"dex": state.Dex, "assetPositions": state.Positions,
						"asOf": time.Now().UnixMilli(), "fresh": true,
					},
				}); marshalErr == nil {
					m.BroadcastToAccount(account, msg)
				}
				if m.accountRuntime != nil {
					if snapshot, changed := m.accountRuntime.ReconcileBuilderDexOrders(account, state.Dex, state.Orders); changed {
						if snapshotMsg := m.accountRuntime.BuildCanonicalSnapshotMessage(snapshot); snapshotMsg != nil {
							m.BroadcastToAccount(account, snapshotMsg)
						}
					}
				}
			}

			m.builderRefreshMu.Lock()
			if m.builderRefreshDirty[key] && ctx.Err() == nil {
				m.builderRefreshDirty[key] = false
				m.builderRefreshMu.Unlock()
				continue
			}
			delete(m.builderRefreshRunning, key)
			delete(m.builderRefreshDirty, key)
			m.builderRefreshMu.Unlock()
			return
		}
	}()
}

func (m *WebSocketManager) finishBuilderDexRefresh(key string) {
	m.builderRefreshMu.Lock()
	delete(m.builderRefreshRunning, key)
	delete(m.builderRefreshDirty, key)
	m.builderRefreshMu.Unlock()
}

// xyzPositionPollInterval balances freshness against info-API weight. Builder
// dex (xyz) state has no websocket stream — webData2 is main-dex only — so
// this poll is the realtime source for xyz positions (liquidationPx/markPx/
// margin) and reconciles xyz orders cancelled/triggered on-exchange.
const xyzPositionPollInterval = 3 * time.Second
const targetedBuilderRefreshTimeout = 3 * time.Second
const targetedBuilderRefreshDebounce = 75 * time.Millisecond

// xyzOrderPollEvery staggers the frontendOpenOrders fetch to every Nth poller
// tick. Positions (weight 2) stay at every tick; the order snapshot is weight
// 20, so fetching it each tick burned ~400 of Hyperliquid's 1200/min IP budget
// for data that changes rarely. Worst-case on-exchange xyz order-cancel
// reconciliation moves 3s → 9s, masked by optimistic UI updates.
const xyzOrderPollEvery = 3

// streamHealthWarnAfter bounds how long the user stream may go without
// delivering account state before the poller intervenes. webData3 silently
// stopped carrying clearinghouse data once; never degrade quietly again.
const streamHealthWarnAfter = 5 * time.Minute

// maxForcedStreamReconnects caps consecutive watchdog-forced reconnects. If a
// fresh connection still delivers no account state, the upstream payload has
// likely changed shape; further reconnects would just loop while REST
// fallbacks are already serving, so the watchdog drops back to warn-only.
const maxForcedStreamReconnects = 2

// wakeGapThreshold detects system sleep: the poller ticks every 3s, so a tick
// arriving this far late means the host was suspended and both upstream
// connections are likely half-dead. Cycling them immediately restores fresh
// state in ~2s instead of waiting out the 60s read deadline.
const wakeGapThreshold = 30 * time.Second

// wakeGapExceeded compares wall-clock millis because Go's monotonic clock
// (CLOCK_UPTIME_RAW on darwin) pauses during system sleep — time.Since can
// never observe a sleep gap, so the detection must use wall-clock timestamps.
func wakeGapExceeded(prevWallMs, nowWallMs int64) bool {
	return nowWallMs-prevWallMs > wakeGapThreshold.Milliseconds()
}

// marketKeepaliveShouldCycle reports whether a keepalive tick should tear down
// upstream sockets. Replaced-connection tickers also fire after Darwin sleep;
// they must not cycle the socket that just replaced them.
func marketKeepaliveShouldCycle(ownsConn bool, lastTickWallMs, nowWallMs int64) bool {
	if !ownsConn {
		return false
	}
	return nowWallMs-lastTickWallMs > (upstreamPingInterval + wakeGapThreshold).Milliseconds()
}

func bindUpstreamPingHandler(conn *websocket.Conn, writeMu *sync.Mutex, stillCurrent func() bool) {
	if conn == nil {
		return
	}
	conn.SetPingHandler(func(appData string) error {
		if writeMu != nil {
			writeMu.Lock()
			defer writeMu.Unlock()
		}
		if stillCurrent != nil && !stillCurrent() {
			return nil
		}
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(upstreamWriteTimeout))
	})
}

// upstreamWriteTimeout bounds subscribe/ping writes to Hyperliquid so a
// stalled peer cannot block a writer until the OS gives up.
const upstreamWriteTimeout = 10 * time.Second

// upstreamPingInterval is how often the server sends {"method":"ping"} on its
// upstream connections. Hyperliquid expects periodic client pings and the pong
// reply doubles as read-deadline traffic on otherwise-quiet streams.
const upstreamPingInterval = 30 * time.Second

func (m *WebSocketManager) runXyzPositionPoller(ctx context.Context, account string) {
	ticker := time.NewTicker(xyzPositionPollInterval)
	defer ticker.Stop()
	lastPositionsPayload := make(map[string]string)
	lastHealthWarnAt := time.Time{}
	lastTickWallMs := time.Now().UnixMilli()
	tickCount := 0
	builderDexes := []string{"xyz"}
	if discovered, err := m.accountFetcher.GetBuilderDexes(ctx); err == nil && len(discovered) > 0 {
		builderDexes = discovered
	}
	activeDexes := map[string]bool{"xyz": true}
	scanIndex := 0
	// Poll failures must be visible: a silent skip here is how a fresh xyz
	// position stayed missing from every downstream view during a 429 window.
	lastPollErr := ""
	pollErrStreak := 0
	logPollErr := func(kind string, err error) {
		pollErrStreak++
		text := kind + ": " + err.Error()
		if text != lastPollErr || pollErrStreak%20 == 1 {
			log.Printf("WARNING: xyz poll %s failed (streak=%d): %v", kind, pollErrStreak, err)
			lastPollErr = text
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.UserStopCh:
			return
		case <-ticker.C:
		}

		nowWallMs := time.Now().UnixMilli()
		if wakeGapExceeded(lastTickWallMs, nowWallMs) {
			gap := time.Duration(nowWallMs-lastTickWallMs) * time.Millisecond
			log.Printf("WARNING: trading poller tick arrived %s late — assuming system wake; cycling user, market, and liquidation sockets", gap.Round(time.Second))
			m.lastAccountStreamDataAt.Store(time.Now().Unix())
			m.closeAllUpstreamsForWake()
			return // this poller dies with its connection; the reconnect starts a fresh one
		}
		lastTickWallMs = nowWallMs

		// The stall watchdog runs even with no browser connected: server-side
		// pending TP/SL protection rides the userFills stream, so a silently
		// degraded upstream must still force a reconnect overnight.
		m.handleAccountStreamSilence(&lastHealthWarnAt)

		if m.accountFetcher == nil || m.TradingClientCount() == 0 {
			continue
		}

		fetchOrders := tickCount%xyzOrderPollEvery == 0
		tickCount++

		dexesThisTick := make([]string, 0, len(activeDexes)+1)
		for dex := range activeDexes {
			dexesThisTick = append(dexesThisTick, dex)
		}
		if len(builderDexes) > 0 {
			candidate := builderDexes[scanIndex%len(builderDexes)]
			scanIndex++
			if !activeDexes[candidate] {
				dexesThisTick = append(dexesThisTick, candidate)
			}
		}

		states := make([]exchangeport.BuilderDexState, len(dexesThisTick))
		errs := make([]error, len(dexesThisTick))
		var wg sync.WaitGroup
		for i, dex := range dexesThisTick {
			wg.Add(1)
			go func(i int, dex string) {
				defer wg.Done()
				states[i], errs[i] = m.accountFetcher.GetBuilderDexState(ctx, account, dex, fetchOrders && activeDexes[dex])
			}(i, dex)
		}
		wg.Wait()

		if ctx.Err() != nil {
			return // connection teardown cancelled the in-flight poll; not a poll failure
		}

		firstErr := error(nil)
		for _, err := range errs {
			if err != nil {
				firstErr = err
				break
			}
		}
		if firstErr != nil {
			logPollErr("builder state", firstErr)
		} else {
			lastPollErr = ""
			pollErrStreak = 0
		}

		for i, builderState := range states {
			if errs[i] != nil {
				continue
			}
			if len(builderState.Positions) > 0 || len(builderState.Orders) > 0 {
				activeDexes[builderState.Dex] = true
			}
			if encoded, err := json.Marshal(builderState.Positions); err == nil && string(encoded) != lastPositionsPayload[builderState.Dex] {
				// Broadcast only on change; an empty list is a change too (close).
				lastPositionsPayload[builderState.Dex] = string(encoded)
				if msg, err := json.Marshal(map[string]interface{}{
					"channel": "builderPositions",
					"data": map[string]interface{}{
						"dex": builderState.Dex, "assetPositions": builderState.Positions,
						"asOf": time.Now().UnixMilli(), "fresh": true,
					},
				}); err == nil {
					m.BroadcastToAccount(account, msg)
				}
				if builderState.Dex == "xyz" {
					if msg, err := json.Marshal(map[string]interface{}{"channel": "xyzPositions", "data": map[string]interface{}{"assetPositions": builderState.Positions}}); err == nil {
						m.BroadcastToAccount(account, msg)
					}
				}
			}

			if fetchOrders && activeDexes[builderState.Dex] && m.accountRuntime != nil {
				if snapshot, changed := m.accountRuntime.ReconcileBuilderDexOrders(account, builderState.Dex, builderState.Orders); changed {
					if snapshotMsg := m.accountRuntime.BuildCanonicalSnapshotMessage(snapshot); snapshotMsg != nil {
						m.BroadcastToAccount(account, snapshotMsg)
					}
				}
			}
		}
	}
}

// handleAccountStreamSilence is the stall watchdog: when the user stream
// delivers no account state for streamHealthWarnAfter it forces a reconnect
// (up to maxForcedStreamReconnects consecutive times), then falls back to
// periodic warnings while REST fallbacks carry the dashboard.
func (m *WebSocketManager) handleAccountStreamSilence(lastWarnAt *time.Time) {
	lastData := m.lastAccountStreamDataAt.Load()
	if lastData <= 0 {
		return
	}
	silentFor := time.Since(time.Unix(lastData, 0))
	if silentFor < streamHealthWarnAfter {
		return
	}
	if time.Since(*lastWarnAt) < streamHealthWarnAfter {
		return
	}
	*lastWarnAt = time.Now()

	if forced := m.forcedUserReconnects.Load(); forced < maxForcedStreamReconnects {
		m.forcedUserReconnects.Add(1)
		log.Printf("WARNING: user stream has delivered no account state (clearinghouseState) for %s — forcing reconnect (%d/%d)", silentFor.Round(time.Second), forced+1, maxForcedStreamReconnects)
		m.closeUserConnForReconnect()
		return
	}
	log.Printf("WARNING: user stream has delivered no account state (clearinghouseState) for %s and %d forced reconnect(s) did not recover it — dashboard is running on REST fallbacks; check whether Hyperliquid changed the %s payload", silentFor.Round(time.Second), maxForcedStreamReconnects, userAggregateSubscriptionType)
}

// closeUserConnForReconnect closes the upstream user connection so the read
// loop errors out and the existing auto-reconnect loop takes over.
func (m *WebSocketManager) closeUserConnForReconnect() {
	m.UserWsMu.Lock()
	if m.UserWsConn != nil {
		_ = m.UserWsConn.Close()
	}
	m.UserWsMu.Unlock()
}

// closeAllUpstreamsForWake closes every outbound feed after a lid-close gap
// so Darwin-stale TCP/DNS does not sit on a 60–90s read deadline.
// Returns false when another goroutine already cycled within wakeGapThreshold
// (stale keepalives from replaced sockets all fire after one sleep).
func (m *WebSocketManager) closeAllUpstreamsForWake() bool {
	if m == nil {
		return false
	}
	nowMs := time.Now().UnixMilli()
	for {
		last := m.lastWakeCycleMs.Load()
		if last != 0 && nowMs-last <= wakeGapThreshold.Milliseconds() {
			return false
		}
		if m.lastWakeCycleMs.CompareAndSwap(last, nowMs) {
			break
		}
	}
	m.userReconnectBackoff.Reset()
	m.marketReconnectBackoff.Reset()
	m.closeUserConnForReconnect()
	m.MarketWsMu.Lock()
	conn := m.MarketWsConn
	m.MarketWsMu.Unlock()
	if conn != nil {
		m.markMarketSocketDegraded(conn)
	}
	m.closeLiquidationConnsForWake()
	return true
}

// runUserKeepalive sends application-level pings on the upstream user
// connection. A write failure closes the connection so the read loop
// reconnects instead of waiting for data-cadence timeouts.
func (m *WebSocketManager) runUserKeepalive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(upstreamPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.UserStopCh:
			return
		case <-ticker.C:
		}
		m.UserWsWriteMu.Lock()
		conn.SetWriteDeadline(time.Now().Add(upstreamWriteTimeout))
		err := conn.WriteJSON(map[string]interface{}{"method": "ping"})
		m.UserWsWriteMu.Unlock()
		if err != nil {
			log.Printf("User WebSocket keepalive write failed: %v", err)
			conn.Close()
			return
		}
	}
}

// isSnapshotFillMessage reports whether a userFills payload is the
// subscription-time snapshot replay rather than a live fill event.
func isSnapshotFillMessage(data interface{}) bool {
	payload, ok := data.(map[string]interface{})
	if !ok {
		return false
	}
	isSnapshot, _ := payload["isSnapshot"].(bool)
	return isSnapshot
}

func (m *WebSocketManager) StopUserWebSocket() {
	m.UserWsMu.Lock()
	if m.UserWsConn != nil {
		_ = m.UserWsConn.Close()
		m.UserWsConn = nil
	}
	m.UserWsMu.Unlock()

	close(m.UserStopCh)
	<-m.UserDoneCh
}

func collectFillEntries(data interface{}) []interface{} {
	switch typed := data.(type) {
	case []interface{}:
		return typed
	case map[string]interface{}:
		if fills, ok := typed["fills"].([]interface{}); ok {
			return fills
		}
		return []interface{}{typed}
	default:
		return nil
	}
}
