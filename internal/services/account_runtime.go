package services

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"hyperliquid-go/pkg/utils"
)

const runtimeRemovedOrderTTL = 15 * time.Second

type AccountRuntimeSnapshot struct {
	Orders      []interface{}
	OrderFresh  bool
	Revision    int64
	HasSnapshot bool
}

type accountRuntimeState struct {
	orders       []map[string]interface{}
	removedCoins map[string]time.Time
	removedOids  map[int64]time.Time
	revision     int64
	orderFresh   bool
	hasSnapshot  bool
}

type AccountRuntime struct {
	mu       sync.RWMutex
	accounts map[string]*accountRuntimeState
}

func NewAccountRuntime() *AccountRuntime {
	return &AccountRuntime{
		accounts: make(map[string]*accountRuntimeState),
	}
}

func normalizeRuntimeAccount(account string) string {
	return strings.ToLower(strings.TrimSpace(account))
}

func normalizeRuntimeOrder(order interface{}) map[string]interface{} {
	raw, ok := order.(map[string]interface{})
	if !ok || raw == nil {
		return nil
	}
	oid := extractRuntimeOid(raw)
	coin, _ := raw["coin"].(string)
	limitPx := parseRuntimeFloat(raw["limitPx"])
	if oid <= 0 || strings.TrimSpace(coin) == "" || limitPx <= 0 {
		return nil
	}

	normalized := map[string]interface{}{}
	for key, value := range raw {
		normalized[key] = value
	}
	normalized["oid"] = oid
	normalized["coin"] = coin
	normalized["limitPx"] = limitPx
	return normalized
}

func extractRuntimeOid(order map[string]interface{}) int64 {
	switch value := order["oid"].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	case json.Number:
		n, _ := value.Int64()
		return n
	default:
		return 0
	}
}

func parseRuntimeFloat(value interface{}) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		f, _ := typed.Float64()
		return f
	case string:
		n, _ := json.Number(typed).Float64()
		return n
	default:
		return 0
	}
}

func (r *AccountRuntime) getOrCreateLocked(account string) *accountRuntimeState {
	key := normalizeRuntimeAccount(account)
	state, ok := r.accounts[key]
	if ok {
		return state
	}
	state = &accountRuntimeState{
		orders:       make([]map[string]interface{}, 0),
		removedCoins: make(map[string]time.Time),
		removedOids:  make(map[int64]time.Time),
	}
	r.accounts[key] = state
	return state
}

func (r *AccountRuntime) cleanupExpiredRemovedLocked(state *accountRuntimeState, now time.Time) {
	for coin, until := range state.removedCoins {
		if !until.After(now) {
			delete(state.removedCoins, coin)
		}
	}
	for oid, until := range state.removedOids {
		if !until.After(now) {
			delete(state.removedOids, oid)
		}
	}
}

func cloneRuntimeOrders(orders []map[string]interface{}) []interface{} {
	cloned := make([]interface{}, 0, len(orders))
	for _, order := range orders {
		copyOrder := make(map[string]interface{}, len(order))
		for key, value := range order {
			copyOrder[key] = value
		}
		cloned = append(cloned, copyOrder)
	}
	return cloned
}

func (r *AccountRuntime) UpdateOrdersFromSnapshot(account string, orders []interface{}, fresh bool) AccountRuntimeSnapshot {
	return r.updateOrdersFromSnapshot(account, orders, fresh, false)
}

// UpdateOrdersFromUpstreamSnapshot applies an orders snapshot from the
// upstream user websocket (webData2/webData3). Unlike REST snapshots — which
// query every dex explicitly and are authoritative — webData3's coverage of
// builder dexes is intermittent: xyz: orders drop out of individual
// snapshots while still resting on-exchange. Treat absence as unknown, not
// cancelled, and preserve known builder-perp orders (explicit cancels and
// terminal order updates still remove them via MarkOrdersRemoved).
func (r *AccountRuntime) UpdateOrdersFromUpstreamSnapshot(account string, orders []interface{}, fresh bool) AccountRuntimeSnapshot {
	return r.updateOrdersFromSnapshot(account, orders, fresh, true)
}

// isRuntimeBuilderPerpCoin delegates to the process-wide builder classifier so
// runtime order preservation and exchange routing cannot diverge.
func isRuntimeBuilderPerpCoin(coin string) bool {
	return utils.IsBuilderPerpCoin(coin)
}

// ReconcileBuilderPerpOrders replaces the builder-perp (xyz:) slice of the
// runtime order snapshot with a polled frontendOpenOrders result, keeping
// standard-perp orders untouched. Returns the snapshot and whether anything
// changed (callers broadcast only on change). This is the authoritative
// reconciliation for xyz orders cancelled/triggered on-exchange, since the
// user stream does not reliably deliver builder-dex order events.
func (r *AccountRuntime) ReconcileBuilderPerpOrders(account string, orders []interface{}) (AccountRuntimeSnapshot, bool) {
	return r.ReconcileBuilderDexOrders(account, "xyz", orders)
}

func (r *AccountRuntime) ReconcileBuilderDexOrders(account, dex string, orders []interface{}) (AccountRuntimeSnapshot, bool) {
	key := normalizeRuntimeAccount(account)
	dex = strings.ToLower(strings.TrimSpace(dex))
	if key == "" || dex == "" {
		return AccountRuntimeSnapshot{}, false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.getOrCreateLocked(key)
	now := time.Now()
	r.cleanupExpiredRemovedLocked(state, now)

	nextOrders := make([]map[string]interface{}, 0, len(state.orders)+len(orders))
	prefix := dex + ":"
	prevXyz := make([]map[string]interface{}, 0)
	for _, order := range state.orders {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(stringValue(order["coin"]))), prefix) {
			prevXyz = append(prevXyz, order)
			continue
		}
		nextOrders = append(nextOrders, order)
	}

	nextXyz := make([]map[string]interface{}, 0, len(orders))
	for _, order := range orders {
		normalized := normalizeRuntimeOrder(order)
		if normalized == nil || !strings.HasPrefix(strings.ToLower(strings.TrimSpace(stringValue(normalized["coin"]))), prefix) {
			continue
		}
		if until, ok := state.removedCoins[strings.TrimSpace(stringValue(normalized["coin"]))]; ok && until.After(now) {
			continue
		}
		if until, ok := state.removedOids[extractRuntimeOid(normalized)]; ok && until.After(now) {
			continue
		}
		nextXyz = append(nextXyz, normalized)
	}

	changed := !runtimeOrdersEqual(prevXyz, nextXyz)
	if changed {
		state.orders = append(nextOrders, nextXyz...)
		state.hasSnapshot = true
		state.revision++
	}

	return AccountRuntimeSnapshot{
		Orders:      cloneRuntimeOrders(state.orders),
		OrderFresh:  state.orderFresh,
		Revision:    state.revision,
		HasSnapshot: state.hasSnapshot,
	}, changed
}

func runtimeOrdersEqual(left, right []map[string]interface{}) bool {
	if len(left) != len(right) {
		return false
	}
	encode := func(orders []map[string]interface{}) map[int64]string {
		byOid := make(map[int64]string, len(orders))
		for _, order := range orders {
			raw, err := json.Marshal(order)
			if err != nil {
				return nil
			}
			byOid[extractRuntimeOid(order)] = string(raw)
		}
		return byOid
	}
	leftByOid := encode(left)
	rightByOid := encode(right)
	if leftByOid == nil || rightByOid == nil || len(leftByOid) != len(rightByOid) {
		return false
	}
	for oid, raw := range leftByOid {
		if rightByOid[oid] != raw {
			return false
		}
	}
	return true
}

func (r *AccountRuntime) updateOrdersFromSnapshot(account string, orders []interface{}, fresh bool, preserveBuilderPerps bool) AccountRuntimeSnapshot {
	key := normalizeRuntimeAccount(account)
	if key == "" {
		return AccountRuntimeSnapshot{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.getOrCreateLocked(key)
	now := time.Now()
	r.cleanupExpiredRemovedLocked(state, now)

	nextOrders := make([]map[string]interface{}, 0, len(orders))
	seenOids := make(map[int64]struct{}, len(orders))
	for _, order := range orders {
		normalized := normalizeRuntimeOrder(order)
		if normalized == nil {
			continue
		}
		if until, ok := state.removedCoins[strings.TrimSpace(stringValue(normalized["coin"]))]; ok && until.After(now) {
			continue
		}
		if until, ok := state.removedOids[extractRuntimeOid(normalized)]; ok && until.After(now) {
			continue
		}
		seenOids[extractRuntimeOid(normalized)] = struct{}{}
		nextOrders = append(nextOrders, normalized)
	}

	if preserveBuilderPerps {
		for _, existing := range state.orders {
			coin := stringValue(existing["coin"])
			if !isRuntimeBuilderPerpCoin(coin) {
				continue
			}
			oid := extractRuntimeOid(existing)
			if _, ok := seenOids[oid]; ok {
				continue
			}
			if until, ok := state.removedOids[oid]; ok && until.After(now) {
				continue
			}
			if until, ok := state.removedCoins[strings.TrimSpace(coin)]; ok && until.After(now) {
				continue
			}
			nextOrders = append(nextOrders, existing)
		}
		// Upstream webData2 ticks arrive ~1-2x/second; bumping the revision
		// on identical order sets makes every connected client re-reconcile
		// orders per tick for nothing.
		if state.hasSnapshot && runtimeOrdersEqual(state.orders, nextOrders) {
			return AccountRuntimeSnapshot{
				Orders:      cloneRuntimeOrders(state.orders),
				OrderFresh:  state.orderFresh,
				Revision:    state.revision,
				HasSnapshot: state.hasSnapshot,
			}
		}
	}

	state.orders = nextOrders
	state.orderFresh = fresh
	state.hasSnapshot = true
	state.revision++

	return AccountRuntimeSnapshot{
		Orders:      cloneRuntimeOrders(state.orders),
		OrderFresh:  state.orderFresh,
		Revision:    state.revision,
		HasSnapshot: state.hasSnapshot,
	}
}

func (r *AccountRuntime) MarkOrdersRemoved(account string, oids []int64) AccountRuntimeSnapshot {
	key := normalizeRuntimeAccount(account)
	if key == "" {
		return AccountRuntimeSnapshot{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.getOrCreateLocked(key)
	now := time.Now()
	r.cleanupExpiredRemovedLocked(state, now)

	changed := false
	oidSet := make(map[int64]struct{}, len(oids))
	for _, oid := range oids {
		if oid <= 0 {
			continue
		}
		oidSet[oid] = struct{}{}
		state.removedOids[oid] = now.Add(runtimeRemovedOrderTTL)
	}

	if len(oidSet) > 0 {
		filtered := make([]map[string]interface{}, 0, len(state.orders))
		for _, order := range state.orders {
			if _, ok := oidSet[extractRuntimeOid(order)]; ok {
				changed = true
				continue
			}
			filtered = append(filtered, order)
		}
		state.orders = filtered
	}

	if changed || len(oidSet) > 0 {
		state.revision++
		state.hasSnapshot = true
	}

	return AccountRuntimeSnapshot{
		Orders:      cloneRuntimeOrders(state.orders),
		OrderFresh:  state.orderFresh,
		Revision:    state.revision,
		HasSnapshot: state.hasSnapshot,
	}
}

func (r *AccountRuntime) MarkCoinOrdersRemoved(account, coin string) AccountRuntimeSnapshot {
	key := normalizeRuntimeAccount(account)
	coin = strings.TrimSpace(coin)
	if key == "" || coin == "" {
		return AccountRuntimeSnapshot{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.getOrCreateLocked(key)
	now := time.Now()
	r.cleanupExpiredRemovedLocked(state, now)
	state.removedCoins[coin] = now.Add(runtimeRemovedOrderTTL)

	changed := false
	filtered := make([]map[string]interface{}, 0, len(state.orders))
	for _, order := range state.orders {
		if strings.TrimSpace(stringValue(order["coin"])) == coin {
			if oid := extractRuntimeOid(order); oid > 0 {
				state.removedOids[oid] = now.Add(runtimeRemovedOrderTTL)
			}
			changed = true
			continue
		}
		filtered = append(filtered, order)
	}
	state.orders = filtered
	if changed || coin != "" {
		state.revision++
		state.hasSnapshot = true
	}

	return AccountRuntimeSnapshot{
		Orders:      cloneRuntimeOrders(state.orders),
		OrderFresh:  state.orderFresh,
		Revision:    state.revision,
		HasSnapshot: state.hasSnapshot,
	}
}

func (r *AccountRuntime) RegisterAcceptedOrders(account string, orders []interface{}) AccountRuntimeSnapshot {
	key := normalizeRuntimeAccount(account)
	if key == "" || len(orders) == 0 {
		return AccountRuntimeSnapshot{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.getOrCreateLocked(key)
	now := time.Now()
	r.cleanupExpiredRemovedLocked(state, now)

	existingByOid := make(map[int64]map[string]interface{}, len(state.orders))
	for _, order := range state.orders {
		if oid := extractRuntimeOid(order); oid > 0 {
			existingByOid[oid] = order
		}
	}

	for _, rawOrder := range orders {
		normalized := normalizeRuntimeOrder(rawOrder)
		if normalized == nil {
			continue
		}
		coin := strings.TrimSpace(stringValue(normalized["coin"]))
		if coin != "" {
			delete(state.removedCoins, coin)
		}
		if oid := extractRuntimeOid(normalized); oid > 0 {
			delete(state.removedOids, oid)
			existingByOid[oid] = normalized
		}
	}

	nextOrders := make([]map[string]interface{}, 0, len(existingByOid))
	for _, order := range existingByOid {
		nextOrders = append(nextOrders, order)
	}
	state.orders = nextOrders
	state.orderFresh = true
	state.hasSnapshot = true
	state.revision++

	return AccountRuntimeSnapshot{
		Orders:      cloneRuntimeOrders(state.orders),
		OrderFresh:  state.orderFresh,
		Revision:    state.revision,
		HasSnapshot: state.hasSnapshot,
	}
}

func (r *AccountRuntime) GetSnapshot(account string) AccountRuntimeSnapshot {
	key := normalizeRuntimeAccount(account)
	if key == "" {
		return AccountRuntimeSnapshot{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	state, ok := r.accounts[key]
	if !ok {
		return AccountRuntimeSnapshot{}
	}
	r.cleanupExpiredRemovedLocked(state, time.Now())
	return AccountRuntimeSnapshot{
		Orders:      cloneRuntimeOrders(state.orders),
		OrderFresh:  state.orderFresh,
		Revision:    state.revision,
		HasSnapshot: state.hasSnapshot,
	}
}

func (r *AccountRuntime) ApplyUserStreamMessage(account string, payload []byte) AccountRuntimeSnapshot {
	key := normalizeRuntimeAccount(account)
	if key == "" || len(payload) == 0 {
		return AccountRuntimeSnapshot{}
	}

	var msg map[string]interface{}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return AccountRuntimeSnapshot{}
	}

	channel, _ := msg["channel"].(string)
	data := msg["data"]
	switch channel {
	case "webData2", "webData3":
		if body, ok := data.(map[string]interface{}); ok {
			// Upstream webData2 carries main-dex orders under "openOrders"
			// (frontend shape); backend-built canonical messages use "orders".
			rawOrders, ok := body["orders"].([]interface{})
			if !ok {
				rawOrders, ok = body["openOrders"].([]interface{})
			}
			if ok {
				return r.UpdateOrdersFromUpstreamSnapshot(key, rawOrders, true)
			}
		}
	case "orderUpdates":
		return r.MarkOrdersRemoved(key, extractRuntimeTerminalOids(data))
		// userFills deliberately does not remove orders: a fill event carries no
		// terminal status, so a partial fill would evict a still-resting order
		// for the removal TTL. Full fills arrive as orderUpdates status "filled".
	case "openOrders":
		if body, ok := data.(map[string]interface{}); ok {
			dex, _ := body["dex"].(string)
			if orders, ok := body["orders"].([]interface{}); ok && dex != "" {
				snapshot, _ := r.ReconcileBuilderDexOrders(key, dex, orders)
				return snapshot
			}
		}
	}

	return r.GetSnapshot(key)
}

func (r *AccountRuntime) BuildCanonicalSnapshotMessage(snapshot AccountRuntimeSnapshot) []byte {
	return buildCanonicalSnapshotMessage(snapshot)
}

func (r *AccountRuntime) InjectOrdersIntoWebData2(raw []byte, snapshot AccountRuntimeSnapshot) []byte {
	return injectOrdersIntoWebData2(raw, snapshot)
}
