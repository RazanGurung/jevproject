package models

import "time"

// JournalEntry represents an immutable execution audit record capturing order
// lifecycle events, pre-trade snapshots, execution latency, and slippage metrics.
type JournalEntry struct {
	ID                  string    `json:"id"`
	Timestamp           time.Time `json:"timestamp"`
	Action              string    `json:"action"` // "PLACE_ORDER", "CANCEL_ORDER", "CANCEL_BY_CLOID", "BULK_PLACE", "MODIFY_ORDER", "POSITION_CLOSE", "FILL_JEV_TICKET"
	Coin                string    `json:"coin"`
	Side                string    `json:"side,omitempty"`      // "BUY", "SELL"
	Sz                  float64   `json:"sz,omitempty"`
	LimitPx             float64   `json:"limitPx,omitempty"`
	OrderType           string    `json:"orderType,omitempty"` // "LIMIT", "MARKET", "STOP", "TP"
	Tif                 string    `json:"tif,omitempty"`       // "Gtc", "Ioc", "Alo"
	ReduceOnly          bool      `json:"reduceOnly,omitempty"`
	Cloid               string    `json:"cloid,omitempty"`
	Oid                 int64     `json:"oid,omitempty"`
	PreTradeMid         float64   `json:"preTradeMid,omitempty"`
	RealizedSlippageBps float64   `json:"realizedSlippageBps,omitempty"`
	LatencyMs           int64     `json:"latencyMs"`
	Success             bool      `json:"success"`
	Status              string    `json:"status"` // "accepted", "filled", "resting", "cancelled", "rejected", "error"
	ErrorMessage        string    `json:"errorMessage,omitempty"`
	Source              string    `json:"source,omitempty"`
	ClientIP            string    `json:"clientIp,omitempty"`
}

// JournalSummary provides aggregated execution analytics for post-trade review.
type JournalSummary struct {
	TotalEntries   int       `json:"totalEntries"`
	TotalOrders    int       `json:"totalOrders"`
	TotalCancels   int       `json:"totalCancels"`
	TotalVolumeUsd float64   `json:"totalVolumeUsd"`
	SuccessRatePct float64   `json:"successRatePct"`
	AvgLatencyMs   float64   `json:"avgLatencyMs"`
	AvgSlippageBps float64   `json:"avgSlippageBps"`
	LastRecordedAt time.Time `json:"lastRecordedAt,omitempty"`
}
