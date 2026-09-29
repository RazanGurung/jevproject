// Hyperliquid wire types and float formatting for signed /exchange actions.
//
// Forked from github.com/sonirico/go-hyperliquid v0.36.0 (MIT License,
// Copyright (c) 2025 Marquitos) when the SDK dependency was removed.
//
// CRITICAL: struct field order and tag spelling are part of the signature.
// The msgpack encoding of these structs (insertion-ordered fields) feeds the
// L1 action hash, and the JSON encoding is the wire payload the exchange
// validates against the recovered signing address. Field order must match the
// Python SDK's insertion order (see hyperliquid-python-sdk signing.py).
// Parity with the original SDK encodings is pinned by hlwire_golden_test.go.
package exchange

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// resolveOrderCloid returns a normalized caller-supplied client order id or
// creates a fresh 16-byte id. Every newly-created order carries a cloid so an
// ambiguous transport outcome can be reconciled without submitting a second
// logically distinct order.
func resolveOrderCloid(raw string) (*string, error) {
	if strings.TrimSpace(raw) != "" {
		normalized, err := normalizeCloid(strings.TrimSpace(raw))
		if err != nil {
			return nil, err
		}
		return &normalized, nil
	}

	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return nil, fmt.Errorf("generate cloid: %w", err)
	}
	generated := "0x" + hex.EncodeToString(value[:])
	return &generated, nil
}

const (
	mainnetAPIURL = "https://api.hyperliquid.xyz"
	testnetAPIURL = "https://api.hyperliquid-testnet.xyz"
)

// MainnetAPIURL is the public Hyperliquid mainnet REST base URL.
const MainnetAPIURL = mainnetAPIURL

type Tif string

const (
	TifIoc Tif = "Ioc"
	TifGtc Tif = "Gtc"
	TifAlo Tif = "Alo"
)

type Tpsl string

const (
	TakeProfit Tpsl = "tp"
	StopLoss   Tpsl = "sl"
)

const (
	groupingNA           = "na"
	groupingPositionTpsl = "positionTpsl"
)

// BuilderInfo is the optional builder-fee attribution on order actions.
// Unused by this app (always nil) but kept so OrderAction encodes identically
// to the original SDK struct.
type BuilderInfo struct {
	Builder string `json:"b" msgpack:"b"`
	Fee     int    `json:"f" msgpack:"f"`
}

// OrderWire is an order in exchange wire format.
// CRITICAL: field order must be a, b, p, s, r, t, c.
type OrderWire struct {
	Asset      int           `json:"a"           msgpack:"a"`
	IsBuy      bool          `json:"b"           msgpack:"b"`
	LimitPx    string        `json:"p"           msgpack:"p"`
	Size       string        `json:"s"           msgpack:"s"`
	ReduceOnly bool          `json:"r"           msgpack:"r"`
	OrderType  OrderWireType `json:"t"           msgpack:"t"`
	Cloid      *string       `json:"c,omitempty" msgpack:"c,omitempty"`
}

// OrderWireType is the wire form of an order type (limit or trigger).
type OrderWireType struct {
	Limit   *OrderWireTypeLimit   `json:"limit,omitempty"   msgpack:"limit,omitempty"`
	Trigger *OrderWireTypeTrigger `json:"trigger,omitempty" msgpack:"trigger,omitempty"`
}

type OrderWireTypeLimit struct {
	Tif Tif `json:"tif" msgpack:"tif"`
}

// OrderWireTypeTrigger is a trigger order (stop-loss/take-profit).
// CRITICAL: field order must be isMarket, triggerPx, tpsl.
type OrderWireTypeTrigger struct {
	IsMarket  bool   `json:"isMarket"  msgpack:"isMarket"`
	TriggerPx string `json:"triggerPx" msgpack:"triggerPx"`
	Tpsl      Tpsl   `json:"tpsl"      msgpack:"tpsl"`
}

// OrderAction is the "order" exchange action.
type OrderAction struct {
	Type     string       `json:"type"              msgpack:"type"`
	Dex      string       `json:"dex,omitempty"     msgpack:"dex,omitempty"`
	Orders   []OrderWire  `json:"orders"            msgpack:"orders"`
	Grouping string       `json:"grouping"          msgpack:"grouping"`
	Builder  *BuilderInfo `json:"builder,omitempty" msgpack:"builder,omitempty"`
}

// CancelOrderWire is a cancel entry keyed by oid.
type CancelOrderWire struct {
	Asset   int   `json:"a" msgpack:"a"`
	OrderID int64 `json:"o" msgpack:"o"`
}

// CancelAction is the "cancel" exchange action.
type CancelAction struct {
	Type    string            `json:"type"          msgpack:"type"`
	Dex     string            `json:"dex,omitempty" msgpack:"dex,omitempty"`
	Cancels []CancelOrderWire `json:"cancels"       msgpack:"cancels"`
}

// CancelByCloidWire is a cancel entry keyed by client order id.
// NB: uses `asset`/`cloid` keys, not the short `a`/`o` of CancelOrderWire.
type CancelByCloidWire struct {
	Asset    int    `json:"asset" msgpack:"asset"`
	ClientID string `json:"cloid" msgpack:"cloid"`
}

// CancelByCloidAction is the "cancelByCloid" exchange action.
type CancelByCloidAction struct {
	Type    string              `json:"type"          msgpack:"type"`
	Dex     string              `json:"dex,omitempty" msgpack:"dex,omitempty"`
	Cancels []CancelByCloidWire `json:"cancels"       msgpack:"cancels"`
}

// ModifyAction is a single entry of a "batchModify" exchange action. Type and
// Dex stay empty inside a batch (omitempty drops them from both encodings).
type ModifyAction struct {
	Type  string    `json:"type,omitempty" msgpack:"type,omitempty"`
	Dex   string    `json:"dex,omitempty"  msgpack:"dex,omitempty"`
	Oid   any       `json:"oid"            msgpack:"oid"`
	Order OrderWire `json:"order"          msgpack:"order"`
}

// BatchModifyAction is the "batchModify" exchange action.
type BatchModifyAction struct {
	Type     string         `json:"type"          msgpack:"type"`
	Dex      string         `json:"dex,omitempty" msgpack:"dex,omitempty"`
	Modifies []ModifyAction `json:"modifies"      msgpack:"modifies"`
}

// ScheduleCancelAction is the "scheduleCancel" (dead-man's-switch) action.
type ScheduleCancelAction struct {
	Type string `json:"type"           msgpack:"type"`
	Time *int64 `json:"time,omitempty" msgpack:"time,omitempty"`
}

// UpdateIsolatedMarginAction is the "updateIsolatedMargin" action.
// Ntli is a signed 6-decimal integer (1 USD = 1_000_000), matching the
// official Python SDK's float_to_usd_int. isBuy is unused until hedge mode
// and must stay true.
type UpdateIsolatedMarginAction struct {
	Type  string `json:"type"  msgpack:"type"`
	Asset int    `json:"asset" msgpack:"asset"`
	IsBuy bool   `json:"isBuy" msgpack:"isBuy"`
	Ntli  int64  `json:"ntli"  msgpack:"ntli"`
}

// UpdateLeverageAction is the "updateLeverage" action.
type UpdateLeverageAction struct {
	Type     string `json:"type"     msgpack:"type"`
	Asset    int    `json:"asset"    msgpack:"asset"`
	IsCross  bool   `json:"isCross"  msgpack:"isCross"`
	Leverage int    `json:"leverage" msgpack:"leverage"`
}

// normalizeCloid validates a 16-byte hex client order id and returns it
// 0x-prefixed, matching the Python SDK's wire format.
func normalizeCloid(cloid string) (string, error) {
	if cloid == "" {
		return "", fmt.Errorf("missing cloid")
	}
	if !strings.HasPrefix(cloid, "0x") {
		cloid = "0x" + cloid
	}
	if len(cloid) != 34 {
		return "", fmt.Errorf("cloid must be exactly 32 hex characters (got %d excluding 0x prefix): %s", len(cloid)-2, cloid)
	}
	if _, err := hex.DecodeString(cloid[2:]); err != nil {
		return "", fmt.Errorf("cloid must be valid hex string: %w", err)
	}
	return cloid, nil
}

// floatToWire converts a float64 to the exchange's wire string format:
// 8-decimal fixed notation with trailing zeros trimmed, rejecting values that
// lose precision at 8 decimals.
func floatToWire(x float64) (string, error) {
	rounded := fmt.Sprintf("%.8f", x)

	parsed, err := strconv.ParseFloat(rounded, 64)
	if err != nil {
		return "", err
	}
	if math.Abs(parsed-x) >= 1e-12 {
		return "", fmt.Errorf("float_to_wire causes rounding: %f", x)
	}

	if rounded == "-0.00000000" {
		rounded = "0.00000000"
	}

	result := strings.TrimRight(rounded, "0")
	result = strings.TrimRight(result, ".")
	return result, nil
}

// slippagePrice applies market-order slippage to a reference price, then uses
// the same Hyperliquid perp precision rule as limit/trigger/HIP-3 paths
// (normalizePerpPrice: 5 significant figures, at most 6-szDecimals places,
// integer prices preserved). A previous SDK-style floor path diverged from
// normalizePerpPrice on half-values at five-digit prices.
func slippagePrice(px float64, isBuy bool, slippage float64, szDecimals int) float64 {
	if isBuy {
		px *= 1 + slippage
	} else {
		px *= 1 - slippage
	}
	return normalizePerpPrice(px, szDecimals)
}

// usdToNtli converts a USD margin delta to Hyperliquid's 6-decimal integer.
// Negative values remove isolated margin. Matches the official SDK.
func usdToNtli(usd float64) (int64, error) {
	if math.IsNaN(usd) || math.IsInf(usd, 0) {
		return 0, fmt.Errorf("isolated margin amount is not finite")
	}
	scaled := usd * 1e6
	rounded := math.Round(scaled)
	if math.Abs(rounded-scaled) >= 1e-3 {
		return 0, fmt.Errorf("isolated margin amount %v is not representable at 6 decimals", usd)
	}
	return int64(rounded), nil
}
