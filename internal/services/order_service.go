package services

import (
	"context"
	"encoding/json"
	"regexp"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"hyperliquid-go/internal/accountcache"
	"hyperliquid-go/internal/domain/errors"
	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/ports/cache"
	"hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/internal/ports/streaming"
)

var privateKeyRegex = regexp.MustCompile(`^(0x)?[a-fA-F0-9]{64}$`)

type OrderService struct {
	exchange       exchange.Exchange
	priceCache     cache.PriceCache
	metadataCache  cache.CoinMetadataCache
	rateLimiter    *RateLimiter
	publisher      streaming.Publisher
	accountRuntime *AccountRuntime
	protectMu      sync.Mutex
	protectionByID map[string]map[int64]protectionRequest
	// protectionAlias maps a retired modify oid → current protection oid so a
	// late fill still keyed by the pre-modify oid finds the shared request.
	// Order-update cancels do not follow aliases (old oid cancel after
	// cancel+replace must not clear protection on the replacement).
	protectionAlias map[string]map[int64]int64
	lifecycleCtx    context.Context
	journal        *ExecutionJournal
	// testAfterModifyExchange, when non-nil, runs after protection re-key and
	// before runtime registration. Tests inject concurrent fills here;
	// production leaves it nil.
	testAfterModifyExchange func()
}

func (s *OrderService) SetJournal(journal *ExecutionJournal) {
	s.journal = journal
}

func (s *OrderService) GetJournal() *ExecutionJournal {
	return s.journal
}

func (s *OrderService) recordJournal(entry models.JournalEntry) {
	if s.journal == nil {
		return
	}
	_ = s.journal.Record(entry)
}

func (s *OrderService) getPreTradeMid(coin string) float64 {
	if s.priceCache == nil {
		return 0
	}
	pe, ok := s.priceCache.Get(coin)
	if !ok {
		return 0
	}
	if pe.Buy > 0 && pe.Sell > 0 {
		return (pe.Buy + pe.Sell) / 2
	}
	if pe.Buy > 0 {
		return pe.Buy
	}
	return pe.Sell
}

func calculateSlippageBps(mid, limitPx float64, isBuy bool) float64 {
	if mid <= 0 || limitPx <= 0 {
		return 0
	}
	if isBuy {
		return ((limitPx - mid) / mid) * 10000
	}
	return ((mid - limitPx) / mid) * 10000
}

func (s *OrderService) SetLifecycleContext(ctx context.Context) {
	s.lifecycleCtx = ctx
}

func (s *OrderService) backgroundContext() context.Context {
	if s.lifecycleCtx != nil {
		return s.lifecycleCtx
	}
	return context.Background()
}

func NewOrderService(
	exchange exchange.Exchange,
	priceCache cache.PriceCache,
	metadataCache cache.CoinMetadataCache,
	rateLimiter *RateLimiter,
	publisher streaming.Publisher,
	accountRuntime *AccountRuntime,
) *OrderService {
	s := &OrderService{
		exchange:        exchange,
		priceCache:      priceCache,
		metadataCache:   metadataCache,
		rateLimiter:     rateLimiter,
		publisher:       publisher,
		accountRuntime:  accountRuntime,
		protectionByID:  make(map[string]map[int64]protectionRequest),
		protectionAlias: make(map[string]map[int64]int64),
	}
	s.loadPendingProtection()
	return s
}

func (s *OrderService) CancelOrder(ctx context.Context, pk, coin string, oid int64, testnet bool) error {
	start := time.Now()
	if s.exchange == nil {
		return nil
	}
	err := s.exchange.CancelOrder(ctx, pk, coin, oid, testnet)
	status := "cancelled"
	errMsg := ""
	if err != nil {
		status = "error"
		errMsg = err.Error()
	}
	s.recordJournal(models.JournalEntry{
		Action:       "CANCEL_ORDER",
		Coin:         coin,
		Oid:          oid,
		LatencyMs:    time.Since(start).Milliseconds(),
		Success:      err == nil,
		Status:       status,
		ErrorMessage: errMsg,
		Source:       "TICKET",
	})
	if err == nil {
		if address, addressErr := s.resolveTradingAccount(pk); addressErr == nil {
			s.publishOrderUpdate(address, map[string]interface{}{
				"orderUpdates": []map[string]interface{}{{
					"oid":    oid,
					"coin":   coin,
					"status": "cancelled",
				}},
			})
			if s.accountRuntime != nil {
				s.accountRuntime.MarkOrdersRemoved(address, []int64{oid})
			}
			s.clearProtectionByOid(address, oid)
		}
	}
	return err
}

// BulkCancel returns the oids confirmed cancelled by the exchange. Only those
// are removed from the runtime and published; reporting un-cancelled oids as
// removed made their chart lines vanish for the suppression window and then
// reappear.
func (s *OrderService) BulkCancel(ctx context.Context, req models.BulkCancelRequest) ([]int64, error) {
	entries := make([]models.CancelEntry, 0, len(req.Cancels))
	for _, cancel := range req.Cancels {
		coin, _ := cancel["coin"].(string)
		oid := normalizeCancelOid(cancel["oid"])
		if oid <= 0 {
			continue
		}
		entries = append(entries, models.CancelEntry{Coin: coin, Oid: oid})
	}

	if s.exchange == nil {
		oids := make([]int64, 0, len(entries))
		for _, e := range entries {
			oids = append(oids, e.Oid)
		}
		return oids, nil
	}

	if len(entries) == 0 {
		return nil, nil
	}

	testnet := req.Testnet && !req.Mainnet

	address, addressErr := s.resolveTradingAccount(req.PrivateKey)
	if addressErr != nil {
		return nil, addressErr
	}

	cancelledOids, err := s.exchange.BulkCancelOrders(ctx, req.PrivateKey, entries, testnet)

	if len(cancelledOids) > 0 {
		updates := make([]map[string]interface{}, 0, len(cancelledOids))
		for _, oid := range cancelledOids {
			updates = append(updates, map[string]interface{}{
				"oid":    oid,
				"status": "cancelled",
			})
		}
		s.publishOrderUpdate(address, map[string]interface{}{"orderUpdates": updates})
		if s.accountRuntime != nil {
			s.accountRuntime.MarkOrdersRemoved(address, cancelledOids)
		}
		for _, oid := range cancelledOids {
			s.clearProtectionByOid(address, oid)
		}
	}

	if err != nil && len(cancelledOids) == 0 {
		return nil, err
	}
	return cancelledOids, err
}

func normalizeCancelOid(value interface{}) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	default:
		return 0
	}
}

func (s *OrderService) PlaceTrigger(ctx context.Context, req models.TriggerOrderRequest) error {
	if s.exchange == nil {
		return nil
	}
	return s.exchange.PlaceTriggerOrder(ctx, req)
}

func (s *OrderService) PlaceTriggers(ctx context.Context, reqs []models.TriggerOrderRequest) []error {
	if s.exchange == nil || len(reqs) == 0 {
		return nil
	}
	return s.exchange.PlaceTriggerOrders(ctx, reqs)
}

func (s *OrderService) GetAddressFromKey(pk string) (string, error) {
	return s.extractAddress(pk)
}

func (s *OrderService) ModifyOrder(ctx context.Context, req models.ModifyOrderRequest) (int64, error) {
	if s.exchange == nil {
		return 0, nil
	}
	// Resolve account before the exchange round-trip so post-success re-key is
	// only a map update under protectMu (no address derivation in the window).
	address, _ := s.resolveTradingAccount(req.PrivateKey)
	newOid, err := s.exchange.ModifyOrder(ctx, req)
	if err != nil {
		return 0, err
	}
	registeredOid := newOid
	if registeredOid <= 0 {
		// A successful single modify is confirmed even when a venue omits the
		// replacement oid. Keep the existing oid until the account snapshot
		// supplies a replacement; bulk operations use zero to mark failures.
		registeredOid = req.Oid
	}
	// Re-key protection immediately after exchange success — before runtime
	// registration — so a concurrent fill on the replacement oid can attach.
	if address != "" && registeredOid > 0 && registeredOid != req.Oid {
		s.rekeyProtection(address, req.Oid, registeredOid)
	}
	if s.testAfterModifyExchange != nil {
		s.testAfterModifyExchange()
	}
	s.registerModifiedOrders(req.PrivateKey, []models.ModifyOrderRequestItem{{
		Oid: req.Oid, Coin: req.Coin, IsBuy: req.IsBuy, Sz: req.Sz, LimitPx: req.LimitPx,
		ReduceOnly: req.ReduceOnly, TriggerPx: req.TriggerPx, IsMarket: req.IsMarket, Tpsl: req.Tpsl,
	}}, []int64{registeredOid})
	return newOid, nil
}

// registerModifiedOrders reconciles the runtime's canonical order snapshot
// with the post-modify state and publishes order updates. A Hyperliquid
// modify is cancel+replace, so the resting order comes back under newOid;
// without immediate reconciliation the old oid lingers as a ghost chart line
// until the next upstream snapshot — which for HIP-3 dexes can be seconds
// away (builder-dex coverage in the user stream is slow/partial), making xyz
// drags flicker while standard-perp drags looked instant.
//
// Protection re-key runs first (and even when accountRuntime is nil) so a
// concurrent userFills event for the replacement oid still finds TP/SL state.
func (s *OrderService) registerModifiedOrders(privateKey string, modifies []models.ModifyOrderRequestItem, newOids []int64) {
	if len(modifies) == 0 {
		return
	}
	address, err := s.resolveTradingAccount(privateKey)
	if err != nil || address == "" {
		return
	}
	// Re-key before any runtime/publish work. Idempotent when ModifyOrder already re-keyed.
	for i, mod := range modifies {
		if i >= len(newOids) || newOids[i] <= 0 || newOids[i] == mod.Oid {
			continue
		}
		s.rekeyProtection(address, mod.Oid, newOids[i])
	}
	if s.accountRuntime == nil {
		return
	}
	orders := make([]interface{}, 0, len(modifies))
	updates := make([]interface{}, 0, len(modifies))
	replacedOids := make([]int64, 0, len(modifies))
	for i, mod := range modifies {
		if i >= len(newOids) || newOids[i] <= 0 {
			continue
		}
		oid := newOids[i]
		if oid != mod.Oid {
			replacedOids = append(replacedOids, mod.Oid)
			updates = append(updates, map[string]interface{}{
				"oid": mod.Oid, "coin": mod.Coin, "status": "cancelled",
			})
		}
		limitPx := mod.LimitPx
		order := map[string]interface{}{
			"oid":        oid,
			"coin":       mod.Coin,
			"sz":         mod.Sz,
			"side":       map[bool]string{true: "B", false: "A"}[mod.IsBuy],
			"reduceOnly": mod.ReduceOnly,
		}
		if mod.Tpsl == "tp" || mod.Tpsl == "sl" {
			if limitPx <= 0 {
				limitPx = mod.TriggerPx
			}
			order["triggerPx"] = mod.TriggerPx
			order["tpsl"] = mod.Tpsl
			order["isTrigger"] = true
			order["reduceOnly"] = true
		}
		order["limitPx"] = limitPx
		orders = append(orders, order)
		updates = append(updates, map[string]interface{}{"order": order, "status": "open"})
	}
	if len(replacedOids) > 0 {
		s.accountRuntime.MarkOrdersRemoved(address, replacedOids)
	}
	s.accountRuntime.RegisterAcceptedOrders(address, orders)
	s.publishOrderUpdate(address, updates)
}

// rekeyProtection moves a pending TP/SL protection request to the order's
// replacement oid and records an alias from old→new so fills still keyed by
// the pre-modify oid find the same request. Order-update cancels do not follow
// the alias, so the exchange's cancel of the old oid cannot clear protection.
func (s *OrderService) PlaceTwap(ctx context.Context, req models.TwapOrderRequest) (interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.PlaceTwapOrder(ctx, req)
}

func (s *OrderService) CancelTwap(ctx context.Context, req models.TwapCancelRequest) (interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.CancelTwapOrder(ctx, req)
}

func (s *OrderService) CancelByCloid(ctx context.Context, req models.CancelByCloidRequest) error {
	start := time.Now()
	if s.exchange == nil {
		return nil
	}
	err := s.exchange.CancelByCloid(ctx, req.PrivateKey, req.Coin, req.Cloid, req.Testnet && !req.Mainnet)
	status := "cancelled"
	errMsg := ""
	if err != nil {
		status = "error"
		errMsg = err.Error()
	}
	s.recordJournal(models.JournalEntry{
		Action:       "CANCEL_BY_CLOID",
		Coin:         req.Coin,
		Cloid:        req.Cloid,
		LatencyMs:    time.Since(start).Milliseconds(),
		Success:      err == nil,
		Status:       status,
		ErrorMessage: errMsg,
		Source:       "TICKET",
	})
	return err
}

func (s *OrderService) BulkModifyOrders(ctx context.Context, req models.BulkModifyOrderRequest) ([]int64, error) {
	if s.exchange == nil {
		return nil, nil
	}
	// Pre-resolve so post-success re-key is only map work under protectMu.
	address, _ := s.resolveTradingAccount(req.PrivateKey)
	newOids, err := s.exchange.BulkModifyOrders(ctx, req.PrivateKey, req.Modifies, req.Mainnet)
	if address != "" {
		for i, mod := range req.Modifies {
			if i >= len(newOids) || newOids[i] <= 0 || newOids[i] == mod.Oid {
				continue
			}
			s.rekeyProtection(address, mod.Oid, newOids[i])
		}
	}
	if s.testAfterModifyExchange != nil {
		s.testAfterModifyExchange()
	}
	s.registerModifiedOrders(req.PrivateKey, req.Modifies, newOids)
	return newOids, err
}

func (s *OrderService) ScheduleCancel(ctx context.Context, req models.ScheduleCancelRequest) error {
	if s.exchange == nil {
		return nil
	}
	return s.exchange.ScheduleCancel(ctx, req.PrivateKey, req.Time, req.Testnet && !req.Mainnet)
}

func (s *OrderService) validate(req models.OrderRequest) error {
	if req.PrivateKey == "" || len(req.PrivateKey) < 64 {
		return errors.ErrInvalidPrivateKey
	}
	if !privateKeyRegex.MatchString(req.PrivateKey) {
		return errors.ErrInvalidPrivateKeyFormat
	}
	if req.Coin == "" {
		return errors.ErrInvalidCoin
	}
	if req.Sz <= 0 {
		return errors.ErrInvalidSize
	}
	return nil
}

func (s *OrderService) extractAddress(pk string) (string, error) {
	pk = normalizeKey(pk)
	if len(pk) < 64 {
		return "", errors.ErrInvalidPrivateKey
	}

	// If exchange is available (non-nil), use it to derive the address
	if s.exchange != nil {
		addr, err := s.exchange.GetAddressFromPrivateKey(s.backgroundContext(), pk)
		if err != nil {
			return "", err
		}
		return addr, nil
	}

	// Fallback: derive address directly (used in tests with nil exchange)
	ecdsaKey, err := crypto.HexToECDSA(pk)
	if err != nil {
		return "", errors.ErrInvalidPrivateKey
	}
	return crypto.PubkeyToAddress(ecdsaKey.PublicKey).Hex(), nil
}

func (s *OrderService) resolveTradingAccount(pk string) (string, error) {
	if account := accountcache.GetWithFallback(); account != "" {
		return account, nil
	}
	return s.extractAddress(pk)
}

func normalizeKey(pk string) string {
	if len(pk) == 66 && pk[:2] == "0x" {
		return pk[2:]
	}
	return pk
}
