package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	"hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/pkg/utils"
)

// hyperliquidInfoURL is the mainnet /info endpoint for the bot's direct
// candle fetches (the exchange adapter constant is shadowed here by the
// ports/exchange import).
const hyperliquidInfoURL = "https://api.hyperliquid.xyz/info"

const (
	botLogLimit             = 200
	botRefreshInterval      = time.Minute
	botCandleInterval       = "15m"
	botMinStdDevOffset      = 1.0
	botMaxStdDevOffset      = 4.0
	botDefaultOrdersPerSide = 8
	botDefaultOrderSize     = 15.0
	botDefaultSkew          = 1.0
	botVwapDays             = 3
	botStdDevRatio          = 5.5
	botKalmanGain           = 0.05
)

var ErrBotRestoreNeedsKey = fmt.Errorf("bot restore requires private key")

type BotService struct {
	orderService *OrderService
	exchange     exchange.Exchange
	httpClient   *http.Client
	// candleSnapshotFetcher is injected by the server so bot reads share the
	// candle store, priority governor, concurrency cap, and repair path used by
	// charts. The direct HTTP implementation remains the standalone fallback.
	candleSnapshotFetcher func(context.Context, string, string, int64, int64) ([]byte, error)
	stateFile             string
	notifier              func(string, models.BotStatus)
	jevService            *JevService

	mu           sync.RWMutex
	session      *botSession
	logSeq       int64
	lifecycleCtx context.Context
}

// SetJevService configures the TypeSafe Jev decision engine for AI strategies.
func (s *BotService) SetJevService(js *JevService) {
	s.mu.Lock()
	s.jevService = js
	s.mu.Unlock()
}

// SetCandleSnapshotFetcher routes bot candle reads through the server-owned
// market-data boundary. Configure it before Restore/Start begins a bot loop.
func (s *BotService) SetCandleSnapshotFetcher(fetcher func(context.Context, string, string, int64, int64) ([]byte, error)) {
	s.candleSnapshotFetcher = fetcher
}

func (s *BotService) SetLifecycleContext(ctx context.Context) { s.lifecycleCtx = ctx }

func (s *BotService) backgroundContext() context.Context {
	if s.lifecycleCtx != nil {
		return s.lifecycleCtx
	}
	return context.Background()
}

type botSession struct {
	ctx        context.Context
	cancel     context.CancelFunc
	privateKey string
	account    string
	strategy   string
	coin       string
	config     models.BotConfig
	startedAt  time.Time
	updatedAt  time.Time
	lastRunAt  time.Time
	lastPrice  float64
	vwap       float64
	stdDev     float64
	lastError  string
	orderIDs       []int64
	prevKVWAP      *float64
	toxicHaltUntil time.Time
	logs           []models.BotLogEntry
	signalCh       chan struct{}
}

type botCandle struct {
	Time   int64
	High   float64
	Low    float64
	Close  float64
	Volume float64
}

type botPersistedState struct {
	Running   bool             `json:"running"`
	Account   string           `json:"account"`
	Strategy  string           `json:"strategy"`
	Coin      string           `json:"coin"`
	Config    models.BotConfig `json:"config"`
	StartedAt time.Time        `json:"startedAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
	LastRunAt time.Time        `json:"lastRunAt"`
	LastPrice float64          `json:"lastPrice"`
	VWAP      float64          `json:"vwap"`
	StdDev    float64          `json:"stdDev"`
	OrderIDs  []int64          `json:"orderIds"`
	LastError string           `json:"lastError"`
	PrevKVWAP *float64         `json:"prevKVwap,omitempty"`
}

func NewBotService(orderService *OrderService, exch exchange.Exchange, httpClient *http.Client, stateFile string) *BotService {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second, Transport: hlratelimit.WrapTransport(nil)}
	}
	return &BotService{
		orderService: orderService,
		exchange:     exch,
		httpClient:   httpClient,
		stateFile:    strings.TrimSpace(stateFile),
	}
}

func (s *BotService) SetStatusNotifier(notifier func(string, models.BotStatus)) {
	s.mu.Lock()
	s.notifier = notifier
	s.mu.Unlock()
}

func (s *BotService) Start(ctx context.Context, privateKey string, req models.BotStartRequest) (*models.BotStatus, error) {
	if strings.TrimSpace(privateKey) == "" {
		return nil, fmt.Errorf("no private key loaded")
	}

	strategy := normalizeBotStrategy(req.Strategy)
	if strategy == "" {
		return nil, fmt.Errorf("unsupported strategy")
	}

	coin := strings.TrimSpace(req.Coin)
	if coin == "" {
		return nil, fmt.Errorf("coin is required")
	}

	cfg := normalizeBotConfig(req.Config)
	account, err := s.orderService.resolveTradingAccount(privateKey)
	if err != nil {
		return nil, err
	}

	s.Stop(ctx, privateKey)

	runCtx, cancel := context.WithCancel(s.backgroundContext())
	session := &botSession{
		ctx:        runCtx,
		cancel:     cancel,
		privateKey: privateKey,
		account:    account,
		strategy:   strategy,
		coin:       coin,
		config:     cfg,
		startedAt:  time.Now().UTC(),
		updatedAt:  time.Now().UTC(),
		signalCh:   make(chan struct{}, 1),
	}
	s.appendLog(session, "info", fmt.Sprintf("starting %s on %s", strategy, coin))

	s.mu.Lock()
	s.session = session
	s.mu.Unlock()

	if err := s.runCycle(session); err != nil {
		s.appendLog(session, "error", err.Error())
		s.mu.Lock()
		if s.session == session {
			s.session = nil
			_ = s.clearStateFileLocked()
		}
		s.mu.Unlock()
		cancel()
		return nil, err
	}

	go s.loop(session)
	status := s.Status()
	s.publishStatus(status)
	return &status, nil
}

func (s *BotService) Stop(ctx context.Context, privateKey string) {
	s.mu.Lock()
	session := s.session
	if session == nil {
		s.mu.Unlock()
		return
	}
	s.session = nil
	s.mu.Unlock()

	session.cancel()
	s.appendLog(session, "info", "stopping bot")
	cancelCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	key := strings.TrimSpace(privateKey)
	if key == "" {
		key = session.privateKey
	}
	if err := s.cancelSessionOrders(cancelCtx, session, key); err != nil {
		s.appendLog(session, "error", "stop cancel failed: "+err.Error())
	}
	s.mu.Lock()
	_ = s.clearStateFileLocked()
	s.mu.Unlock()
	s.publishStatus(models.BotStatus{Running: false})
}

func (s *BotService) Status() models.BotStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.session == nil {
		return models.BotStatus{Running: false}
	}
	return snapshotBotStatus(s.session)
}

func (s *BotService) loop(session *botSession) {
	ticker := time.NewTicker(botRefreshInterval)
	defer ticker.Stop()

	for {
		select {
		case <-session.ctx.Done():
			return
		case <-session.signalCh:
			if err := s.runCycle(session); err != nil {
				s.appendLog(session, "error", err.Error())
				s.setSessionError(session, err.Error())
			}
		case <-ticker.C:
			if err := s.runCycle(session); err != nil {
				s.appendLog(session, "error", err.Error())
				s.setSessionError(session, err.Error())
			}
		}
	}
}

func (s *BotService) runCycle(session *botSession) error {
	if !s.isActiveSession(session) {
		return context.Canceled
	}

	ctx, cancel := context.WithTimeout(session.ctx, 15*time.Second)
	defer cancel()

	price, err := s.exchange.GetMidPrice(ctx, session.coin, false)
	if err != nil {
		return fmt.Errorf("price fetch failed: %w", err)
	}
	if price <= 0 {
		return fmt.Errorf("invalid mid price")
	}

	candles, err := s.fetchCandles(ctx, session.coin, botCandleInterval, time.Now().Add(-time.Duration(botVwapDays*24*botStdDevRatio)*time.Hour).UnixMilli(), time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("candle fetch failed: %w", err)
	}
	vwap, stdDev, err := computeBotBands(candles, session.prevKVWAP)
	if err != nil {
		return err
	}
	session.prevKVWAP = &vwap

	cfg := session.config
	if session.strategy == "jev-orderflow" {
		if time.Now().Before(session.toxicHaltUntil) {
			remaining := time.Until(session.toxicHaltUntil).Round(time.Second)
			s.appendLog(session, "info", fmt.Sprintf("Jev: in toxic flow cooldown window (%s remaining); holding off quotes", remaining))
			return nil
		}

		s.mu.RLock()
		js := s.jevService
		s.mu.RUnlock()
		if js != nil && js.IsAvailable() {
			jevResult, jErr := js.Analyze(ctx, session.coin)
			if jErr != nil {
				s.appendLog(session, "warning", "jev analysis: "+jErr.Error())
			} else if jevResult != nil {
				if jevResult.ToxicFlowRisk > 0.65 {
					session.toxicHaltUntil = time.Now().Add(30 * time.Second)
					msg := fmt.Sprintf("Jev: toxic flow risk elevated (%.0f%%); cancelling quotes and cooling down for 30s", jevResult.ToxicFlowRisk*100)
					s.appendLog(session, "warning", msg)
					_ = s.cancelSessionOrders(ctx, session, session.privateKey)
					return nil
				}
				if jevResult.Direction == "bullish" {
					cfg.BidSkew = math.Min(4.0, cfg.BidSkew*1.4)
					cfg.AskSkew = math.Max(0.5, cfg.AskSkew*0.7)
					s.appendLog(session, "info", fmt.Sprintf("Jev decision: BULLISH (%.0f%% conf, score %.1f) - skewed bids", jevResult.DirectionConfidence*100, jevResult.ConfidenceScore))
				} else if jevResult.Direction == "bearish" {
					cfg.AskSkew = math.Min(4.0, cfg.AskSkew*1.4)
					cfg.BidSkew = math.Max(0.5, cfg.BidSkew*0.7)
					s.appendLog(session, "info", fmt.Sprintf("Jev decision: BEARISH (%.0f%% conf, score %.1f) - skewed asks", jevResult.DirectionConfidence*100, jevResult.ConfidenceScore))
				} else {
					s.appendLog(session, "info", "Jev decision: NEUTRAL - balanced quoting")
				}
			}
		}

		// Inventory skewing: prevent one-way position accumulation
		if s.exchange != nil && session.account != "" {
			if assetData, aErr := s.exchange.GetActiveAssetData(ctx, session.account, session.coin); aErr == nil && assetData != nil {
				if posMap, ok := assetData["position"].(map[string]interface{}); ok && posMap != nil {
					szi := parseBotFloat(posMap["szi"])
					if szi != 0 && price > 0 {
						posUSD := szi * price
						maxGridUSD := cfg.OrderSize * float64(cfg.OrdersPerSide)
						if maxGridUSD > 0 {
							invRatio := math.Max(-1.0, math.Min(1.0, posUSD/maxGridUSD))
							if invRatio > 0.25 {
								cfg.BidSkew = math.Max(0.4, cfg.BidSkew*(1.0-0.4*invRatio))
								cfg.AskSkew = math.Min(4.0, cfg.AskSkew*(1.0+0.5*invRatio))
								s.appendLog(session, "info", fmt.Sprintf("Inventory skew: long exposure $%.0f -> dampening bids, tightening asks", posUSD))
							} else if invRatio < -0.25 {
								cfg.AskSkew = math.Max(0.4, cfg.AskSkew*(1.0-0.4*math.Abs(invRatio)))
								cfg.BidSkew = math.Min(4.0, cfg.BidSkew*(1.0+0.5*math.Abs(invRatio)))
								s.appendLog(session, "info", fmt.Sprintf("Inventory skew: short exposure $%.0f -> dampening asks, tightening bids", posUSD))
							}
						}
					}
				}
			}
		}
	}

	orders := buildBotOrders(session.coin, price, vwap, stdDev, cfg)
	if len(orders) == 0 {
		return fmt.Errorf("no valid orders generated at current price")
	}

	if err := s.cancelSessionOrders(ctx, session, session.privateKey); err != nil {
		s.appendLog(session, "warning", "cancel before replace failed: "+err.Error())
	}

	result, err := s.orderService.PlaceBulkOrders(ctx, models.BulkOrderRequest{
		PrivateKey: session.privateKey,
		Orders:     orders,
	})
	if err != nil {
		return fmt.Errorf("order placement failed: %w", err)
	}

	orderIDs := extractBotOrderIDs(result)
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != session {
		return context.Canceled
	}
	session.lastPrice = price
	session.vwap = vwap
	session.stdDev = stdDev
	session.lastRunAt = now
	session.updatedAt = now
	session.orderIDs = orderIDs
	session.lastError = ""
	msg := fmt.Sprintf("placed %d orders on %s at %.2f (vwap %.2f, stddev %.2f)", len(orderIDs), session.coin, price, vwap, stdDev)
	s.appendLogLocked(session, "success", msg)
	_ = s.saveStateLocked(session)
	status := snapshotBotStatus(session)
	go s.publishStatus(status)
	return nil
}

func (s *BotService) fetchCandles(ctx context.Context, coin, interval string, startTime, endTime int64) ([]botCandle, error) {
	if s.candleSnapshotFetcher != nil {
		payload, err := s.candleSnapshotFetcher(ctx, coin, interval, startTime, endTime)
		if err != nil {
			return nil, err
		}
		return decodeBotCandles(payload)
	}
	ctx = infogovernor.WithLane(ctx, infogovernor.Background)

	body := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin":      coin,
			"interval":  interval,
			"startTime": startTime,
			"endTime":   endTime,
		},
	}
	if utils.IsHip3Coin(coin) {
		body["req"].(map[string]interface{})["dex"] = "xyz"
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hyperliquidInfoURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("upstream HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	payload, err = io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return decodeBotCandles(payload)
}

func decodeBotCandles(payload []byte) ([]botCandle, error) {
	var rawCandles []map[string]interface{}
	if err := json.Unmarshal(payload, &rawCandles); err != nil {
		return nil, err
	}

	candles := make([]botCandle, 0, len(rawCandles))
	for _, raw := range rawCandles {
		candles = append(candles, botCandle{
			Time:   parseBotInt64(raw["t"]),
			High:   parseBotFloat(raw["h"]),
			Low:    parseBotFloat(raw["l"]),
			Close:  parseBotFloat(raw["c"]),
			Volume: parseBotFloat(raw["v"]),
		})
	}
	return candles, nil
}

func (s *BotService) cancelSessionOrders(ctx context.Context, session *botSession, privateKey string) error {
	orderIDs := append([]int64(nil), session.orderIDs...)
	if len(orderIDs) == 0 {
		return nil
	}

	cancels := make([]map[string]interface{}, 0, len(orderIDs))
	for _, oid := range orderIDs {
		cancels = append(cancels, map[string]interface{}{
			"coin": session.coin,
			"oid":  oid,
		})
	}

	_, err := s.orderService.BulkCancel(ctx, models.BulkCancelRequest{
		PrivateKey: privateKey,
		Cancels:    cancels,
	})
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == session {
		session.orderIDs = nil
		session.updatedAt = time.Now().UTC()
		_ = s.saveStateLocked(session)
	}
	return nil
}

func (s *BotService) appendLog(session *botSession, logType, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendLogLocked(session, logType, message)
}

func (s *BotService) appendLogLocked(session *botSession, logType, message string) {
	if session == nil {
		return
	}
	s.logSeq++
	session.logs = append(session.logs, models.BotLogEntry{
		Seq:     s.logSeq,
		Time:    time.Now().UTC(),
		Type:    logType,
		Message: message,
	})
	if len(session.logs) > botLogLimit {
		session.logs = append([]models.BotLogEntry(nil), session.logs[len(session.logs)-botLogLimit:]...)
	}
	session.updatedAt = time.Now().UTC()
	_ = s.saveStateLocked(session)
}

func (s *BotService) setSessionError(session *botSession, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != session {
		return
	}
	session.lastError = message
	session.updatedAt = time.Now().UTC()
	_ = s.saveStateLocked(session)
}

func (s *BotService) isActiveSession(session *botSession) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.session == session
}

func snapshotBotStatus(session *botSession) models.BotStatus {
	startedAt := session.startedAt
	updatedAt := session.updatedAt
	status := models.BotStatus{
		Running:   true,
		Strategy:  session.strategy,
		Coin:      session.coin,
		Account:   session.account,
		Config:    session.config,
		StartedAt: &startedAt,
		UpdatedAt: &updatedAt,
		LastPrice: session.lastPrice,
		VWAP:      session.vwap,
		StdDev:    session.stdDev,
		OrderIDs:  append([]int64(nil), session.orderIDs...),
		LastError: session.lastError,
		Logs:      append([]models.BotLogEntry(nil), session.logs...),
	}
	if !session.lastRunAt.IsZero() {
		lastRunAt := session.lastRunAt
		status.LastRunAt = &lastRunAt
	}
	return status
}

func (s *BotService) HandleUserFills(account string, fills []interface{}) {
	s.mu.RLock()
	session := s.session
	if session == nil || len(fills) == 0 {
		s.mu.RUnlock()
		return
	}
	orderIDs := append([]int64(nil), session.orderIDs...)
	coin := session.coin
	signalCh := session.signalCh
	s.mu.RUnlock()

	if len(orderIDs) == 0 || signalCh == nil {
		return
	}

	orderSet := make(map[int64]struct{}, len(orderIDs))
	for _, oid := range orderIDs {
		orderSet[oid] = struct{}{}
	}

	for _, rawFill := range fills {
		fill, ok := rawFill.(map[string]interface{})
		if !ok || fill == nil {
			continue
		}
		if fillCoin, _ := fill["coin"].(string); strings.TrimSpace(fillCoin) != "" && !strings.EqualFold(strings.TrimSpace(fillCoin), coin) {
			continue
		}
		if _, ok := orderSet[extractRuntimeNestedOid(fill)]; !ok {
			continue
		}
		select {
		case signalCh <- struct{}{}:
		default:
		}
		s.mu.Lock()
		if s.session != nil && s.session.signalCh == signalCh {
			s.appendLogLocked(s.session, "info", "tracked fill detected, refreshing bot orders")
		}
		s.mu.Unlock()
		return
	}
}

func (s *BotService) Restore(ctx context.Context, privateKey string) error {
	state, err := s.loadState()
	if err != nil || state == nil || !state.Running {
		return err
	}
	if strings.TrimSpace(privateKey) == "" {
		return ErrBotRestoreNeedsKey
	}

	restoredAccount := strings.TrimSpace(state.Account)
	if restoredAccount == "" {
		resolvedAccount, resolveErr := s.orderService.resolveTradingAccount(privateKey)
		if resolveErr != nil {
			return resolveErr
		}
		restoredAccount = resolvedAccount
	}
	strategy := normalizeBotStrategy(state.Strategy)
	coin := strings.TrimSpace(state.Coin)
	if strategy == "" || coin == "" {
		return fmt.Errorf("cannot restore invalid bot snapshot")
	}

	runCtx, cancel := context.WithCancel(s.backgroundContext())
	session := &botSession{
		ctx:        runCtx,
		cancel:     cancel,
		privateKey: privateKey,
		account:    restoredAccount,
		strategy:   strategy,
		coin:       coin,
		config:     normalizeBotConfig(state.Config),
		startedAt:  state.StartedAt,
		updatedAt:  state.UpdatedAt,
		lastRunAt:  state.LastRunAt,
		lastPrice:  state.LastPrice,
		vwap:       state.VWAP,
		stdDev:     state.StdDev,
		lastError:  state.LastError,
		orderIDs:   append([]int64(nil), state.OrderIDs...),
		prevKVWAP:  state.PrevKVWAP,
		signalCh:   make(chan struct{}, 1),
	}

	s.mu.Lock()
	s.session = session
	s.appendLogLocked(session, "info", fmt.Sprintf("restored %s on %s from state file", session.strategy, session.coin))
	s.mu.Unlock()

	if err := s.runCycle(session); err != nil {
		s.appendLog(session, "error", "restore failed: "+err.Error())
		s.mu.Lock()
		if s.session == session {
			s.session = nil
			_ = s.clearStateFileLocked()
		}
		s.mu.Unlock()
		cancel()
		return err
	}

	go s.loop(session)
	s.publishStatus(s.Status())
	return nil
}

func normalizeBotStrategy(strategy string) string {
	switch strings.TrimSpace(strategy) {
	case "rvwap-short-bollinger", "rvwap-bollinger", "jev-orderflow":
		return strings.TrimSpace(strategy)
	default:
		return ""
	}
}

func normalizeBotConfig(cfg models.BotConfig) models.BotConfig {
	if cfg.OrdersPerSide <= 0 {
		cfg.OrdersPerSide = botDefaultOrdersPerSide
	}
	if cfg.OrderSize <= 0 {
		cfg.OrderSize = botDefaultOrderSize
	}
	if cfg.BidSkew <= 0 {
		cfg.BidSkew = botDefaultSkew
	}
	if cfg.AskSkew <= 0 {
		cfg.AskSkew = botDefaultSkew
	}
	return cfg
}

func (s *BotService) loadState() (*botPersistedState, error) {
	if s.stateFile == "" {
		return nil, nil
	}
	data, err := os.ReadFile(s.stateFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var state botPersistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (s *BotService) saveStateLocked(session *botSession) error {
	if s.stateFile == "" || session == nil {
		return nil
	}
	state := botPersistedState{
		Running:   true,
		Account:   session.account,
		Strategy:  session.strategy,
		Coin:      session.coin,
		Config:    session.config,
		StartedAt: session.startedAt,
		UpdatedAt: session.updatedAt,
		LastRunAt: session.lastRunAt,
		LastPrice: session.lastPrice,
		VWAP:      session.vwap,
		StdDev:    session.stdDev,
		OrderIDs:  append([]int64(nil), session.orderIDs...),
		LastError: session.lastError,
		PrevKVWAP: session.prevKVWAP,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.stateFile), 0o755); err != nil {
		return err
	}
	tmpPath := s.stateFile + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpPath, s.stateFile)
}

func (s *BotService) clearStateFileLocked() error {
	if s.stateFile == "" {
		return nil
	}
	err := os.Remove(s.stateFile)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *BotService) publishStatus(status models.BotStatus) {
	s.mu.RLock()
	notifier := s.notifier
	s.mu.RUnlock()
	if notifier == nil {
		return
	}
	notifier(status.Account, status)
}
