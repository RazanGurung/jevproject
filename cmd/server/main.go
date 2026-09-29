package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"hyperliquid-go/internal/chartrequirements"
	"hyperliquid-go/internal/config"
	"hyperliquid-go/internal/domain/models"
	h "hyperliquid-go/internal/handlers/http"
	wshandler "hyperliquid-go/internal/handlers/websocket"
	cacheinfra "hyperliquid-go/internal/infrastructure/cache"
	"hyperliquid-go/internal/infrastructure/candlecache"
	"hyperliquid-go/internal/infrastructure/exchange"
	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	"hyperliquid-go/internal/infrastructure/preload"
	streaminfra "hyperliquid-go/internal/infrastructure/streaming"
	"hyperliquid-go/internal/infrastructure/typesafe"
	"hyperliquid-go/internal/keycache"
	"hyperliquid-go/internal/middleware"
	streamport "hyperliquid-go/internal/ports/streaming"
	"hyperliquid-go/internal/services"
	"hyperliquid-go/internal/services/warmcoordinator"
	"hyperliquid-go/pkg/utils"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var startTime = time.Now()

// Shared transport: one connection pool + process-wide HL weight accounting.
// Timeouts differ by client so interactive chart cold loads are not killed by
// the short general-purpose budget used for metadata/health probes.
var hlTransport = hlratelimit.WrapTransport(&http.Transport{
	DialContext: (&net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS12,
	},
	MaxIdleConns:        200,
	MaxIdleConnsPerHost: 50,
	IdleConnTimeout:     120 * time.Second,
	ForceAttemptHTTP2:   true,
})

var httpClient = &http.Client{
	// Request contexts bound the call. A Client.Timeout would include limiter
	// wait and abort /info work after the nonce/lane was already reserved.
	Timeout:   0,
	Transport: hlTransport,
}

// candleHTTPClient serves interactive/prefetch candleSnapshot passthroughs.
// Thin builder-dex series under load routinely exceed 10s; killing them early
// surfaces as browser 502s and blank charts. Still below the 30s handler budget
// so a stuck upstream cannot hold a semaphore slot forever.
var candleHTTPClient = &http.Client{
	// Limiter wait lives in RoundTrip. A Client.Timeout would include that
	// wait and abort a still-legitimate candle body. passthroughCandleSnapshot
	// sets hlratelimit.WithRTTTimeout(25s) so the HTTP bound starts after Wait.
	Timeout:   0,
	Transport: hlTransport,
}

// =============================================================================
// COMPOSITION-ROOT RUNTIME
// =============================================================================

// serverRuntime holds process-scoped adapters used by package-level route
// helpers (setKey, candle passthrough, CVD). New wiring should take deps via
// constructors; these fields exist so existing helpers stay explicit rather
// than three loose package globals.
type serverRuntime struct {
	wsManager   *wshandler.WebSocketManager
	exchAdapter *exchange.HyperliquidAdapter // set in main(), used by setKey for warm-up
	candleStore *candlecache.Store           // nil when preloading is disabled; proxyHL guards
}

// runtime is the single composition-root holder for helper-facing process deps.
// Tests may swap fields with save/restore; production assigns once in main().
var runtime serverRuntime

// pinnedCandleCoins is the curated set of markets that always get a warm candle
// cache regardless of open interest. The topbar itself is now dynamic (top
// gainers/losers, see /api/market-movers), so this list no longer mirrors fixed
// HTML tabs — it's the prominent crypto + xyz synthetics users reach via the
// category dropdowns, several of which sit below any sensible OI cutoff and so
// would be left cold by liquidity selection alone.
var pinnedCandleCoins = []string{
	"BTC", "ETH", "HYPE", "SOL", "XRP",
	"xyz:SP500", "xyz:XYZ100",
	"xyz:CL", "xyz:GOLD", "xyz:SILVER",
	"xyz:SPCX", "xyz:NVDA", "xyz:TSLA", "xyz:AMD", "xyz:INTC", "xyz:MU",
	"xyz:GOOGL", "xyz:AMZN", "xyz:AAPL", "xyz:META",
	"xyz:JPY",
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg := config.Load()
	if err := cfg.ValidateExposure(); err != nil {
		log.Fatalf("unsafe network configuration: %v", err)
	}
	appCtx, cancelApp := context.WithCancel(context.Background())
	defer cancelApp()
	serverLifecycleCtx = appCtx
	startupGateActive.Store(true)
	startupReady.Store(false)

	priceCache := cacheinfra.NewMemoryPriceCache(1 * time.Second)
	metadataCache := cacheinfra.NewMemoryMetadataCache()
	// App-local per-address place budget only — not HL REST weight (see hlratelimit).
	rateLimiter := services.NewOrderPlacementBudget(1200, time.Minute)
	exch := exchange.NewHyperliquidAdapter()
	exch.StartCacheEviction(appCtx)
	runtime.exchAdapter = exch

	runtime.wsManager = wshandler.NewWebSocketManager(priceCache)
	runtime.wsManager.SetAPIToken(cfg.APIToken)
	runtime.wsManager.SetLifecycleContext(appCtx)
	builderDexes := []string{"xyz"}
	if dexes, err := exch.GetBuilderDexes(appCtx); err == nil {
		builderDexes = dexes
	} else {
		log.Printf("builder dex discovery failed at startup; using xyz compatibility default: %v", err)
	}
	runtime.wsManager.SetBuilderDexes(builderDexes)

	publisher := streaminfra.NewEventBus()
	accountRuntime := services.NewAccountRuntime()
	orderService := services.NewOrderService(exch, priceCache, metadataCache, rateLimiter, publisher, accountRuntime)
	orderService.SetLifecycleContext(appCtx)
	accountService := services.NewAccountService(exch, metadataCache, accountRuntime)
	marketService := services.NewMarketDataService(exch, priceCache, metadataCache, httpClient, services.MarketNewsOptions{
		XNewsMirrorBase: cfg.XNewsMirrorBase,
		XNewsAccounts:   cfg.XNewsAccounts,
		ExtraRSSFeeds:   cfg.NewsExtraRSSFeeds,
		BskyAccounts:    cfg.BskyNewsAccounts,
	})
	marketService.SetLifecycleContext(appCtx)
	marketService.SetNewsSink(runtime.wsManager.BroadcastNews)
	marketService.StartNewsAggregator(appCtx)
	botService := services.NewBotService(orderService, exch, httpClient, cfg.BotStateFile)
	botService.SetLifecycleContext(appCtx)
	typesafeClient := typesafe.NewClient("", "", "", httpClient)
	jevService := services.NewJevService(typesafeClient, exch, priceCache, metadataCache)
	botService.SetJevService(jevService)
	marketService.SetJevService(jevService)
	accountService.SetJevService(jevService)
	if jevService.IsAvailable() {
		slog.Info("typesafe jev service initialized", "model", jevService.Model())
	}
	preloadService := preload.NewPreloadService(preload.PreloadConfig{
		Context:    appCtx,
		HTTPClient: httpClient,
		APIURL:     exchange.MainnetAPIURL,
		Metadata:   metadataCache,
		Prices:     priceCache,
	})
	// Chart readiness consumes the same complete market universe accepted by
	// metadata-backed UI and preload paths. Load it before dependency
	// registration and snapshot restoration decide startup ordering.
	preloadService.LoadCoinDecimals()

	// Set account fetcher for downstream stream initial state
	runtime.wsManager.SetAccountFetcher(accountService)
	// Keep the adapter's execution mid cache warm from every allMids stream so
	// standard and builder trade hot paths skip redundant /info requests.
	runtime.wsManager.SetXyzMidsSink(exch.PrimeMids)
	runtime.wsManager.SetAccountRuntime(accountRuntime)
	runtime.wsManager.SetOrderService(orderService)
	runtime.wsManager.SetBotService(botService)
	runtime.wsManager.SetAllowedOrigins(cfg.AllowedOrigins)

	candleCfg := candlecache.ConfigFromEnv()
	nudgeCoordinatorCh := make(chan struct{}, 1)
	hintsFile := ""
	if candleCfg.SnapshotFile != "" {
		hintsFile = filepath.Join(filepath.Dir(candleCfg.SnapshotFile), "watchlist-hints.json")
	}
	hintSet := newWatchlistHintsWithPersistence(hintsFile, func() {
		select {
		case nudgeCoordinatorCh <- struct{}{}:
		default:
		}
	})

	startupChartCoins := append([]string(nil), pinnedCandleCoins...)
	if candleCfg.Enabled {
		dexes := append([]string{""}, builderDexes...)
		liqCtx, liqCancel := context.WithTimeout(appCtx, 15*time.Second)
		liqCtx = hlratelimit.WithRTTTimeout(liqCtx, 10*time.Second)
		liquidity, err := candlecache.FetchLiquidity(liqCtx, httpClient, exchange.MainnetAPIURL, dexes)
		liqCancel()
		if err != nil {
			slog.Warn("startup chart liquidity selection failed; using pinned markets", "error", err.Error())
		} else {
			startupChartCoins = candlecache.SelectCoins(liquidity, pinnedCandleCoins, candleCfg.OIMinUSD, candleCfg.MaxCoins)
		}
		// If saved watchlist coins are present, union them into startupChartCoins
		// so the user's personal favorites are hydrated before /readyz admits traffic.
		if savedWatchlist := hintSet.coins(); len(savedWatchlist) > 0 {
			seen := make(map[string]bool, len(startupChartCoins))
			for _, c := range startupChartCoins {
				seen[c] = true
			}
			for _, c := range savedWatchlist {
				if !seen[c] && metadataCache.Has(c) {
					seen[c] = true
					startupChartCoins = append(startupChartCoins, c)
				}
			}
		}
		slog.Info("startup chart universe selected",
			"markets", len(startupChartCoins),
			"metadataMarkets", len(metadataCache.Coins()),
			"oiMinUsd", candleCfg.OIMinUSD,
			"maxCoins", candleCfg.MaxCoins)
	}
	if candleCfg.Enabled {
		fetcher := candlecache.NewHTTPFetcher(httpClient, exchange.MainnetAPIURL, func() {
			// runtime.candleStore is assigned just below; by the time a fetch actually
			// runs (well after startup) it's always set.
			runtime.candleStore.PenalizeRateLimit()
		})
		runtime.candleStore = candlecache.New(fetcher, candleCfg.WeightPerMin)
		runtime.candleStore.SetBudgetWaitObserver(func(d time.Duration) {
			candleBudgetWaitSeconds.Observe(d.Seconds())
		})
		runtime.wsManager.SetCandleSink(runtime.candleStore)
		// Offer on-demand series to the bounded permanent live-feed set. Historical
		// cache residency is intentionally much larger; series outside the live
		// cap refresh stale tails through the background REST lane.
		runtime.candleStore.SetOnRegister(func(coin, interval string) {
			runtime.wsManager.AddPermanentCandleSubscriptions([][2]string{{coin, interval}})
		})
		// Release those permanent subscriptions when the store evicts a series
		// nothing has needed for the idle TTL, so long sessions don't accumulate
		// upstream subscriptions without bound.
		runtime.candleStore.SetOnEvict(func(coin, interval string) {
			runtime.wsManager.RemovePermanentCandleSubscriptions([][2]string{{coin, interval}})
		})
		// Register every startup timeframe's dependency set before snapshot
		// decode so permanent-feed priority and restore targets are deterministic
		// (default admit set + remainder 1h/4h/15m).
		runtime.candleStore.PrepareStartupUniverse(startupChartCoins)
	}
	if runtime.candleStore != nil {
		marketService.SetMispricingReferenceFetcher(func(
			ctx context.Context,
			coin string,
			startMs, endMs int64,
		) ([]services.MispricingReferenceCandle, error) {
			candles, err := runtime.candleStore.FetchBackgroundRange(ctx, coin, "1m", startMs, endMs)
			if err != nil {
				return nil, err
			}
			out := make([]services.MispricingReferenceCandle, 0, len(candles))
			for _, candle := range candles {
				out = append(out, services.MispricingReferenceCandle{
					OpenMs: candle.OpenMs, CloseMs: candle.CloseMs, Close: candle.Close,
				})
			}
			return out, nil
		})
	}
	// Bot candle reads use the background prefetch lane.
	candleFetcher := func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		innerReq := map[string]interface{}{
			"coin": coin, "interval": interval, "startTime": startTime, "endTime": endTime,
		}
		if dex := utils.GetDexName(coin); dex != "" {
			innerReq["dex"] = dex
		}
		body := map[string]interface{}{"type": "candleSnapshot", "req": innerReq}
		respBody, _, canceled, _, _, err := passthroughCandleSnapshot(
			ctx, exchange.MainnetAPIURL, chartPrefetchSem, body,
		)
		if canceled && err == nil {
			err = ctx.Err()
		}
		return respBody, err
	}
	botService.SetCandleSnapshotFetcher(candleFetcher)

	// Jev interactive discretionary signal and pre-trade audit candle reads use
	// dedicated jevCandleSem on infogovernor.Enrichment so interactive user requests
	// never queue behind background preloader sweeps.
	jevCandleFetcher := func(ctx context.Context, coin, interval string, startTime, endTime int64) ([]byte, error) {
		innerReq := map[string]interface{}{
			"coin": coin, "interval": interval, "startTime": startTime, "endTime": endTime,
		}
		if dex := utils.GetDexName(coin); dex != "" {
			innerReq["dex"] = dex
		}
		body := map[string]interface{}{"type": "candleSnapshot", "req": innerReq}
		respBody, _, canceled, _, _, err := passthroughCandleSnapshot(
			ctx, exchange.MainnetAPIURL, jevCandleSem, body,
		)
		if canceled && err == nil {
			err = ctx.Err()
		}
		return respBody, err
	}
	jevService.SetCandleSnapshotFetcher(jevCandleFetcher)

	if cfg.APIToken == "" {
		log.Println("PEZ_API_TOKEN not set — trading endpoints are open (fine for local use; set it only if you expose this server on an untrusted network).")
	}
	botService.SetStatusNotifier(func(account string, status models.BotStatus) {
		if runtime.wsManager != nil {
			runtime.wsManager.BroadcastBotStatus(account, status)
		}
	})

	execJournal, journalErr := services.NewExecutionJournal("data/execution_journal.jsonl", 1000)
	if journalErr != nil {
		slog.Warn("execution journal initialization failed", "err", journalErr)
	} else {
		defer execJournal.Close()
		orderService.SetJournal(execJournal)
		slog.Info("execution journal initialized", "file", "data/execution_journal.jsonl")
	}

	orderHandler := h.NewOrderHandler(orderService)
	accountHandler := h.NewAccountHandler(accountService, accountRuntime, services.NewCachedAccountService(services.DefaultAccountCacheTTL))
	marketHandler := h.NewMarketHandler(marketService)
	botHandler := h.NewBotHandler(botService)
	jevHandler := h.NewJevHandler(jevService)

	// Watchlist preload hints: primary tabs POST their watchlist here so the warm
	// coordinator keeps those (otherwise backend-invisible) coins warm. Validated
	// against the loaded perp universe so the unauthenticated endpoint can't warm
	// arbitrary symbols.
	knownCoin := func(coin string) bool {
		return metadataCache.Has(coin)
	}
	router := setupRouter(cfg, orderHandler, accountHandler, marketHandler, botHandler, jevHandler,
		preloadHintHandler(hintSet, knownCoin))

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.BindAddress, cfg.Port),
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	// Open the listener before snapshot decode / chart hydration so /healthz is
	// reachable while the (potentially multi-second) restore runs. Functional
	// routes stay 503 until startupReady.
	go serveHTTP(srv)

	// Restore the previous session's store before the market WS starts:
	// restored series load live-untrusted (degraded) but history-ready series
	// serve immutable ranges immediately; the first tick / tail REST heals the
	// live edge. onRegister re-creates only the bounded permanent live-feed set.
	if runtime.candleStore != nil && candleCfg.SnapshotFile != "" {
		slog.Info("restoring candle snapshot", "file", candleCfg.SnapshotFile)
		restoreStart := time.Now()
		if n, err := runtime.candleStore.LoadSnapshot(candleCfg.SnapshotFile); err != nil {
			slog.Warn("candle snapshot load failed", "error", err.Error(), "seriesLoaded", n)
		} else if n > 0 {
			slog.Info("candle store restored from snapshot", "series", n, "file", candleCfg.SnapshotFile, "took", time.Since(restoreStart).Round(time.Millisecond).String())
		}
	}
	if runtime.candleStore != nil {
		// Keep restored extra depth and raise display-window series toward
		// exchange retention so the coordinator fills older history after
		// /readyz instead of pruning it back to the 190d display window.
		if promoted := runtime.candleStore.PromoteExtendedLookbacks(startupChartCoins); promoted > 0 {
			slog.Info("candle store promoted extended lookbacks", "series", promoted)
		}
	}

	preloadService.PreloadAllPrices()

	go preloadKeyOnStartup()

	if err := botService.Restore(appCtx, keycache.GetWithFallback()); err != nil {
		if err == services.ErrBotRestoreNeedsKey {
			slog.Info("bot restore deferred until key is loaded")
		} else {
			slog.Error("bot restore failed", "error", err.Error())
		}
	}

	startPublisherBridge(publisher, accountRuntime)

	// Start WebSocket connections
	runtime.wsManager.SetLiquidationConfig(cfg.QuickNodeWsURL, cfg.QuickNodeMinNotional)
	runtime.wsManager.SetLiquidationUniverse(metadataCache.Coins())
	runtime.wsManager.StartLiquidationFeedsContext(appCtx)
	if runtime.candleStore != nil {
		runtime.candleStore.Start(appCtx)
		if candleCfg.SnapshotFile != "" {
			// Start crash-safe checkpoints before the potentially long first
			// all-market hydration pass. A terminated cold start then preserves
			// completed work instead of beginning from zero on the next launch.
			go runtime.candleStore.RunSnapshotLoop(appCtx, candleCfg.SnapshotFile, candleCfg.SnapshotInterval)
		}
	}
	runtime.wsManager.StartMarketWebSocket()
	if runtime.candleStore != nil {
		// Gate admits once every selected market's default display history and
		// CVD sources are history-ready. Remaining StartupTimeframes (1h/4h/15m)
		// hydrate in the background after /readyz so cold multi-TF barriers no
		// longer multiply admit latency; lazy passthrough covers any remainder miss.
		coins := startupChartCoins
		if err := runtime.candleStore.EnsureChartUniverse(appCtx, coins, chartrequirements.DefaultTimeframe); err != nil {
			log.Fatalf("startup chart hydration failed: %v", err)
		}
		slog.Info("default chart histories ready", "markets", len(coins), "timeframe", chartrequirements.DefaultTimeframe)
		if candleCfg.SnapshotFile != "" {
			snapshotFile := candleCfg.SnapshotFile
			go func() {
				if err := runtime.candleStore.SaveSnapshot(snapshotFile); err != nil {
					slog.Warn("candle snapshot save after admit failed", "error", err.Error())
				}
			}()
		}
	}
	runtime.wsManager.StartUserWebSocketLoop(appCtx)
	runtime.wsManager.StartHeartbeat()
	// Retries any TP/SL leg that failed to attach (rate limit, transient
	// exchange error, no signing key yet, etc.) until it succeeds — see
	// docs/API.md "TP/SL protection attach retry" for the escalating-alert
	// cadence this is paired with.
	orderService.StartProtectionRetrySweep(appCtx)
	startupReady.Store(true)

	// The warm coordinator is the single authority for what the candle store keeps
	// warm and in what order: it unions the clickable ticker lists (pinned, top
	// movers, market-mispricing candidates, watchlist hints) and warms them in
	// strict priority — interactive chart timeframes first, then deep 1w/1M
	// history — paced on the candle store's
	// background weight budget so it never bursts the HL allowance and always
	// yields to interactive chart loads. It replaces the old one-shot preload plus
	// the separately-timed mispricing warm-up.
	if runtime.candleStore != nil {
		coordinator := warmcoordinator.New(warmcoordinator.Deps{
			Pinned:   pinnedCandleCoins,
			MaxCoins: candleCfg.MaxCoins,
			MoverCoins: func(ctx context.Context) []string {
				ranked, err := marketService.GetRankedMovers(ctx)
				if err != nil {
					return nil
				}
				coins := make([]string, 0, len(ranked.Gainers)+len(ranked.Losers))
				for _, m := range ranked.Gainers {
					coins = append(coins, m.Coin)
				}
				for _, m := range ranked.Losers {
					coins = append(coins, m.Coin)
				}
				return coins
			},
			MispriceCoins:   marketService.MispricingCandidateCoins,
			Watchlist:       hintSet.coins,
			MinMoverSlots:   10,
			NudgeCh:         nudgeCoordinatorCh,
			ActiveSeries:    runtime.wsManager.ActiveCandleSeries,
			WarmReferences: marketService.WarmMispricingReferences,
			Warm:           runtime.candleStore.WarmDisplay,
			NeedsWarm:      runtime.candleStore.NeedsDisplayWarm,
			NeedsDeepen:    runtime.candleStore.NeedsWarm,
			Deepen:         runtime.candleStore.WarmOnDemand,
			Touch:          runtime.candleStore.MarkNeeded,
			CoreIntervals:   candlecache.CoreIntervals(),
			DeepIntervals:   candlecache.DeepIntervals(),
			PreferCoins:     startupChartCoins,
			PreferIntervals: chartrequirements.RemainderStartupTimeframes(),
		})
		go coordinator.Run(appCtx)
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	ctxShutdown, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelShutdown()

	// Stop bot before draining HTTP so fill-triggered refreshes don't race with shutdown
	botService.Stop(ctxShutdown, "")

	if err := srv.Shutdown(ctxShutdown); err != nil {
		log.Printf("Shutdown error: %v", err)
	}

	cancelApp()
	runtime.wsManager.StopMarketWebSocket()
	runtime.wsManager.StopUserWebSocket()
	runtime.wsManager.StopLiquidationFeeds()

	// Persist the candle store last — after the market WS stops feeding it —
	// so the next launch restores the freshest possible tails.
	if runtime.candleStore != nil && candleCfg.SnapshotFile != "" {
		if err := runtime.candleStore.SaveSnapshot(candleCfg.SnapshotFile); err != nil {
			log.Printf("candle snapshot save failed: %v", err)
		}
	}

	log.Println("✓ Server shutdown complete")
}

func serveHTTP(srv *http.Server) {
	fmt.Println("==================================================")
	fmt.Println("  PEZ$ Trading Terminal - GO BACKEND")
	fmt.Println("  Pure Go with native signing")
	fmt.Println("==================================================")
	fmt.Printf("  Server: http://%s\n", srv.Addr)
	fmt.Printf("  Health: http://%s/health\n", srv.Addr)
	fmt.Printf("  Ready:  http://%s/readyz\n", srv.Addr)
	fmt.Printf("  Metrics: http://%s/metrics\n", srv.Addr)
	fmt.Println("==================================================")

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// =============================================================================
// ROUTER
// =============================================================================

// protectedAPIRoutes lists the HTTP operations that move funds, mutate
// orders, or touch the signing key / raw exchange proxy. When PEZ_API_TOKEN is
// set these require a bearer token. Read/preview/status routes are intentionally
// left open so the page can load before a token is supplied; account-state
// privacy on those is covered by CORS (browsers) and the WS origin check.
var protectedAPIRoutes = middleware.RoutePolicy{
	{Method: http.MethodPost, Route: "/api/order"}:                  {},
	{Method: http.MethodPost, Route: "/api/bulk-orders"}:            {},
	{Method: http.MethodPost, Route: "/api/cancel-order"}:           {},
	{Method: http.MethodPost, Route: "/api/bulk-cancel"}:            {},
	{Method: http.MethodPost, Route: "/api/trigger-order"}:          {},
	{Method: http.MethodPost, Route: "/api/close-position"}:         {},
	{Method: http.MethodPost, Route: "/api/modify-order"}:           {},
	{Method: http.MethodPost, Route: "/api/twap-order"}:             {},
	{Method: http.MethodPost, Route: "/api/twap-cancel"}:            {},
	{Method: http.MethodPost, Route: "/api/cancel-by-cloid"}:        {},
	{Method: http.MethodPost, Route: "/api/bulk-modify-orders"}:     {},
	{Method: http.MethodPost, Route: "/api/schedule-cancel"}:        {},
	{Method: http.MethodPost, Route: "/api/update-isolated-margin"}: {},
	{Method: http.MethodPost, Route: "/api/set-leverage"}:           {},
	{Method: http.MethodPost, Route: "/api/set-key"}:                {},
	{Method: http.MethodPost, Route: "/api/clear-key"}:              {},
	{Method: http.MethodPost, Route: "/api/hl"}:                     {},
	{Method: http.MethodPost, Route: "/api/chart-candles"}:          {},
	{Method: http.MethodPost, Route: "/api/cvd-scan"}:               {},
	{Method: http.MethodPost, Route: "/api/market-subscribe"}:       {},
	{Method: http.MethodPost, Route: "/api/preload-hint"}:           {},
	{Method: http.MethodPost, Route: "/api/bot/start"}:              {},
	{Method: http.MethodPost, Route: "/api/bot/stop"}:               {},
	{Method: http.MethodGet, Route: "/api/bot/status"}:              {},
	{Method: http.MethodGet, Route: "/api/has-saved-key"}:           {},
	{Method: http.MethodPost, Route: "/api/key-address"}:            {},
	{Method: http.MethodGet, Route: "/metrics"}:                     {},
	// TypeSafe Jev AI routes
	{Method: http.MethodGet, Route: "/api/jev/status"}:              {},
	{Method: http.MethodPost, Route: "/api/jev/analyze"}:            {},
	{Method: http.MethodGet, Route: "/api/jev/signal"}:              {},
	{Method: http.MethodPost, Route: "/api/jev/signal"}:             {},
	{Method: http.MethodPost, Route: "/api/jev/classify-news"}:      {},
	{Method: http.MethodPost, Route: "/api/jev/pre-trade-audit"}:    {},
	{Method: http.MethodPost, Route: "/api/jev/evaluate-mispricing"}: {},
	// Durable UI preferences (disk-backed; outlive browser cache clears).
	{Method: http.MethodPut, Route: "/api/color-palette-templates"}: {},
}

func setupRouter(
	cfg *config.Config,
	orderHandler *h.OrderHandler,
	accountHandler *h.AccountHandler,
	marketHandler *h.MarketHandler,
	botHandler *h.BotHandler,
	jevHandler *h.JevHandler,
	preloadHint gin.HandlerFunc,
) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	_ = r.SetTrustedProxies(nil)
	r.Use(gin.Recovery())
	r.Use(startupReadinessGate())
	r.Use(metricsMiddleware())
	r.Use(auditLogMiddleware(protectedAPIRoutes))
	r.Use(middleware.LimitAPIRequestBody())
	r.Use(middleware.CORS(cfg.AllowedOrigins))
	r.Use(middleware.SecurityHeaders(cfg.WebAPIBaseURL))
	r.Use(middleware.RequireAPIToken(cfg.APIToken, protectedAPIRoutes))

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":         "ok",
			"uptime_seconds": time.Since(startTime).Seconds(),
		})
	})
	r.GET("/readyz", func(c *gin.Context) {
		ready := !startupGateActive.Load() || startupReady.Load()
		status := http.StatusOK
		if !ready {
			status = http.StatusServiceUnavailable
		}
		response := gin.H{"ready": ready}
		if runtime.wsManager != nil {
			response["bybitLiquidations"] = runtime.wsManager.LiquidationFeedStatus()
		}
		c.JSON(status, response)
	})

	r.GET("/health", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()

		apiHealthy := checkCachedHyperliquidAPI(ctx)
		ready := !startupGateActive.Load() || startupReady.Load()

		streamClientCount := runtime.wsManager.StreamClientCount()
		marketWsConnected := runtime.wsManager.IsMarketConnected()
		liquidationStatus := runtime.wsManager.LiquidationFeedStatus()
		bboCache := runtime.wsManager.GetBBOCache()

		status := "ok"
		if !apiHealthy {
			status = "degraded"
		}

		c.JSON(http.StatusOK, gin.H{
			"status":             status,
			"ready":              ready,
			"api_healthy":        apiHealthy,
			"stream_clients":     streamClientCount,
			"market_websocket":   marketWsConnected,
			"bybit_liquidations": liquidationStatus,
			"uptime_seconds":     time.Since(startTime).Seconds(),
			"cached_prices":      len(bboCache),
		})
	})

	if cfg.ServeWeb {
		webDir := resolveWebDir()

		// Content-addressed trees (hashed /dist bundle and fingerprint-stable
		// /assets) are safe to cache forever. Everything else
		// — index.html, config.js, styles.css, and the raw /src dev fallback — is
		// served no-store so a hashed-bundle deploy is the only cache key.
		immutablePrefixes := []string{"/dist/", "/assets/"}
		staticHandler := func(c *gin.Context) {
			p := c.Request.URL.Path
			cacheable := false
			for _, pre := range immutablePrefixes {
				if strings.HasPrefix(p, pre) {
					cacheable = true
					break
				}
			}
			if cacheable {
				c.Header("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
				c.Header("Pragma", "no-cache")
				c.Header("Expires", "0")
			}
			c.Next()
		}

		r.Use(staticHandler)
		r.GET("/config.js", func(c *gin.Context) {
			c.Header("Content-Type", "application/javascript; charset=utf-8")
			c.String(http.StatusOK, "window.__PEZ_CONFIG__ = Object.assign({}, window.__PEZ_CONFIG__ || {}, { apiBaseUrl: %q });\n", cfg.WebAPIBaseURL)
		})
		r.GET("/styles.css", func(c *gin.Context) {
			servePrecompressedFile(c, filepath.Join(webDir, "styles.css"))
		})
		r.HEAD("/styles.css", func(c *gin.Context) {
			servePrecompressedFile(c, filepath.Join(webDir, "styles.css"))
		})
		r.StaticFile("/favicon.ico", filepath.Join(webDir, "assets", "favicon", "favicon.ico"))
		registerFilteredStatic(r, "/assets", filepath.Join(webDir, "assets"), map[string]struct{}{
			".gif":   {},
			".ico":   {},
			".jpeg":  {},
			".jpg":   {},
			".png":   {},
			".svg":   {},
			".ttf":   {},
			".webp":  {},
			".woff":  {},
			".woff2": {},
		})
		registerFilteredStatic(r, "/src", filepath.Join(webDir, "src"), map[string]struct{}{
			".js":  {},
			".mjs": {},
		})
		registerFilteredStatic(r, "/dist", filepath.Join(webDir, "dist"), map[string]struct{}{
			".css": {},
			".js":  {},
			".mjs": {},
			".map": {},
		})

		// Prefer the bundled production shell (dist/index.html, which points at the
		// hashed /dist bundle) when a build is present; otherwise fall back to the
		// raw index.html that loads /src/main.js, so `make run` works without a
		// build step in dev.
		indexPath := filepath.Join(webDir, "index.html")
		if distIndex := filepath.Join(webDir, "dist", "index.html"); fileExists(distIndex) {
			indexPath = distIndex
		}
		rootHandler := func(c *gin.Context) {
			c.Header("Content-Type", "text/html")
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
			c.Header("Pragma", "no-cache")
			c.Header("Expires", "0")
			servePrecompressedFile(c, indexPath)
		}
		r.GET("/", rootHandler)
		r.HEAD("/", rootHandler)
	} else {
		r.GET("/", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{
				"status":    "ok",
				"serve_web": false,
			})
		})
	}

	r.POST("/api/order", orderHandler.PlaceOrder)
	r.POST("/api/bulk-orders", orderHandler.PlaceBulkOrders)
	r.POST("/api/scale-preview", orderHandler.ScalePreview)
	r.POST("/api/cancel-order", orderHandler.CancelOrder)
	r.POST("/api/bulk-cancel", orderHandler.BulkCancel)
	r.POST("/api/trigger-order", orderHandler.PlaceTrigger)
	r.POST("/api/close-position", accountHandler.ClosePosition)
	r.POST("/api/account", accountHandler.GetAccount)
	r.POST("/api/key-address", orderHandler.KeyAddress)
	r.POST("/api/modify-order", orderHandler.ModifyOrder)
	r.POST("/api/twap-order", orderHandler.PlaceTwap)
	r.POST("/api/twap-cancel", orderHandler.CancelTwap)
	r.POST("/api/cancel-by-cloid", orderHandler.CancelByCloid)
	r.POST("/api/bulk-modify-orders", orderHandler.BulkModifyOrders)
	r.POST("/api/schedule-cancel", orderHandler.ScheduleCancel)
	r.GET("/api/journal/executions", orderHandler.GetJournalExecutions)
	r.GET("/api/journal/summary", orderHandler.GetJournalSummary)
	r.POST("/api/update-isolated-margin", accountHandler.UpdateMargin)
	r.POST("/api/set-leverage", accountHandler.SetLeverage)
	r.POST("/api/fills", accountHandler.GetFills)
	r.POST("/api/active-asset-data", accountHandler.GetActiveAssetData)
	r.POST("/api/order-preview", accountHandler.OrderPreview)
	r.POST("/api/l2-snapshot", marketHandler.GetL2Snapshot)
	r.GET("/api/coin-meta", marketHandler.GetCoinMeta)
	r.GET("/api/24h-changes", marketHandler.Get24hChanges)
	r.GET("/api/market-movers", marketHandler.GetMarketMovers)
	r.GET("/api/stock-mispricing", marketHandler.GetStockMispricing)
	r.GET("/api/news-config", marketHandler.GetNewsConfig)
	r.GET("/api/news", marketHandler.GetNews)

	// Durable color palette templates (survive browser storage clears).
	r.GET("/api/color-palette-templates", getColorPaletteTemplates)
	r.PUT("/api/color-palette-templates", putColorPaletteTemplates)

	r.GET("/api/has-saved-key", hasSavedKey)
	r.POST("/api/set-key", setKey)
	r.POST("/api/clear-key", clearKey)
	r.POST("/api/hl", proxyHL)
	r.POST("/api/chart-candles", chartCandleHandler)
	r.POST("/api/cvd-scan", cvdScanHandler)

	// Domain streams are independent data planes.
	r.GET("/api/trading-stream", runtime.wsManager.TradingStreamHandler)
	r.GET("/api/market-stream", runtime.wsManager.MarketStreamHandler)
	r.POST("/api/market-subscribe", runtime.wsManager.MarketSubscribeHandler)
	if preloadHint != nil {
		r.POST("/api/preload-hint", preloadHint)
	}
	r.GET("/api/bot/status", botHandler.Status)
	r.POST("/api/bot/start", botHandler.Start)
	r.POST("/api/bot/stop", botHandler.Stop)

	if jevHandler != nil {
		r.GET("/api/jev/status", jevHandler.Status)
		r.POST("/api/jev/analyze", jevHandler.Analyze)
		r.GET("/api/jev/signal", jevHandler.Signal)
		r.POST("/api/jev/signal", jevHandler.Signal)
		r.POST("/api/jev/classify-news", jevHandler.ClassifyNews)
		r.POST("/api/jev/pre-trade-audit", jevHandler.PreTradeAudit)
		r.POST("/api/jev/evaluate-mispricing", jevHandler.EvaluateMispricing)
	}

	r.GET("/metrics", metricsHandler)

	return r
}

func startupReadinessGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !startupGateActive.Load() || startupReady.Load() || c.Request.Method == http.MethodOptions {
			c.Next()
			return
		}
		switch c.Request.URL.Path {
		case "/health", "/healthz", "/readyz", "/metrics":
			c.Next()
		default:
			c.Header("Retry-After", "1")
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "server initialization in progress",
			})
		}
	}
}

// =============================================================================
// STREAM BROADCAST (order responses)
// =============================================================================

// BroadcastTrading fans out unscoped trading-lane frames (not market).
func BroadcastTrading(data []byte) {
	if runtime.wsManager != nil {
		runtime.wsManager.BroadcastToTradingClients(data)
	}
}

// BroadcastToClients is the historical name for BroadcastTrading (order bridge fallback).
func BroadcastToClients(data []byte) {
	BroadcastTrading(data)
}

func startPublisherBridge(publisher streamport.Publisher, accountRuntime *services.AccountRuntime) {
	if publisher == nil {
		return
	}

	events := publisher.Subscribe()
	go func() {
		for event := range events {
			switch event.Type {
			case streamport.EventOrderUpdate:
				account := ""
				payload := event.Payload
				if envelope, ok := event.Payload.(map[string]interface{}); ok {
					if accountValue, ok := envelope["account"].(string); ok {
						account = normalizeAccountAddress(accountValue)
					}
					if inner, ok := envelope["data"]; ok {
						payload = inner
					}
				}
				msg := map[string]interface{}{
					"channel": "orderUpdates",
					"data":    payload,
				}
				if payload, err := json.Marshal(msg); err == nil {
					if account != "" && runtime.wsManager != nil {
						runtime.wsManager.BroadcastToAccount(account, payload)
						runtime.wsManager.RequestAccountRefresh(account)
						if accountRuntime != nil {
							if snapshot := accountRuntime.GetSnapshot(account); snapshot.HasSnapshot {
								if canonicalPayload := accountRuntime.BuildCanonicalSnapshotMessage(snapshot); canonicalPayload != nil {
									runtime.wsManager.BroadcastToAccount(account, canonicalPayload)
								}
							}
						}
					} else {
						BroadcastTrading(payload)
					}
				}
			}
		}
	}()
}

// =============================================================================
// API HELPERS
// =============================================================================

func checkHyperliquidAPI(ctx context.Context) bool {
	ctx = infogovernor.WithLane(ctx, infogovernor.Enrichment)
	req, err := http.NewRequestWithContext(ctx, "POST",
		exchange.MainnetAPIURL+"/info",
		bytes.NewBuffer([]byte(`{"type":"meta"}`)))
	if err != nil {
		return false
	}
	// Without this header Hyperliquid rejects the probe with 415, which made
	// /health report "degraded" unconditionally while the API was fine.
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// checkCachedHyperliquidAPI keeps health polling from becoming another source
// of upstream load. Holding the lock during the short probe also coalesces a
// burst of concurrent health requests into one network call.
func checkCachedHyperliquidAPI(ctx context.Context) bool {
	healthProbeMu.Lock()
	defer healthProbeMu.Unlock()
	if time.Since(healthProbeAt) < 10*time.Second {
		return healthProbeOK
	}
	healthProbeOK = checkHyperliquidAPI(ctx)
	healthProbeAt = time.Now()
	return healthProbeOK
}

func metricsHandler(c *gin.Context) {
	h := promhttp.Handler()
	h.ServeHTTP(c.Writer, c.Request)
}
