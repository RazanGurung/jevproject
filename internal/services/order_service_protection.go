package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"hyperliquid-go/internal/domain/errors"
	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/keycache"
	"hyperliquid-go/internal/ports/streaming"
)

// Protection attach/retry/persist lives in this file. Place/bulk live in
// order_service_place.go. Both share *OrderService so call sites stay stable.

// protectionLeg tracks one side (TP or SL) of a single attach unit
// independently, so a failure on one leg is never conflated with the other:
// TP failing must never stop SL from being attempted, and a leg that already
// succeeded must never be re-placed by a retry.
type protectionLeg struct {
	Cloid         string
	Required      bool
	Done          bool
	Attempts      int
	LastError     string
	LastAttemptAt time.Time
	// AlertCount/NextAlertAt throttle repeated protectionError publishes for a
	// persistently failing leg on an escalating cadence (immediate, then
	// 1m/5m/15m, then hourly) so it is never silent for long but never spams.
	AlertCount  int
	NextAlertAt time.Time
	// Attempting guards against the background sweep and a live fill event
	// racing to place the same leg concurrently. Never persisted: on restart
	// nothing is in flight.
	Attempting bool `json:"-"`
}

// protectionAttachUnit is the atomic unit of TP/SL work: one fill
// (whole-order or partial) that needs up to two legs placed. This replaces
// the old SeenTids/AttachedSzCoin pair, which conflated "a fill was observed"
// with "protection for that fill is fully attached" — a failed attach could
// never be retried because the fill already counted as "seen".
type protectionAttachUnit struct {
	Tid       string // fillDedupeKey(fill), or "immediate:<oid>" for immediate fills
	AvgPx     float64
	SzCoin    float64
	TP        protectionLeg
	SL        protectionLeg
	CreatedAt time.Time
}

// fullyAttached reports whether every required leg for this unit is done.
func (u protectionAttachUnit) fullyAttached() bool {
	if u.TP.Required && !u.TP.Done {
		return false
	}
	if u.SL.Required && !u.SL.Done {
		return false
	}
	return true
}

type protectionRequest struct {
	PrivateKey string
	Coin       string
	IsEntryBuy bool
	TpPct      float64
	SlPct      float64
	Mainnet    bool
	Testnet    bool
	CreatedAt  time.Time

	// Attaches holds one unit per fill (partial or whole) that needs TP/SL
	// legs placed. A resting order can fill in several partial fills; each
	// one gets its own unit and its own independent leg tracking.
	Attaches []protectionAttachUnit
	// Closed means no further fills are expected for this oid (a terminal
	// orderUpdate, a cancel/reject/expire, or an immediate-fill registration
	// that was born already-closed). It stops new Attaches units from being
	// created, but must NEVER cause an incomplete existing unit to be
	// dropped — that would silently abandon a leg the retry sweep should
	// still be working on.
	Closed bool
	// TerminalAt is set when a terminal "filled" orderUpdate arrives; the
	// entry survives a grace window for late or replayed fills, then expires
	// quietly (it did its job) instead of lingering for the full TTL.
	TerminalAt time.Time
}

// allDone reports whether every attach unit registered so far is fully
// protected (used to decide whether a closed entry can be safely forgotten).
func (r protectionRequest) allDone() bool {
	for _, u := range r.Attaches {
		if !u.fullyAttached() {
			return false
		}
	}
	return true
}

// hasIncomplete reports whether any attach unit still needs a leg placed.
func (r protectionRequest) hasIncomplete() bool {
	return !r.allDone()
}

// protectionTTL bounds how long a resting order's TP/SL request is remembered
// while waiting for the fill. It must comfortably exceed any realistic resting
// time: an order that fills after expiry gets no protection. Expiry is logged
// and published so the loss is never silent.
const protectionTTL = 24 * time.Hour

// protectionTerminalGrace keeps a protection entry alive after its order went
// terminal (filled) so fills that race the orderUpdate — or arrive via the
// reconnect snapshot replay — can still attach.
const protectionTerminalGrace = 10 * time.Minute

// pendingProtectionFile persists queued TP/SL requests (NEVER private keys —
// the signing key is re-resolved from keycache at attach time) so a backend
// restart does not silently drop protection for resting orders. Lives in the
// working directory like hyperliquid_key.txt.
const pendingProtectionFile = "pending_protection.json"

type persistedLeg struct {
	Cloid         string    `json:"cloid,omitempty"`
	Required      bool      `json:"required,omitempty"`
	Done          bool      `json:"done,omitempty"`
	Attempts      int       `json:"attempts,omitempty"`
	LastError     string    `json:"lastError,omitempty"`
	LastAttemptAt time.Time `json:"lastAttemptAt,omitempty"`
	AlertCount    int       `json:"alertCount,omitempty"`
	NextAlertAt   time.Time `json:"nextAlertAt,omitempty"`
}

type persistedAttachUnit struct {
	Tid       string       `json:"tid"`
	AvgPx     float64      `json:"avgPx,omitempty"`
	SzCoin    float64      `json:"szCoin,omitempty"`
	TP        persistedLeg `json:"tp"`
	SL        persistedLeg `json:"sl"`
	CreatedAt time.Time    `json:"createdAt,omitempty"`
}

type persistedProtection struct {
	Coin       string                `json:"coin"`
	IsEntryBuy bool                  `json:"isEntryBuy"`
	TpPct      float64               `json:"tpPct"`
	SlPct      float64               `json:"slPct"`
	Mainnet    bool                  `json:"mainnet"`
	Testnet    bool                  `json:"testnet"`
	CreatedAt  time.Time             `json:"createdAt"`
	Attaches   []persistedAttachUnit `json:"attaches,omitempty"`
	Closed     bool                  `json:"closed,omitempty"`
	TerminalAt time.Time             `json:"terminalAt,omitempty"`

	// Legacy fields (pre per-leg-tracking). Only ever populated when reading
	// a file written by the old binary; never written by this one. Detected
	// by loadPendingProtection and migrated into fully-Done Attaches units so
	// the fill-dedupe guarantee survives an upgrade restart without risking a
	// post-upgrade replay double-placing an already-live leg.
	LegacyAttachedSzCoin float64  `json:"attachedSzCoin,omitempty"`
	LegacySeenTids       []string `json:"seenTids,omitempty"`
}

func (s *OrderService) resolveProtectionOidLocked(account string, oid int64) int64 {
	if canon, ok := s.protectionAlias[account][oid]; ok && canon > 0 {
		return canon
	}
	return oid
}

// clearProtectionAliasesToLocked drops every alias that points at canonicalOid.
// Must be called with protectMu held.
func (s *OrderService) clearProtectionAliasesToLocked(account string, canonicalOid int64) {
	aliases := s.protectionAlias[account]
	if len(aliases) == 0 {
		return
	}
	for from, to := range aliases {
		if to == canonicalOid || from == canonicalOid {
			delete(aliases, from)
		}
	}
	if len(aliases) == 0 {
		delete(s.protectionAlias, account)
	}
}

// savePendingProtectionLocked snapshots the queued protection requests to
// disk. Must be called with protectMu held. Best-effort: a failed write only
// loses restart durability, never live behavior.
func (s *OrderService) savePendingProtectionLocked() {
	persisted := make(map[string]map[string]persistedProtection, len(s.protectionByID))
	for account, entries := range s.protectionByID {
		if len(entries) == 0 {
			continue
		}
		byOid := make(map[string]persistedProtection, len(entries))
		for oid, entry := range entries {
			attaches := make([]persistedAttachUnit, 0, len(entry.Attaches))
			for _, u := range entry.Attaches {
				attaches = append(attaches, persistedAttachUnit{
					Tid:    u.Tid,
					AvgPx:  u.AvgPx,
					SzCoin: u.SzCoin,
					TP: persistedLeg{
						Cloid:    u.TP.Cloid,
						Required: u.TP.Required, Done: u.TP.Done, Attempts: u.TP.Attempts,
						LastError: u.TP.LastError, LastAttemptAt: u.TP.LastAttemptAt,
						AlertCount: u.TP.AlertCount, NextAlertAt: u.TP.NextAlertAt,
					},
					SL: persistedLeg{
						Cloid:    u.SL.Cloid,
						Required: u.SL.Required, Done: u.SL.Done, Attempts: u.SL.Attempts,
						LastError: u.SL.LastError, LastAttemptAt: u.SL.LastAttemptAt,
						AlertCount: u.SL.AlertCount, NextAlertAt: u.SL.NextAlertAt,
					},
					CreatedAt: u.CreatedAt,
				})
			}
			byOid[fmt.Sprintf("%d", oid)] = persistedProtection{
				Coin:       entry.Coin,
				IsEntryBuy: entry.IsEntryBuy,
				TpPct:      entry.TpPct,
				SlPct:      entry.SlPct,
				Mainnet:    entry.Mainnet,
				Testnet:    entry.Testnet,
				CreatedAt:  entry.CreatedAt,
				Attaches:   attaches,
				Closed:     entry.Closed,
				TerminalAt: entry.TerminalAt,
			}
		}
		persisted[account] = byOid
	}

	if len(persisted) == 0 {
		_ = os.Remove(pendingProtectionFile)
		return
	}
	data, err := json.Marshal(persisted)
	if err != nil {
		return
	}
	if err := writeFileAtomic(pendingProtectionFile, data, 0600); err != nil {
		log.Printf("WARNING: failed to persist pending TP/SL protection: %v", err)
	}
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	if dirHandle, err := os.Open(dir); err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return nil
}

// migrateLegacyPersistedProtection converts an on-disk entry written by the
// pre-per-leg-tracking binary (SeenTids/AttachedSzCoin, no Attaches) into
// fully-Done attach units. There is no avgPx/size to recover for those old
// fills, but marking them Done is enough to preserve the fill-dedupe
// guarantee across the upgrade: without this, a fill replayed by Hyperliquid
// after the upgrade restart would look "new" to the new binary and could
// double-place an already-live leg.
func migrateLegacyPersistedProtection(entry persistedProtection) []persistedAttachUnit {
	if len(entry.Attaches) > 0 || len(entry.LegacySeenTids) == 0 {
		return entry.Attaches
	}
	migrated := make([]persistedAttachUnit, 0, len(entry.LegacySeenTids))
	for _, tid := range entry.LegacySeenTids {
		migrated = append(migrated, persistedAttachUnit{
			Tid: tid,
			TP:  persistedLeg{Required: entry.TpPct > 0, Done: entry.TpPct > 0},
			SL:  persistedLeg{Required: entry.SlPct > 0, Done: entry.SlPct > 0},
		})
	}
	return migrated
}

func (s *OrderService) loadPendingProtection() {
	data, err := os.ReadFile(pendingProtectionFile)
	if err != nil {
		return
	}
	var persisted map[string]map[string]persistedProtection
	if err := json.Unmarshal(data, &persisted); err != nil {
		log.Printf("WARNING: could not parse %s: %v", pendingProtectionFile, err)
		return
	}

	now := time.Now()
	restored := 0
	s.protectMu.Lock()
	defer s.protectMu.Unlock()
	for account, entries := range persisted {
		for oidText, entry := range entries {
			oid, err := strconv.ParseInt(oidText, 10, 64)
			if err != nil || oid <= 0 {
				continue
			}
			if entry.CreatedAt.Add(protectionTTL).Before(now) {
				continue
			}
			if s.protectionByID[account] == nil {
				s.protectionByID[account] = make(map[int64]protectionRequest)
			}
			attachSource := migrateLegacyPersistedProtection(entry)
			attaches := make([]protectionAttachUnit, 0, len(attachSource))
			for _, u := range attachSource {
				attaches = append(attaches, protectionAttachUnit{
					Tid: u.Tid, AvgPx: u.AvgPx, SzCoin: u.SzCoin,
					TP: protectionLeg{
						Cloid:    u.TP.Cloid,
						Required: u.TP.Required, Done: u.TP.Done, Attempts: u.TP.Attempts,
						LastError: u.TP.LastError, LastAttemptAt: u.TP.LastAttemptAt,
						AlertCount: u.TP.AlertCount, NextAlertAt: u.TP.NextAlertAt,
					},
					SL: protectionLeg{
						Cloid:    u.SL.Cloid,
						Required: u.SL.Required, Done: u.SL.Done, Attempts: u.SL.Attempts,
						LastError: u.SL.LastError, LastAttemptAt: u.SL.LastAttemptAt,
						AlertCount: u.SL.AlertCount, NextAlertAt: u.SL.NextAlertAt,
					},
					CreatedAt: u.CreatedAt,
				})
			}
			// PrivateKey intentionally empty: re-resolved from keycache when
			// the fill arrives (single-user app, key restored via set-key).
			s.protectionByID[account][oid] = protectionRequest{
				Coin:       entry.Coin,
				IsEntryBuy: entry.IsEntryBuy,
				TpPct:      entry.TpPct,
				SlPct:      entry.SlPct,
				Mainnet:    entry.Mainnet,
				Testnet:    entry.Testnet,
				CreatedAt:  entry.CreatedAt,
				Attaches:   attaches,
				Closed:     entry.Closed,
				TerminalAt: entry.TerminalAt,
			}
			restored++
		}
	}
	if restored > 0 {
		log.Printf("restored %d pending TP/SL protection request(s) from %s", restored, pendingProtectionFile)
	}
}

func (s *OrderService) BuildScalePreview(_ context.Context, req models.ScalePreviewRequest) (*models.ScalePreviewResponse, error) {
	if strings.TrimSpace(req.Coin) == "" {
		return nil, errors.ErrInvalidCoin
	}
	if req.TotalUsd <= 0 {
		return nil, errors.ErrInvalidSize
	}
	if req.NumOrders < 1 || req.NumOrders > 20 {
		return nil, fmt.Errorf("orders must be 1-20")
	}
	if req.HighPx <= 0 || req.LowPx <= 0 || req.HighPx <= req.LowPx {
		return nil, fmt.Errorf("high price must be greater than low price")
	}

	orderSizeUsd := req.TotalUsd / float64(req.NumOrders)
	if !req.ReduceOnly && orderSizeUsd < 10 {
		return nil, fmt.Errorf("each scale order must be at least $10")
	}

	if s.metadataCache == nil {
		return nil, fmt.Errorf("unknown tick size for %s", req.Coin)
	}
	tickSize := s.metadataCache.GetTickSize(req.Coin)
	if tickSize <= 0 {
		return nil, fmt.Errorf("unknown tick size for %s", req.Coin)
	}

	roundedLow := roundScalePriceToTick(req.LowPx, tickSize)
	roundedHigh := roundScalePriceToTick(req.HighPx, tickSize)

	numSteps := req.NumOrders - 1
	tickStep := 0.0
	if numSteps > 0 {
		rawStep := (roundedHigh - roundedLow) / float64(numSteps)
		tickStep = math.Round(rawStep / tickSize)
	}

	orders := make([]models.OrderRequest, 0, req.NumOrders)
	for i := 0; i < req.NumOrders; i++ {
		px := roundedLow
		if req.IsBuy {
			px = roundedLow + (tickStep * tickSize * float64(i))
		} else {
			px = roundedHigh - (tickStep * tickSize * float64(i))
		}

		orders = append(orders, models.OrderRequest{
			Coin:       req.Coin,
			IsBuy:      req.IsBuy,
			Sz:         orderSizeUsd,
			LimitPx:    roundScalePriceToTick(px, tickSize),
			ReduceOnly: req.ReduceOnly,
			Mainnet:    req.Mainnet,
			Testnet:    req.Testnet,
		})
	}

	return &models.ScalePreviewResponse{Orders: orders}, nil
}

func roundScalePriceToTick(price, tickSize float64) float64 {
	if price <= 0 || tickSize <= 0 {
		return price
	}
	tickDecimals := 0
	if tickSize < 1 {
		tickDecimals = int(math.Ceil(math.Log10(1 / tickSize)))
	}
	rounded := math.Round(price/tickSize) * tickSize
	if tickDecimals <= 0 {
		return math.Round(rounded)
	}
	scale := math.Pow10(tickDecimals)
	return math.Round(rounded*scale) / scale
}

func (s *OrderService) publishOrderUpdate(account string, payload interface{}) {
	if s.publisher == nil {
		return
	}
	s.publisher.Publish(streaming.Event{
		Type: streaming.EventOrderUpdate,
		Payload: map[string]interface{}{
			"account": account,
			"data":    payload,
		},
	})
}

func (s *OrderService) maybeRegisterProtection(ctx context.Context, account string, req models.OrderRequest, result interface{}) {
	if s.exchange == nil {
		return
	}
	if req.TpPct <= 0 && req.SlPct <= 0 {
		return
	}

	key := normalizeRuntimeAccount(account)
	if key == "" {
		return
	}

	if filled := extractFilledFromResult(result); filled != nil {
		s.registerImmediateFillProtection(key, req, filled)
		return
	}

	oid := extractAcceptedOid(result)
	if oid <= 0 {
		return
	}

	s.protectMu.Lock()
	defer s.protectMu.Unlock()
	if s.protectionByID[key] == nil {
		s.protectionByID[key] = make(map[int64]protectionRequest)
	}
	s.protectionByID[key][oid] = protectionRequest{
		PrivateKey: req.PrivateKey,
		Coin:       req.Coin,
		IsEntryBuy: req.IsBuy,
		TpPct:      req.TpPct,
		SlPct:      req.SlPct,
		Mainnet:    req.Mainnet,
		Testnet:    req.Testnet,
		CreatedAt:  time.Now(),
	}
	s.savePendingProtectionLocked()
}

// registerImmediateFillProtection handles an order that filled synchronously
// in the same PlaceOrder response. Unlike the old code path (a bare detached
// goroutine with no durable record), the attach unit is persisted to
// protectionByID/pending_protection.json *before* any exchange call is made,
// so a crash mid-attach is recoverable by the background retry sweep or a
// subsequent restart instead of silently losing the request.
func (s *OrderService) registerImmediateFillProtection(key string, req models.OrderRequest, filled interface{}) {
	avgPx, totalSzCoin, ok := extractFilledAvgPxAndSize(filled)
	if !ok {
		return
	}
	filledMap, _ := filled.(map[string]interface{})
	oid := extractRuntimeNestedOid(filledMap)
	if oid <= 0 {
		// Never observed in practice — every known immediate-fill response
		// shape carries an oid inside "filled". Attempt once, best-effort,
		// without durable persistence rather than silently dropping it.
		unit := protectionAttachUnit{
			Tid:       fmt.Sprintf("immediate:unkeyed:%d", time.Now().UnixNano()),
			AvgPx:     avgPx,
			SzCoin:    totalSzCoin,
			TP:        protectionLeg{Required: req.TpPct > 0},
			SL:        protectionLeg{Required: req.SlPct > 0},
			CreatedAt: time.Now(),
		}
		go func() {
			attempted := s.attemptProtectionAttachUnit(s.backgroundContext(), key, req, unit, unit.TP.Required, unit.SL.Required, time.Now())
			if (attempted.TP.Required && !attempted.TP.Done) || (attempted.SL.Required && !attempted.SL.Done) {
				err := fmt.Errorf("tp_error=%q sl_error=%q", attempted.TP.LastError, attempted.SL.LastError)
				log.Printf("WARNING: failed to attach TP/SL protection for %s (no oid to persist against): %v", req.Coin, err)
				s.publishProtectionError(key, req.Coin, err)
			}
		}()
		return
	}

	tid := fmt.Sprintf("immediate:%d", oid)
	unit := protectionAttachUnit{
		Tid:       tid,
		AvgPx:     avgPx,
		SzCoin:    totalSzCoin,
		TP:        protectionLeg{Required: req.TpPct > 0},
		SL:        protectionLeg{Required: req.SlPct > 0},
		CreatedAt: time.Now(),
	}

	s.protectMu.Lock()
	if s.protectionByID[key] == nil {
		s.protectionByID[key] = make(map[int64]protectionRequest)
	}
	s.protectionByID[key][oid] = protectionRequest{
		PrivateKey: req.PrivateKey,
		Coin:       req.Coin,
		IsEntryBuy: req.IsBuy,
		TpPct:      req.TpPct,
		SlPct:      req.SlPct,
		Mainnet:    req.Mainnet,
		Testnet:    req.Testnet,
		CreatedAt:  time.Now(),
		Attaches:   []protectionAttachUnit{unit},
		// Closed: the whole order already filled, so no further fills are
		// expected for this oid — but the entry (and a still-incomplete
		// unit) must survive until every required leg attaches.
		Closed: true,
	}
	s.savePendingProtectionLocked()
	s.protectMu.Unlock()

	// Placing TP/SL legs costs one signed exchange round-trip each. Doing
	// that inline makes the /api/order response wait on three serial orders
	// (base + TP + SL), which is what leaves the ticket stuck on "pending".
	// The base order result is already independent of protection success
	// (failures only log/publish; they never change the returned result), so
	// detaching this changes timing, not the response contract. A background
	// context is required because the request context is cancelled once the
	// HTTP handler returns.
	go func() {
		s.applyAttachAttempt(s.backgroundContext(), key, oid, tid, req)
	}()
}

var errNoSigningKey = fmt.Errorf("no signing key available to attach TP/SL protection")

// attemptProtectionAttachUnit places whichever of attemptTP/attemptSL are
// requested, independently of each other's outcome: a TP failure must never
// suppress the SL attempt (or vice versa), which is what previously
// guaranteed a double-miss whenever the first leg placed happened to fail.
func protectionCloid(account, coin, tid, leg string) string {
	sum := sha256.Sum256([]byte("pez-protection\x00" + account + "\x00" + coin + "\x00" + tid + "\x00" + leg))
	return fmt.Sprintf("0x%x", sum[:16])
}

func ensureProtectionCloids(account string, req models.OrderRequest, unit *protectionAttachUnit) {
	if unit.TP.Required && unit.TP.Cloid == "" {
		unit.TP.Cloid = protectionCloid(account, req.Coin, unit.Tid, "tp")
	}
	if unit.SL.Required && unit.SL.Cloid == "" {
		unit.SL.Cloid = protectionCloid(account, req.Coin, unit.Tid, "sl")
	}
}

func (s *OrderService) attemptProtectionAttachUnit(ctx context.Context, account string, req models.OrderRequest, unit protectionAttachUnit, attemptTP, attemptSL bool, now time.Time) protectionAttachUnit {
	ensureProtectionCloids(account, req, &unit)
	if req.PrivateKey == "" {
		if attemptTP {
			unit.TP = recordLegFailure(unit.TP, now, errNoSigningKey)
		}
		if attemptSL {
			unit.SL = recordLegFailure(unit.SL, now, errNoSigningKey)
		}
		return unit
	}

	reduceIsBuy := !req.IsBuy
	testnet := req.Testnet && !req.Mainnet
	buildLeg := func(cloid, tpsl string, triggerPx float64) models.TriggerOrderRequest {
		return models.TriggerOrderRequest{
			PrivateKey: req.PrivateKey,
			Cloid:      cloid,
			Coin:       req.Coin,
			IsBuy:      reduceIsBuy,
			Sz:         unit.SzCoin * triggerPx,
			SzCoin:     unit.SzCoin,
			TriggerPx:  triggerPx,
			IsMarket:   true,
			Tpsl:       tpsl,
			Testnet:    testnet,
		}
	}
	tpPx := unit.AvgPx * (1 + req.TpPct/100)
	if !req.IsBuy {
		tpPx = unit.AvgPx * (1 - req.TpPct/100)
	}
	slPx := unit.AvgPx * (1 - req.SlPct/100)
	if !req.IsBuy {
		slPx = unit.AvgPx * (1 + req.SlPct/100)
	}

	// Official grouping: one action with both legs so siblingFilledCanceled works.
	if attemptTP && attemptSL {
		errs := s.exchange.PlaceTriggerOrders(ctx, []models.TriggerOrderRequest{
			buildLeg(unit.TP.Cloid, "tp", tpPx),
			buildLeg(unit.SL.Cloid, "sl", slPx),
		})
		applyProtectionLegResult := func(leg *protectionLeg, err error, label string, px float64) {
			if err != nil {
				*leg = recordLegFailure(*leg, now, err)
				return
			}
			log.Printf("attachProtection: %s placed coin=%s triggerPx=%.6f notionalUsd=%.4f", label, req.Coin, px, unit.SzCoin*px)
			leg.Done = true
			leg.Attempts++
			leg.LastAttemptAt = now
			leg.LastError = ""
		}
		var tpErr, slErr error
		if len(errs) > 0 {
			tpErr = errs[0]
		}
		if len(errs) > 1 {
			slErr = errs[1]
		}
		applyProtectionLegResult(&unit.TP, tpErr, "TP", tpPx)
		applyProtectionLegResult(&unit.SL, slErr, "SL", slPx)
		return unit
	}

	if attemptTP {
		err := s.exchange.PlaceTriggerOrder(ctx, buildLeg(unit.TP.Cloid, "tp", tpPx))
		if err != nil {
			unit.TP = recordLegFailure(unit.TP, now, err)
		} else {
			log.Printf("attachProtection: TP placed coin=%s triggerPx=%.6f notionalUsd=%.4f", req.Coin, tpPx, unit.SzCoin*tpPx)
			unit.TP.Done = true
			unit.TP.Attempts++
			unit.TP.LastAttemptAt = now
			unit.TP.LastError = ""
		}
	}
	if attemptSL {
		err := s.exchange.PlaceTriggerOrder(ctx, buildLeg(unit.SL.Cloid, "sl", slPx))
		if err != nil {
			unit.SL = recordLegFailure(unit.SL, now, err)
		} else {
			log.Printf("attachProtection: SL placed coin=%s triggerPx=%.6f notionalUsd=%.4f", req.Coin, slPx, unit.SzCoin*slPx)
			unit.SL.Done = true
			unit.SL.Attempts++
			unit.SL.LastAttemptAt = now
			unit.SL.LastError = ""
		}
	}
	return unit
}

func recordLegFailure(leg protectionLeg, now time.Time, err error) protectionLeg {
	leg.Attempts++
	leg.LastAttemptAt = now
	leg.LastError = err.Error()
	return leg
}

// protectionAlertBackoff is the escalating cadence (after the first,
// immediate alert) on which a persistently failing leg is re-surfaced:
// 1m, then 5m, then 15m, then hourly forever. Never gives up retrying the
// leg itself (see retryIncompleteProtectionAttachesOnce) — only the alert
// noise is throttled, so a stuck leg is never silent for long but never spams.
var protectionAlertBackoff = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}

func protectionAlertBackoffFor(alertCount int) time.Duration {
	idx := alertCount - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(protectionAlertBackoff) {
		idx = len(protectionAlertBackoff) - 1
	}
	return protectionAlertBackoff[idx]
}

// shouldAlertLeg decides whether a failing leg should be published now, and
// if so advances its throttle state. Must be called with protectMu held.
func shouldAlertLeg(leg *protectionLeg, now time.Time) bool {
	if leg.Done || leg.LastError == "" {
		return false
	}
	if !leg.NextAlertAt.IsZero() && now.Before(leg.NextAlertAt) {
		return false
	}
	leg.AlertCount++
	leg.NextAlertAt = now.Add(protectionAlertBackoffFor(leg.AlertCount))
	return true
}

func indexOfAttachUnit(units []protectionAttachUnit, tid string) int {
	for i, u := range units {
		if u.Tid == tid {
			return i
		}
	}
	return -1
}

// applyAttachAttempt is the single code path (shared by the immediate-fill
// goroutine, ProcessUserFills, and the background retry sweep) that attempts
// whichever legs of the named unit are still outstanding and persists the
// result. The Attempting guard on each leg prevents the sweep and a live
// fill event from racing to place the same leg twice.
func (s *OrderService) applyAttachAttempt(ctx context.Context, key string, oid int64, tid string, req models.OrderRequest) {
	now := time.Now()

	s.protectMu.Lock()
	oid = s.resolveProtectionOidLocked(key, oid)
	entries := s.protectionByID[key]
	entry, ok := entries[oid]
	if !ok {
		s.protectMu.Unlock()
		return
	}
	idx := indexOfAttachUnit(entry.Attaches, tid)
	if idx < 0 {
		s.protectMu.Unlock()
		return
	}
	unit := entry.Attaches[idx]
	ensureProtectionCloids(key, req, &unit)
	tpClaimed := unit.TP.Required && !unit.TP.Done && !unit.TP.Attempting
	slClaimed := unit.SL.Required && !unit.SL.Done && !unit.SL.Attempting
	if !tpClaimed && !slClaimed {
		s.protectMu.Unlock()
		return
	}
	if tpClaimed {
		unit.TP.Attempting = true
	}
	if slClaimed {
		unit.SL.Attempting = true
	}
	entry.Attaches[idx] = unit
	entries[oid] = entry
	// Persist the stable client ids before the signed calls. If a response is
	// lost after the exchange accepts a leg, every later retry uses the same id.
	s.savePendingProtectionLocked()
	s.protectMu.Unlock()

	attempted := s.attemptProtectionAttachUnit(ctx, key, req, unit, tpClaimed, slClaimed, now)

	s.protectMu.Lock()
	entries = s.protectionByID[key]
	entry, ok = entries[oid]
	if !ok {
		s.protectMu.Unlock()
		return
	}
	idx = indexOfAttachUnit(entry.Attaches, tid)
	if idx < 0 {
		s.protectMu.Unlock()
		return
	}
	current := entry.Attaches[idx]
	if tpClaimed {
		current.TP = attempted.TP
		current.TP.Attempting = false
	}
	if slClaimed {
		current.SL = attempted.SL
		current.SL.Attempting = false
	}

	var alerts []string
	if tpClaimed && shouldAlertLeg(&current.TP, now) {
		alerts = append(alerts, fmt.Sprintf("TP: %s", current.TP.LastError))
	}
	if slClaimed && shouldAlertLeg(&current.SL, now) {
		alerts = append(alerts, fmt.Sprintf("SL: %s", current.SL.LastError))
	}
	entry.Attaches[idx] = current
	entries[oid] = entry

	if entry.Closed && entry.allDone() {
		delete(entries, oid)
		s.clearProtectionAliasesToLocked(key, oid)
		if len(entries) == 0 {
			delete(s.protectionByID, key)
		}
	}
	s.savePendingProtectionLocked()
	coin := entry.Coin
	s.protectMu.Unlock()

	if len(alerts) > 0 {
		s.publishProtectionError(key, coin, fmt.Errorf("%s", strings.Join(alerts, "; ")))
	}
}

func extractFilledAvgPxAndSize(filled interface{}) (float64, float64, bool) {
	root, ok := filled.(map[string]interface{})
	if !ok || root == nil {
		return 0, 0, false
	}
	avgPx := parseRuntimeFloat(root["avgPx"])
	if avgPx <= 0 {
		avgPx = parseRuntimeFloat(root["px"])
	}
	if avgPx <= 0 {
		avgPx = parseRuntimeFloat(root["price"])
	}
	totalSzCoin := parseRuntimeFloat(root["totalSz"])
	if totalSzCoin <= 0 {
		totalSzCoin = parseRuntimeFloat(root["sz"])
	}
	if totalSzCoin <= 0 {
		totalSzCoin = parseRuntimeFloat(root["size"])
	}
	if avgPx <= 0 || totalSzCoin <= 0 {
		return 0, 0, false
	}
	return avgPx, totalSzCoin, true
}

// cleanupExpiredProtectionLocked evicts expired protection requests. Entries
// whose order went terminal expire after a short grace window instead of the
// full TTL. Three outcomes, never conflated:
//   - never attached at all (no Attaches recorded): loud, returned via
//     neverAttached, deleted — nothing was ever protected.
//   - every required leg on every unit is Done: quiet delete — fully
//     protected, safe to forget.
//   - some unit still has an incomplete leg: never silently dropped. The
//     entry is marked Closed (stop expecting new fills) and kept for the
//     background retry sweep; returned via partiallyExpired exactly once (the
//     transition into Closed), so this doesn't repeat every sweep tick.
func (s *OrderService) cleanupExpiredProtectionLocked(account string, now time.Time) (neverAttached, partiallyExpired []protectionRequest) {
	entries := s.protectionByID[account]
	for oid, entry := range entries {
		terminalExpired := !entry.TerminalAt.IsZero() && entry.TerminalAt.Add(protectionTerminalGrace).Before(now)
		ttlExpired := entry.CreatedAt.Add(protectionTTL).Before(now)
		if !terminalExpired && !ttlExpired {
			continue
		}
		switch {
		case len(entry.Attaches) == 0:
			log.Printf("WARNING: TP/SL protection request expired before fill (coin=%s oid=%d terminal=%v age>%s)", entry.Coin, oid, terminalExpired, protectionTTL)
			neverAttached = append(neverAttached, entry)
			delete(entries, oid)
			s.clearProtectionAliasesToLocked(account, oid)
		case entry.allDone():
			delete(entries, oid)
			s.clearProtectionAliasesToLocked(account, oid)
		default:
			if !entry.Closed {
				entry.Closed = true
				entries[oid] = entry
				log.Printf("WARNING: TP/SL protection request expired with an incomplete leg still pending automatic retry (coin=%s oid=%d terminal=%v)", entry.Coin, oid, terminalExpired)
				partiallyExpired = append(partiallyExpired, entry)
			}
		}
	}
	if len(entries) == 0 {
		delete(s.protectionByID, account)
	}
	return neverAttached, partiallyExpired
}

// clearProtectionByOid is called after a confirmed cancel. It must not drop
// an entry that still has an incomplete leg from an earlier partial fill —
// that fill already happened and its missing leg still needs the retry
// sweep, regardless of the resting remainder being cancelled.
func (s *OrderService) clearProtectionByOid(account string, oid int64) {
	if account == "" || oid <= 0 {
		return
	}
	key := normalizeRuntimeAccount(account)
	s.protectMu.Lock()
	defer s.protectMu.Unlock()
	oid = s.resolveProtectionOidLocked(key, oid)
	entries := s.protectionByID[key]
	if entry, ok := entries[oid]; ok {
		if entry.hasIncomplete() {
			entry.Closed = true
			entries[oid] = entry
		} else {
			delete(entries, oid)
			s.clearProtectionAliasesToLocked(key, oid)
		}
	}
	if len(entries) == 0 {
		delete(s.protectionByID, key)
	}
	s.savePendingProtectionLocked()
}

func (s *OrderService) ProcessUserFills(ctx context.Context, account string, fills []interface{}) {
	if s.exchange == nil || account == "" || len(fills) == 0 {
		return
	}

	key := normalizeRuntimeAccount(account)
	now := time.Now()

	for _, rawFill := range fills {
		fill, ok := rawFill.(map[string]interface{})
		if !ok || fill == nil {
			continue
		}
		oid := extractRuntimeNestedOid(fill)
		if oid <= 0 {
			continue
		}
		tid := fillDedupeKey(fill)

		s.protectMu.Lock()
		neverAttached, partiallyExpired := s.cleanupExpiredProtectionLocked(key, now)
		// Follow modify re-key aliases so a fill still keyed by the pre-modify
		// oid (or the replacement oid after re-key) finds the same request.
		canonicalOid := s.resolveProtectionOidLocked(key, oid)
		entry, hasEntry := s.protectionByID[key][canonicalOid]
		if !hasEntry {
			if len(neverAttached) > 0 || len(partiallyExpired) > 0 {
				s.savePendingProtectionLocked()
			}
			s.protectMu.Unlock()
			s.publishProtectionExpiry(key, neverAttached, partiallyExpired)
			continue
		}

		existingIdx := indexOfAttachUnit(entry.Attaches, tid)
		// An order that filled synchronously is registered before PlaceOrder
		// returns under an immediate:<oid> key. Hyperliquid then replays that
		// same fill on userFills with a trade-id key. Because the immediate
		// result is terminal (entry.Closed), that user-stream event cannot be a
		// new partial fill: route it to the already-persisted unit instead of
		// creating a second TP/SL pair.
		if existingIdx < 0 && entry.Closed {
			for i := range entry.Attaches {
				if strings.HasPrefix(entry.Attaches[i].Tid, "immediate:") {
					existingIdx = i
					tid = entry.Attaches[i].Tid
					break
				}
			}
		}
		alreadyDone := existingIdx >= 0 && entry.Attaches[existingIdx].fullyAttached()
		extractFailed := false
		if existingIdx < 0 {
			// New fill: a fresh attach unit is required. Each partial fill of
			// a resting order gets its own unit and its own independent leg
			// tracking, so the entry must outlive the first fill.
			avgPx, szCoin, extractOk := extractFilledAvgPxAndSize(fill)
			if extractOk {
				entry.Attaches = append(entry.Attaches, protectionAttachUnit{
					Tid:       tid,
					AvgPx:     avgPx,
					SzCoin:    szCoin,
					TP:        protectionLeg{Required: entry.TpPct > 0},
					SL:        protectionLeg{Required: entry.SlPct > 0},
					CreatedAt: now,
				})
				s.protectionByID[key][canonicalOid] = entry
			} else {
				extractFailed = true
			}
		}
		s.savePendingProtectionLocked()
		s.protectMu.Unlock()
		s.publishProtectionExpiry(key, neverAttached, partiallyExpired)

		if extractFailed {
			log.Printf("WARNING: could not extract fill price/size for protection attach (coin=%s oid=%d)", entry.Coin, canonicalOid)
			continue
		}
		if alreadyDone {
			// Pure replay of an already-protected fill: never re-place a live leg.
			continue
		}

		// Entries restored from disk carry no key; re-resolve it from the
		// key cache (single-user app, key restored via /api/set-key).
		signingKey := entry.PrivateKey
		if signingKey == "" {
			signingKey = keycache.GetWithFallback()
		}
		req := models.OrderRequest{
			PrivateKey: signingKey,
			Coin:       entry.Coin,
			IsBuy:      entry.IsEntryBuy,
			TpPct:      entry.TpPct,
			SlPct:      entry.SlPct,
			Mainnet:    entry.Mainnet,
			Testnet:    entry.Testnet,
		}
		s.applyAttachAttempt(ctx, key, canonicalOid, tid, req)
	}
}

// publishProtectionExpiry surfaces cleanupExpiredProtectionLocked's findings
// outside the lock, using distinct messages for the two cases so a partial
// (still-retrying) expiry is never confused with a total loss.
func (s *OrderService) publishProtectionExpiry(key string, neverAttached, partiallyExpired []protectionRequest) {
	for _, lost := range neverAttached {
		s.publishProtectionError(key, lost.Coin, fmt.Errorf("TP/SL request expired before the order filled; protection was not attached"))
	}
	for _, lost := range partiallyExpired {
		s.publishProtectionError(key, lost.Coin, fmt.Errorf("TP/SL request expired with an incomplete leg; automatic retry continues in the background"))
	}
}

// fillDedupeKey identifies a fill across stream delivery and snapshot replay.
// Hyperliquid fills carry a unique trade id; fall back to time+size so a
// missing tid still dedupes the common replay case.
func fillDedupeKey(fill map[string]interface{}) string {
	if tid := parseRuntimeFloat(fill["tid"]); tid > 0 {
		return fmt.Sprintf("%.0f", tid)
	}
	return fmt.Sprintf("t%v|s%v", fill["time"], fill["sz"])
}

// ProcessOrderUpdates retires pending TP/SL protection when its order goes
// terminal on-exchange. Cancel-like statuses delete the entry immediately
// unless an earlier partial fill left a leg incomplete, in which case the
// entry is kept (Closed, no more fills expected) for the retry sweep instead
// of abandoning that fill's protection. "filled" only stamps TerminalAt so
// fills that race the status — or arrive via snapshot replay after a
// reconnect — can still attach during the grace window.
func (s *OrderService) ProcessOrderUpdates(account string, updates []interface{}) {
	key := normalizeRuntimeAccount(account)
	if key == "" || len(updates) == 0 {
		return
	}

	s.protectMu.Lock()
	defer s.protectMu.Unlock()
	entries := s.protectionByID[key]
	if len(entries) == 0 {
		return
	}

	changed := false
	for _, rawUpdate := range updates {
		update, ok := rawUpdate.(map[string]interface{})
		if !ok || update == nil {
			continue
		}
		oid := extractRuntimeNestedOid(update)
		if oid <= 0 {
			continue
		}
		// Do not follow re-key aliases here: after cancel+replace the exchange
		// cancels the old oid; that must not clear protection on the replacement.
		entry, ok := entries[oid]
		if !ok {
			continue
		}
		status := strings.ToLower(stringValue(update["status"]))
		switch {
		case strings.Contains(status, "fill"):
			if entry.TerminalAt.IsZero() {
				entry.TerminalAt = time.Now()
				entries[oid] = entry
				changed = true
			}
		case strings.Contains(status, "cancel"), strings.Contains(status, "reject"), strings.Contains(status, "expire"):
			if entry.hasIncomplete() {
				if !entry.Closed {
					entry.Closed = true
					entries[oid] = entry
					changed = true
				}
			} else {
				delete(entries, oid)
				s.clearProtectionAliasesToLocked(key, oid)
				changed = true
			}
		}
	}
	if len(entries) == 0 {
		delete(s.protectionByID, key)
	}
	if changed {
		s.savePendingProtectionLocked()
	}
}

// protectionRetrySweepInterval is how often the background sweep scans
// protectionByID for units with an incomplete required leg. There is no other
// periodic mechanism that retries a failed attach — without this, a failed
// leg is only retried by a fill-event replay (e.g. on stream reconnect),
// which may never happen.
const protectionRetrySweepInterval = 20 * time.Second

// StartProtectionRetrySweep launches the background retry loop. Call once at
// startup with the process's root cancellable context so it shuts down
// alongside the other background loops (candle store, warm coordinator, user
// WS loop).
func (s *OrderService) StartProtectionRetrySweep(ctx context.Context) {
	go s.runProtectionRetrySweep(ctx)
}

func (s *OrderService) runProtectionRetrySweep(ctx context.Context) {
	ticker := time.NewTicker(protectionRetrySweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.retryIncompleteProtectionAttachesOnce(ctx)
		}
	}
}

// retryIncompleteProtectionAttachesOnce is one sweep pass: it snapshots every
// unit with a missing, not-already-in-flight required leg, then retries each
// outside the lock via the same applyAttachAttempt path fills/immediate-fills
// use. A leg that keeps failing is retried forever — an unprotected live
// position is a standing financial risk, and the retry cost is one cheap
// signed HTTP call — but the surfaced protectionError is throttled on an
// escalating cadence (shouldAlertLeg) so it's never silent for long without
// spamming.
func (s *OrderService) retryIncompleteProtectionAttachesOnce(ctx context.Context) {
	now := time.Now()

	type pendingWork struct {
		account string
		oid     int64
		tid     string
		req     models.OrderRequest
	}
	type coinErr struct {
		account string
		coin    string
		err     error
	}

	s.protectMu.Lock()
	var work []pendingWork
	var toPublish []coinErr
	for account, entries := range s.protectionByID {
		neverAttached, partiallyExpired := s.cleanupExpiredProtectionLocked(account, now)
		for _, lost := range neverAttached {
			toPublish = append(toPublish, coinErr{account, lost.Coin, fmt.Errorf("TP/SL request expired before the order filled; protection was not attached")})
		}
		for _, lost := range partiallyExpired {
			toPublish = append(toPublish, coinErr{account, lost.Coin, fmt.Errorf("TP/SL request expired with an incomplete leg; automatic retry continues in the background")})
		}
		for oid, entry := range entries {
			signingKey := ""
			for _, u := range entry.Attaches {
				needsTP := u.TP.Required && !u.TP.Done && !u.TP.Attempting
				needsSL := u.SL.Required && !u.SL.Done && !u.SL.Attempting
				if !needsTP && !needsSL {
					continue
				}
				if signingKey == "" {
					signingKey = entry.PrivateKey
					if signingKey == "" {
						signingKey = keycache.GetWithFallback()
					}
				}
				work = append(work, pendingWork{
					account: account, oid: oid, tid: u.Tid,
					req: models.OrderRequest{
						PrivateKey: signingKey,
						Coin:       entry.Coin,
						IsBuy:      entry.IsEntryBuy,
						TpPct:      entry.TpPct,
						SlPct:      entry.SlPct,
						Mainnet:    entry.Mainnet,
						Testnet:    entry.Testnet,
					},
				})
			}
		}
	}
	s.protectMu.Unlock()

	for _, p := range toPublish {
		s.publishProtectionError(p.account, p.coin, p.err)
	}
	for _, w := range work {
		s.applyAttachAttempt(ctx, w.account, w.oid, w.tid, w.req)
	}
}

func (s *OrderService) rekeyProtection(account string, oldOid, newOid int64) {
	if oldOid <= 0 || newOid <= 0 || oldOid == newOid {
		return
	}
	key := normalizeRuntimeAccount(account)
	s.protectMu.Lock()
	defer s.protectMu.Unlock()
	entries := s.protectionByID[key]
	if entries == nil {
		return
	}
	entry, ok := entries[oldOid]
	if !ok {
		// Already re-keyed (idempotent) or never protected under old oid.
		return
	}
	if existing, exists := entries[newOid]; exists && len(existing.Attaches) > len(entry.Attaches) {
		entry = existing
	}
	delete(entries, oldOid)
	entries[newOid] = entry
	if s.protectionAlias[key] == nil {
		s.protectionAlias[key] = make(map[int64]int64)
	}
	// Chain: if something already aliased to oldOid, retarget it to newOid.
	for from, to := range s.protectionAlias[key] {
		if to == oldOid {
			s.protectionAlias[key][from] = newOid
		}
	}
	s.protectionAlias[key][oldOid] = newOid
	s.savePendingProtectionLocked()
}

func (s *OrderService) publishProtectionError(account, coin string, err error) {
	if s.publisher == nil || err == nil {
		return
	}
	s.publisher.Publish(streaming.Event{
		Type: streaming.EventOrderUpdate,
		Payload: map[string]interface{}{
			"account": account,
			"data": map[string]interface{}{
				"protectionError": map[string]interface{}{
					"coin":  coin,
					"error": err.Error(),
				},
			},
		},
	})
}
