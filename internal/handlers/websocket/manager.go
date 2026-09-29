package websocket

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/ports/cache"
	exchangeport "hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/internal/services"
)

var (
	marketUpstreamSubscriptions = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "pez_market_upstream_subscriptions",
		Help: "Current unique market-websocket subscriptions, including default and discovered builder-dex allMids feeds.",
	})
	marketSubscriptionShedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pez_market_subscription_shed_total",
		Help: "Background book/trade symbols omitted because the upstream subscription budget had no capacity.",
	})
	marketPermanentCandleFeedDroppedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pez_market_permanent_candle_feed_dropped_total",
		Help: "Permanent candle-store feeds shed or rejected because the upstream subscription budget had no capacity.",
	})
	marketUpstreamReconnectTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_market_upstream_reconnect_total",
		Help: "Upstream market websocket reconnects by failure phase.",
	}, []string{"phase"})
	marketUpstreamSessionSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "pez_market_upstream_session_seconds",
		Help:    "Duration of completed upstream market websocket sessions.",
		Buckets: []float64{1, 5, 15, 30, 60, 300, 1800, 7200, 14400},
	})
	liquidationUpstreamReconnectTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_liquidation_upstream_reconnect_total",
		Help: "Liquidation-feed upstream reconnects by source.",
	}, []string{"source"})
	liquidationUpstreamSessionSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pez_liquidation_upstream_session_seconds",
		Help:    "Duration of completed liquidation-feed upstream sessions.",
		Buckets: []float64{1, 5, 15, 30, 60, 300, 1800, 7200, 14400},
	}, []string{"source"})
	liquidationUpstreamTopics = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pez_liquidation_upstream_topics",
		Help: "Current Bybit liquidation topics by acknowledgement state.",
	}, []string{"state"})
	liquidationSubscriptionRejectTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pez_liquidation_subscription_reject_total",
		Help: "Bybit liquidation subscription batches rejected by the upstream.",
	})
	downstreamStreamClients = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pez_downstream_stream_clients",
		Help: "Connected browser websocket clients by isolated stream lane.",
	}, []string{"stream"})
	downstreamStreamQueueDrops = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_downstream_stream_queue_drop_total",
		Help: "Clients disconnected because their isolated downstream queue filled.",
	}, []string{"stream"})
)

func init() {
	prometheus.MustRegister(
		marketUpstreamSubscriptions,
		marketSubscriptionShedTotal,
		marketPermanentCandleFeedDroppedTotal,
		marketUpstreamReconnectTotal,
		marketUpstreamSessionSeconds,
		liquidationUpstreamReconnectTotal,
		liquidationUpstreamSessionSeconds,
		liquidationUpstreamTopics,
		liquidationSubscriptionRejectTotal,
		downstreamStreamClients,
		downstreamStreamQueueDrops,
	)
}

type streamClient struct {
	conn    *websocket.Conn
	id      string
	account string
	kind    streamKind
	market  marketSubscriptionState
	// marketSnapshotSent distinguishes an idempotent same-socket POST from the
	// first POST after pending intent was restored onto a replacement socket.
	// The latter still needs a full flow snapshot for the browser's new epoch.
	marketSnapshotSent bool
	closed             bool
	sendCh             chan []byte
	doneCh             chan struct{}
	once               sync.Once
	mu                 sync.Mutex
}

// streamKind keeps correctness-sensitive trading delivery independent from
// the high-volume market/chart relay.
type streamKind uint8

const (
	tradingStream streamKind = iota + 1
	marketStream
)

func (k streamKind) acceptsTrading() bool { return k == tradingStream }
func (k streamKind) acceptsMarket() bool  { return k == marketStream }
func (k streamKind) metricName() string {
	switch k {
	case tradingStream:
		return "trading"
	case marketStream:
		return "market"
	default:
		return "unknown"
	}
}

type marketSubscriptionState struct {
	Coin               string
	Interval           string
	TradeCoins         map[string]bool
	IndicatorIntervals map[string]bool
}

func (s marketSubscriptionState) isEmpty() bool {
	return s.Coin == "" && s.Interval == "" && len(s.TradeCoins) == 0 && len(s.IndicatorIntervals) == 0
}

// pendingMarketSub holds subscription intent for a clientId with no live
// stream connection: either a subscribe POST that arrived while disconnected,
// or state demoted from a cleared client so a quick reconnect can restore it.
type pendingMarketSub struct {
	state    marketSubscriptionState
	storedAt time.Time
}

type WebSocketManager struct {
	// DownstreamHub / MarketFeedRuntime / AccountFeedRuntime are the three
	// process runtimes. Embedded so field access stays m.MarketWsConn-style.
	DownstreamHub
	MarketFeedRuntime
	AccountFeedRuntime

	apiToken       string
	lifecycleCtx   context.Context
	HeartbeatDone  chan struct{}
	priceCache     cache.PriceCache
	allowedOrigins []string
}

const (
	// Hyperliquid permits 1,000 subscriptions per IP across websocket
	// connections. Keep operational headroom for the user stream and reconnects.
	maxMarketSubscriptions = 900
	// Historical cache residency and live upstream residency are different
	// concerns. A restored snapshot can contain hundreds of useful series, but
	// keeping all of them on the upstream websocket recreates a huge reconnect
	// burst. Active charts remain outside this cap and always take precedence.
	maxPermanentCandleSubscriptions = 64
	maxPendingMarketSubs            = 64
	maxTradeCoinsPerClient          = 100
)

// CandleSink consumes upstream candle messages and market-WS connectivity
// transitions. Defined here (not in the consumer's package) so the websocket
// package needs no candlecache import. ApplyWSCandle and AnnotateWSCandle run
// on the market-WS read goroutine and must not block.
type CandleSink interface {
	ApplyWSCandle(wsMsg map[string]interface{})
	// AnnotateWSCandle returns the forwarded bytes for a candle message,
	// spliced with a server-computed cvdDelta when one is cleanly computable;
	// otherwise it returns raw unchanged. Called after ApplyWSCandle so the
	// tick itself is already merged into the store.
	AnnotateWSCandle(wsMsg map[string]interface{}, raw []byte) []byte
	OnMarketWSDown()
	OnMarketWSReconnect()
	// OnCandleFeedDropped marks a store-held feed unavailable after the shared
	// upstream subscription budget evicts or rejects it. The store must not
	// serve that series from memory again until an actual candle tick arrives.
	OnCandleFeedDropped(coin, interval string)
}

type AccountFetcher interface {
	GetAccount(ctx context.Context, address string) (map[string]interface{}, error)
	GetOpenOrders(ctx context.Context, address string) ([]interface{}, error)
	GetBuilderDexes(ctx context.Context) ([]string, error)
	GetBuilderDexState(ctx context.Context, address, dex string, includeOrders bool) (exchangeport.BuilderDexState, error)
}

// FillProcessor is the account-stream side of order protection (fills + order updates).
// Implemented by services.OrderService.
type FillProcessor interface {
	ProcessUserFills(ctx context.Context, account string, fills []interface{})
	ProcessOrderUpdates(account string, updates []interface{})
}

// BotEventHandler is the optional bot runtime hook on user fills / status.
// Implemented by services.BotService.
type BotEventHandler interface {
	HandleUserFills(account string, fills []interface{})
	Status() models.BotStatus
}

type BBOCache struct {
	Bid  float64
	Ask  float64
	Time time.Time
}

func NewWebSocketManager(priceCache cache.PriceCache) *WebSocketManager {
	return &WebSocketManager{
		DownstreamHub: DownstreamHub{
			streamClients: make(map[*streamClient]bool),
		},
		MarketFeedRuntime: MarketFeedRuntime{
			MarketStopCh:        make(chan struct{}),
			MarketDoneCh:        make(chan struct{}),
			BBOCache:            make(map[string]BBOCache),
			MarketBookRefs:      make(map[string]int),
			MarketCandleRefs:    make(map[string]int),
			PermanentCandleRefs: make(map[string]int),
			MarketTradeRefs:     make(map[string]int),
			PendingMarketSubs:   make(map[string]pendingMarketSub),
			coinFlowCache:       make(map[string]*coinFlowEntry),
			bybitWsURL:          "wss://stream.bybit.com/v5/public/linear",
			bybitInstrumentsURL: "https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000",
			bybitHTTPClient:     &http.Client{Timeout: 10 * time.Second},
		},
		AccountFeedRuntime: AccountFeedRuntime{
			UserStopCh:            make(chan struct{}),
			UserDoneCh:            make(chan struct{}),
			UserTrigger:           make(chan struct{}, 1),
			WsURL:                 "wss://api.hyperliquid.xyz/ws",
			accountRefreshRunning: make(map[string]bool),
			accountRefreshDirty:   make(map[string]bool),
			builderRefreshRunning: make(map[string]bool),
			builderRefreshDirty:   make(map[string]bool),
			builderDexes:          []string{"xyz"},
		},
		HeartbeatDone: make(chan struct{}),
		priceCache:    priceCache,
		lifecycleCtx:  context.Background(),
	}
}

func (m *WebSocketManager) SetAPIToken(token string) {
	m.apiToken = strings.TrimSpace(token)
}

func (m *WebSocketManager) SetLifecycleContext(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	m.lifecycleCtx = ctx
}

func (m *WebSocketManager) SetAccountFetcher(fetcher AccountFetcher) {
	m.accountFetcher = fetcher
}

// SetXyzMidsSink wires all streamed mids into the exchange execution cache.
// The name is retained for compatibility with the existing manager surface.
func (m *WebSocketManager) SetXyzMidsSink(sink func(map[string]float64)) {
	m.xyzMidsSink = sink
}

func (m *WebSocketManager) SetBuilderDexes(dexes []string) {
	// Only xyz HIP-3 allMids/market feeds are subscribed. Non-xyz builder dexs
	// are dropped even if a caller passes them (defense in depth).
	m.builderDexes = m.builderDexes[:0]
	for _, dex := range dexes {
		dex = strings.ToLower(strings.TrimSpace(dex))
		if dex == "xyz" {
			m.builderDexes = []string{"xyz"}
			return
		}
	}
	m.builderDexes = []string{"xyz"}
}

// SetCandleSink wires upstream candle messages and market-WS connectivity
// transitions into the server-side candle store.
func (m *WebSocketManager) SetCandleSink(sink CandleSink) {
	m.candleSink = sink
}

func (m *WebSocketManager) SetAccountRuntime(runtime *services.AccountRuntime) {
	m.accountRuntime = runtime
}

func (m *WebSocketManager) SetOrderService(orderService FillProcessor) {
	m.orderService = orderService
}

func (m *WebSocketManager) SetBotService(botService BotEventHandler) {
	m.botService = botService
}

// SetAllowedOrigins constrains which browser origins may open the account
// stream. With no configured list, same-origin browser handshakes are allowed
// (the gorilla/websocket default); a configured list is an explicit allowlist.
func (m *WebSocketManager) SetAllowedOrigins(origins []string) {
	m.allowedOrigins = origins
}

// isOriginAllowed reports whether a websocket handshake origin is permitted.
// Origin-less clients remain useful for local tooling when no allowlist is
// configured, but never bypass an explicit public-deployment allowlist.
func (m *WebSocketManager) isOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if len(m.allowedOrigins) == 0 {
		if origin == "" {
			return true
		}
		parsed, err := url.Parse(origin)
		return err == nil && parsed.Host != "" && strings.EqualFold(parsed.Host, r.Host)
	}
	if origin == "" {
		return false
	}
	for _, allowed := range m.allowedOrigins {
		if strings.EqualFold(strings.TrimSpace(allowed), origin) {
			return true
		}
	}
	return false
}

func (m *WebSocketManager) BroadcastBotStatus(account string, status interface{}) {
	payload, err := json.Marshal(map[string]interface{}{
		"channel": "botStatus",
		"data":    status,
	})
	if err != nil {
		return
	}
	if normalizeAccountAddress(account) != "" {
		m.BroadcastToAccount(account, payload)
		return
	}
	m.BroadcastToTradingClients(payload)
}
