package services

import (
	"context"
	"math"
	"strconv"

	"hyperliquid-go/internal/accountcache"
	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/ports/cache"
	"hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/pkg/utils"
)

type AccountService struct {
	exchange       exchange.Exchange
	metadataCache  cache.CoinMetadataCache
	accountRuntime *AccountRuntime
	jevService     *JevService
}

func (s *AccountService) SetJevService(js *JevService) {
	s.jevService = js
}

func NewAccountService(exchange exchange.Exchange, metadataCache cache.CoinMetadataCache, accountRuntime *AccountRuntime) *AccountService {
	return &AccountService{exchange: exchange, metadataCache: metadataCache, accountRuntime: accountRuntime}
}

func (s *AccountService) GetAccount(ctx context.Context, address string) (map[string]interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.GetAccount(ctx, address)
}

// GetAccountFresh performs the bounded core reconciliation used after
// execution events. Decorative portfolio history and unrelated builder DEX
// state are refreshed by their background owners; waiting for them here made
// one fill fan out into enough /info work to starve visible chart history.
func (s *AccountService) GetAccountFresh(ctx context.Context, address string) (map[string]interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	state, err := s.exchange.GetAccount(ctx, address)
	if err != nil {
		return nil, err
	}
	return NormalizeAccountState(state), nil
}

func (s *AccountService) GetFills(ctx context.Context, address string) ([]interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.GetFills(ctx, address, 0)
}

func (s *AccountService) GetOpenOrders(ctx context.Context, address string) ([]interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.GetOpenOrders(ctx, address)
}

func (s *AccountService) GetBuilderDexes(ctx context.Context) ([]string, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.GetBuilderDexes(ctx)
}

func (s *AccountService) GetBuilderDexState(ctx context.Context, address, dex string, includeOrders bool) (exchange.BuilderDexState, error) {
	if s.exchange == nil {
		return exchange.BuilderDexState{Dex: dex}, nil
	}
	return s.exchange.GetBuilderDexState(ctx, address, dex, includeOrders)
}

// NormalizeAccountState ensures the state map always contains a populated
// riskSummary with accountValue, withdrawable, and availableMargin.
// It derives missing values from crossMarginSummary, marginSummary, and the
// top-level withdrawable field so that callers have a single consistent source.
func NormalizeAccountState(state map[string]interface{}) map[string]interface{} {
	if state == nil {
		return state
	}

	pf := utils.ParseFloat64

	// Derive account equity and margin usage from crossMarginSummary →
	// marginSummary. Zero is a valid exchange value, so field presence (not
	// positivity) decides whether a value is authoritative.
	var accountValue, totalMarginUsed float64
	accountValueFound := false
	for _, key := range []string{"crossMarginSummary", "marginSummary"} {
		if ms, ok := state[key].(map[string]interface{}); ok && ms != nil {
			if raw, exists := ms["accountValue"]; exists {
				accountValue = pf(raw)
				totalMarginUsed = pf(ms["totalMarginUsed"])
				accountValueFound = true
				break
			}
		}
	}

	risk, _ := state["riskSummary"].(map[string]interface{})
	if risk == nil {
		risk = make(map[string]interface{})
	}
	if raw, exists := risk["accountValue"]; exists {
		accountValue = pf(raw)
		accountValueFound = true
	}

	// The clearinghouse top-level withdrawable field is the authoritative free
	// collateral. Do not substitute spot USDC, and do not treat zero as missing.
	withdrawable := 0.0
	var withdrawableValue interface{}
	withdrawableFound := false
	// availableMargin is the adapter's canonical, account-mode-aware field.
	// A raw top-level withdrawable is only a fallback: Unified/Portfolio
	// snapshots still carry a meaningless zero from the individual perp state.
	if raw, exists := risk["availableMargin"]; exists {
		withdrawable = pf(raw)
		withdrawableValue = raw
		withdrawableFound = true
	} else if raw, exists := state["withdrawable"]; exists {
		withdrawable = pf(raw)
		withdrawableValue = raw
		withdrawableFound = true
	} else if raw, exists := risk["withdrawable"]; exists {
		withdrawable = pf(raw)
		withdrawableValue = raw
		withdrawableFound = true
	}
	if !withdrawableFound && accountValueFound {
		withdrawable = accountValue - totalMarginUsed
		if withdrawable < 0 {
			withdrawable = 0
		}
		withdrawableValue = withdrawable
	}

	if _, exists := risk["accountValue"]; !exists {
		risk["accountValue"] = accountValue
	}
	if withdrawableValue == nil {
		withdrawableValue = withdrawable
	}
	risk["withdrawable"] = withdrawableValue
	risk["availableMargin"] = withdrawableValue
	risk["totalAvailable"] = withdrawableValue
	risk["totalMarginUsed"] = totalMarginUsed
	state["riskSummary"] = risk
	return state
}

func getFloat64(m map[string]interface{}, key string) float64 {
	switch v := m[key].(type) {
	case float64:
		return v
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	}
	return 0
}

func (s *AccountService) ClosePosition(ctx context.Context, privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error) {
	if s.exchange == nil {
		return models.ClosePositionResult{Status: "ok"}, nil
	}
	return s.exchange.ClosePosition(ctx, privateKey, address, coin, fraction, positionSize, positionSzi, testnet)
}

func (s *AccountService) SetLeverage(ctx context.Context, privateKey, coin string, leverage int, isCross, testnet bool) error {
	if s.exchange == nil {
		return nil
	}
	return s.exchange.SetLeverage(ctx, privateKey, accountcache.GetWithFallback(), coin, leverage, isCross, testnet)
}

func (s *AccountService) UpdateIsolatedMargin(ctx context.Context, privateKey, coin string, ntli float64, testnet bool) error {
	if s.exchange == nil {
		return nil
	}
	return s.exchange.UpdateIsolatedMargin(ctx, privateKey, accountcache.GetWithFallback(), coin, ntli, testnet)
}

func (s *AccountService) GetActiveAssetData(ctx context.Context, address, coin string) (map[string]interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.GetActiveAssetData(ctx, address, coin)
}

func (s *AccountService) OrderPreview(ctx context.Context, address, coin string, isBuy bool, sizeUSD, limitPx float64, leverage int, cachedAccountValue, cachedAvailableEquity float64) (map[string]interface{}, error) {
	if s.exchange == nil || coin == "" || sizeUSD <= 0 {
		return nil, nil
	}

	markPx := limitPx
	if markPx <= 0 {
		var err error
		markPx, err = s.exchange.GetMidPrice(ctx, coin, false)
		if err != nil {
			return nil, err
		}
	}
	if markPx <= 0 {
		return nil, nil
	}

	maxLev := 20
	if s.metadataCache != nil {
		if cached := s.metadataCache.GetMaxLeverage(coin); cached > 0 {
			maxLev = cached
		}
	}
	if leverage <= 0 {
		leverage = maxLev
	}
	if leverage > maxLev {
		leverage = maxLev
	}

	szDecimals := 3
	if s.metadataCache != nil {
		if cached := s.metadataCache.GetDecimals(coin); cached > 0 {
			szDecimals = cached
		}
	}

	coinSize := sizeUSD / markPx
	multiplier := 1.0
	for i := 0; i < szDecimals; i++ {
		multiplier *= 10
	}
	// Floor like the execution path (roundNotionalToCoinSize) so the preview
	// never overstates the size/margin of the order that would actually place.
	coinSize = math.Floor(coinSize*multiplier+1e-9) / multiplier

	positionValue := coinSize * markPx
	initMargin := utils.InitialMargin(coinSize, markPx, leverage)
	maintMargin := utils.CalcMaintenanceMargin(positionValue, maxLev)

	accountValue := cachedAccountValue
	availableEquity := cachedAvailableEquity
	totalMaintMargin := 0.0

	// Only fetch from exchange if no cached values provided
	if (accountValue <= 0 || availableEquity <= 0) && address != "" {
		state, err := s.exchange.GetAccount(ctx, address)
		if err == nil && state != nil {
			if risk, ok := state["riskSummary"].(map[string]interface{}); ok {
				if accountValue <= 0 {
					accountValue = getFloat64(risk, "accountValue")
				}
				if availableEquity <= 0 {
					availableEquity = getFloat64(risk, "availableMargin")
					if availableEquity == 0 {
						availableEquity = getFloat64(risk, "withdrawable")
					}
				}
			}
			if accountValue == 0 {
				if ms, ok := state["marginSummary"].(map[string]interface{}); ok {
					accountValue = getFloat64(ms, "accountValue")
					if availableEquity == 0 {
						totalMarginUsed := getFloat64(ms, "totalMarginUsed")
						availableEquity = accountValue - totalMarginUsed
					}
				}
			}
			if availableEquity == 0 {
				availableEquity = getFloat64(state, "withdrawable")
			}

			if positions, ok := state["positionRisk"].([]interface{}); ok {
				for _, item := range positions {
					if pm, ok := item.(map[string]interface{}); ok {
						totalMaintMargin += getFloat64(pm, "maintenanceMargin")
					}
				}
			}
		}
	}

	if availableEquity < 0 {
		availableEquity = 0
	}

	liqPx := 0.0
	distToLiq := 0.0
	isXyz := utils.IsHip3Coin(coin)
	if isXyz {
		liqPx = utils.LiquidationPriceIsolatedAtEntry(markPx, leverage, maxLev, isBuy)
		distToLiq = utils.DistanceToLiqPct(markPx, liqPx)
	} else if availableEquity > 0 && totalMaintMargin > 0 {
		liqPx = utils.LiquidationPriceCross(markPx, accountValue, totalMaintMargin+maintMargin, coinSize, isBuy, maxLev)
		distToLiq = utils.DistanceToLiqPct(markPx, liqPx)
	} else if availableEquity > 0 {
		marginAvailable := availableEquity - maintMargin
		if marginAvailable < 0 {
			marginAvailable = 0
		}
		liqPx = utils.LiquidationPriceFull(markPx, marginAvailable, coinSize, isBuy, maxLev)
		distToLiq = utils.DistanceToLiqPct(markPx, liqPx)
	} else {
		liqPx = utils.LiquidationPriceIsolatedAtEntry(markPx, leverage, maxLev, isBuy)
		distToLiq = utils.DistanceToLiqPct(markPx, liqPx)
	}

	availableAfter := availableEquity - initMargin
	if availableAfter < 0 {
		availableAfter = 0
	}

	res := map[string]interface{}{
		"positionSize":   coinSize,
		"initialMargin":  initMargin,
		"maintMargin":    maintMargin,
		"liquidationPx":  liqPx,
		"distToLiqPct":   distToLiq,
		"entryPx":        markPx,
		"maxLeverage":    maxLev,
		"accountValue":   accountValue,
		"availableAfter": availableAfter,
	}

	if s.jevService != nil && s.jevService.IsAvailable() && sizeUSD >= 1000 {
		if audit, aErr := s.jevService.AuditPreTrade(ctx, coin, isBuy, sizeUSD); aErr == nil && audit != nil {
			res["jevAudit"] = map[string]interface{}{
				"approved":     audit.Approved,
				"slippageRisk": audit.SlippageRisk,
				"toxicRisk":    audit.ToxicRisk,
				"bookWipePct":  audit.BookWipePct,
				"advice":       audit.Advice,
			}
		}
	}

	return res, nil
}

// GetMaxLeverage returns the cached max leverage for a coin, defaulting to 25.
func (s *AccountService) GetMaxLeverage(coin string) int {
	if s.metadataCache == nil {
		return 25
	}
	lev := s.metadataCache.GetMaxLeverage(coin)
	if lev < 1 {
		return 25
	}
	return lev
}
