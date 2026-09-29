package websocket

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"

	"hyperliquid-go/internal/services"
)

// Three process-level runtimes share one WebSocketManager façade for wiring
// compatibility. Fields are embedded so existing m.MarketWsConn / m.StreamMu
// accesses keep working without a mass rename.

// DownstreamHub owns browser client registries and sequence spaces.
type DownstreamHub struct {
	streamClients map[*streamClient]bool
	StreamMu      sync.RWMutex
	// Trading and market clients use independent sequence spaces. A burst of
	// candle/book traffic therefore cannot advance or contend on the ordering
	// token used by account/order/fill delivery.
	TradingStreamSequence int64
	MarketStreamSequence  int64
}

// MarketFeedRuntime owns the upstream market socket, subscription refs, flow
// samples, BBO cache, candle sink, and liquidation feed process state.
type MarketFeedRuntime struct {
	// candleSink receives upstream candle traffic and market-WS connectivity
	// transitions so the server-side candle store stays warm (wired in main).
	candleSink CandleSink

	MarketWsConn *websocket.Conn
	MarketWsMu   sync.RWMutex
	// marketReconnectBackoff is the live market-loop backoff so a process wake
	// can Reset() it instead of waiting out a leftover 30s delay.
	marketReconnectBackoff *reconnectBackoff
	// lastWakeCycleMs is the wall time of the last closeAllUpstreamsForWake.
	// Darwin pauses keepalive tickers during sleep, so every previous
	// connection's goroutine fires after lid-open; only the first cycle may
	// run or recovered sockets get torn down again.
	lastWakeCycleMs atomic.Int64

	// Market-wide liquidation feed: Bybit (+ QuickNode when configured) broadcast
	// normalized events on the `liquidations` channel. See liquidation_feed.go.
	quickNodeWsURL       string
	quickNodeMinNotional float64
	liqMu                sync.Mutex
	liqCancel            context.CancelFunc
	liqWg                sync.WaitGroup
	liqLiveMu            sync.Mutex
	liqLive              []*websocket.Conn
	liqUniverseMu        sync.RWMutex
	liqUniverse          map[string]string
	bybitWsURL           string
	bybitInstrumentsURL  string
	bybitHTTPClient      *http.Client
	bybitLiqReady        atomic.Bool
	bybitLiqRequested    atomic.Int64
	bybitLiqSubscribed   atomic.Int64
	bybitLiqRejected     atomic.Int64

	MarketStopCh chan struct{}
	MarketDoneCh chan struct{}

	BBOCache   map[string]BBOCache
	BBOCacheMu sync.RWMutex

	MarketBookRefs   map[string]int
	MarketCandleRefs map[string]int
	// PermanentCandleRefs counts the refs held by the candle store's permanent
	// subscriptions. ActiveCandleSeries subtracts these so "active" means a
	// client is viewing the series right now.
	PermanentCandleRefs        map[string]int
	permanentCandleLimitWarned bool
	MarketTradeRefs            map[string]int
	PendingMarketSubs          map[string]pendingMarketSub
	MarketSubMu                sync.Mutex

	// coinFlowCache holds each coin's independent bounded ALL and WHALE
	// public-trade samples for the DOM header.
	coinFlowMu    sync.Mutex
	coinFlowCache map[string]*coinFlowEntry
	flowRevision  uint64
}

// AccountFeedRuntime owns the upstream user socket, account refresh coalescing,
// builder reconciliation, and trading-side service hooks.
type AccountFeedRuntime struct {
	UserWsConn *websocket.Conn
	UserWsMu   sync.Mutex
	userReconnectBackoff *reconnectBackoff
	// UserWsWriteMu serializes writes to UserWsConn (subscribe + keepalive).
	UserWsWriteMu sync.Mutex
	UserAddr      string

	lastAccountStreamDataAt atomic.Int64
	forcedUserReconnects    atomic.Int32

	// xyzMidsSink receives standard and builder-dex mids for execution hot paths.
	xyzMidsSink  func(map[string]float64)
	builderDexes []string

	UserStopCh      chan struct{}
	UserDoneCh      chan struct{}
	UserWsKey       string
	UserAccountAddr string
	UserSignerAddr  string
	WsURL           string
	UserTrigger     chan struct{}

	accountFetcher AccountFetcher
	accountRuntime *services.AccountRuntime
	orderService   FillProcessor
	botService     BotEventHandler

	accountRefreshMu      sync.Mutex
	accountRefreshRunning map[string]bool
	accountRefreshDirty   map[string]bool
	builderRefreshMu      sync.Mutex
	builderRefreshRunning map[string]bool
	builderRefreshDirty   map[string]bool
}
