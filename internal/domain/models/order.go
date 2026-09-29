package models

// CanonicalOrderResult is the normalized envelope returned by all single-order endpoints.
// It replaces the variable-depth nesting that previously required the frontend to probe
// multiple paths (response.response.response.filled etc.).
type CanonicalOrderResult struct {
	Accepted bool  `json:"accepted"`
	Oid      int64 `json:"oid,omitempty"`
	// Cloid is the 128-bit client order id submitted on the wire (caller-supplied
	// or auto-generated). Present on accepted place/bulk results so clients can
	// reconcile or cancel-by-cloid without guessing the id.
	Cloid  string      `json:"cloid,omitempty"`
	Filled interface{} `json:"filled,omitempty"`
	Error  string      `json:"error,omitempty"`
	// Ambiguous is true when the exchange round-trip failed in a way that
	// cannot prove the action was rejected. Clients must not retry with a
	// new cloid; poll order status instead.
	Ambiguous bool  `json:"ambiguous,omitempty"`
	LatencyMs int64 `json:"latencyMs"`
}

// ClosePositionResult is the envelope for IOC position closes. Market closes
// can fill only part of the requested size when the ±1% slippage bound is hit;
// residual fields make that shortfall observable instead of a silent full-ok.
type ClosePositionResult struct {
	Status          string  `json:"status"`
	RequestedSzCoin float64 `json:"requestedSzCoin,omitempty"`
	FilledSzCoin    float64 `json:"filledSzCoin,omitempty"`
	AvgPx           float64 `json:"avgPx,omitempty"`
	ResidualSzCoin  float64 `json:"residualSzCoin,omitempty"`
	Partial         bool    `json:"partial,omitempty"`
	Cloid           string  `json:"cloid,omitempty"`
	Error           string  `json:"error,omitempty"`
}

// CanonicalBulkOrderResult is the normalized envelope for bulk order endpoints.
type CanonicalBulkOrderResult struct {
	Statuses []CanonicalOrderResult `json:"statuses"`
	Error    string                 `json:"error,omitempty"`
	// Ambiguous is true when the whole batch round-trip failed in a way that
	// cannot prove the venue rejected every order. Clients must not mint new
	// cloids and retry.
	Ambiguous bool  `json:"ambiguous,omitempty"`
	LatencyMs int64 `json:"latencyMs"`
}

type OrderRequest struct {
	PrivateKey   string  `json:"privateKey"`
	Cloid        string  `json:"cloid,omitempty"`
	Coin         string  `json:"coin"`
	IsBuy        bool    `json:"isBuy"`
	Sz           float64 `json:"sz"`
	LimitPx      float64 `json:"limitPx,omitempty"`
	ReduceOnly   bool    `json:"reduceOnly,omitempty"`
	PostOnly     bool    `json:"postOnly,omitempty"`
	Tif          string  `json:"tif,omitempty"`
	Testnet      bool    `json:"testnet"`
	Mainnet      bool    `json:"mainnet"`
	TpPct        float64 `json:"tpPct,omitempty"`
	SlPct        float64 `json:"slPct,omitempty"`
	ExpiresAfter int64   `json:"expiresAfter,omitempty"`
}

type OrderResponse struct {
	Status    string      `json:"status"`
	Response  interface{} `json:"response,omitempty"`
	Error     string      `json:"error,omitempty"`
	LatencyMs int64       `json:"latencyMs"`
}

type BulkOrderRequest struct {
	PrivateKey string         `json:"privateKey"`
	Orders     []OrderRequest `json:"orders"`
	Testnet    bool           `json:"testnet"`
	Mainnet    bool           `json:"mainnet"`
}

type ScalePreviewRequest struct {
	Coin       string  `json:"coin"`
	IsBuy      bool    `json:"isBuy"`
	TotalUsd   float64 `json:"totalUsd"`
	NumOrders  int     `json:"numOrders"`
	LowPx      float64 `json:"lowPx"`
	HighPx     float64 `json:"highPx"`
	ReduceOnly bool    `json:"reduceOnly"`
	Mainnet    bool    `json:"mainnet"`
	Testnet    bool    `json:"testnet"`
}

type ScalePreviewResponse struct {
	Orders []OrderRequest `json:"orders"`
}

type ModifyOrderRequest struct {
	PrivateKey string  `json:"privateKey"`
	Coin       string  `json:"coin"`
	Oid        int64   `json:"oid"`
	IsBuy      bool    `json:"isBuy"`
	Sz         float64 `json:"sz"`
	LimitPx    float64 `json:"limitPx"`
	ReduceOnly bool    `json:"reduceOnly"`
	// Trigger fields: when Tpsl is "tp" or "sl" the order is re-wired as a
	// trigger order at TriggerPx instead of a GTC limit at LimitPx.
	TriggerPx float64 `json:"triggerPx,omitempty"`
	IsMarket  bool    `json:"isMarket,omitempty"`
	Tpsl      string  `json:"tpsl,omitempty"`
	Mainnet   bool    `json:"mainnet"`
	Testnet   bool    `json:"testnet"`
}

type ModifyOrderRequestItem struct {
	Oid        int64   `json:"oid"`
	Coin       string  `json:"coin"`
	IsBuy      bool    `json:"isBuy"`
	Sz         float64 `json:"sz"`
	LimitPx    float64 `json:"limitPx"`
	ReduceOnly bool    `json:"reduceOnly"`
	TriggerPx  float64 `json:"triggerPx,omitempty"`
	IsMarket   bool    `json:"isMarket,omitempty"`
	Tpsl       string  `json:"tpsl,omitempty"`
}

type BulkModifyOrderRequest struct {
	PrivateKey string                   `json:"privateKey"`
	Modifies   []ModifyOrderRequestItem `json:"modifies"`
	Mainnet    bool                     `json:"mainnet"`
}

type TwapOrderRequest struct {
	PrivateKey string  `json:"privateKey"`
	Coin       string  `json:"coin"`
	IsBuy      bool    `json:"isBuy"`
	Sz         float64 `json:"sz"`
	LimitPx    float64 `json:"limitPx"`
	Minutes    int     `json:"minutes"`
	Randomize  bool    `json:"randomize"`
	ReduceOnly bool    `json:"reduceOnly"`
	Testnet    bool    `json:"testnet"`
	Mainnet    bool    `json:"mainnet"`
}

type TwapCancelRequest struct {
	PrivateKey string `json:"privateKey"`
	Coin       string `json:"coin,omitempty"`
	TwapID     int64  `json:"twapId"`
	Testnet    bool   `json:"testnet"`
	Mainnet    bool   `json:"mainnet"`
}

type TriggerOrderRequest struct {
	PrivateKey string  `json:"privateKey"`
	Cloid      string  `json:"cloid,omitempty"`
	Coin       string  `json:"coin"`
	IsBuy      bool    `json:"isBuy"`
	Sz         float64 `json:"sz"`
	// SzCoin bypasses notional-to-size conversion when the exact position/fill
	// size is known. Entry-attached protection and the position-panel TP/SL
	// controls use it; Sz remains for backward-compatible notional callers.
	SzCoin    float64 `json:"szCoin,omitempty"`
	TriggerPx float64 `json:"triggerPx"`
	IsMarket  bool    `json:"isMarket"`
	Tpsl      string  `json:"tpsl"`
	Testnet   bool    `json:"testnet"`
	Mainnet   bool    `json:"mainnet"`
}

type CancelRequest struct {
	PrivateKey string `json:"privateKey"`
	Coin       string `json:"coin"`
	Testnet    bool   `json:"testnet"`
}

type CancelOneRequest struct {
	PrivateKey string `json:"privateKey"`
	Coin       string `json:"coin"`
	Oid        int64  `json:"oid"`
	Testnet    bool   `json:"testnet"`
}

type CancelByCloidRequest struct {
	PrivateKey string `json:"privateKey"`
	Coin       string `json:"coin"`
	Cloid      string `json:"cloid"`
	Testnet    bool   `json:"testnet"`
	Mainnet    bool   `json:"mainnet"`
}

type ClosePositionRequest struct {
	PrivateKey   string  `json:"privateKey"`
	Address      string  `json:"address"`
	Coin         string  `json:"coin"`
	Fraction     float64 `json:"fraction"`
	PositionSize float64 `json:"positionSize"`
	// PositionSzi is the signed live position size already rendered by the
	// frontend. It avoids another clearinghouse lookup on the close hot path.
	PositionSzi float64 `json:"positionSzi,omitempty"`
	Testnet     bool    `json:"testnet"`
	Mainnet     bool    `json:"mainnet"`
}

type SetLeverageRequest struct {
	PrivateKey string `json:"privateKey"`
	Coin       string `json:"coin"`
	Leverage   int    `json:"leverage"`
	// IsCross follows Hyperliquid's updateLeverage flag. Omit to let the
	// backend infer from the coin (builder/HIP-3 isolated-only → false).
	IsCross *bool `json:"isCross,omitempty"`
	Testnet bool  `json:"testnet"`
	Mainnet bool  `json:"mainnet"`
}

type UpdateIsolatedMarginRequest struct {
	PrivateKey string  `json:"privateKey"`
	Coin       string  `json:"coin"`
	IsBuy      bool    `json:"isBuy"`
	Ntli       float64 `json:"ntli"`
	Testnet    bool    `json:"testnet"`
	Mainnet    bool    `json:"mainnet"`
}

type ScheduleCancelRequest struct {
	PrivateKey string `json:"privateKey"`
	Time       *int64 `json:"time,omitempty"`
	Testnet    bool   `json:"testnet"`
	Mainnet    bool   `json:"mainnet"`
}

type CancelEntry struct {
	Coin string
	Oid  int64
}

type BulkCancelRequest struct {
	PrivateKey string                   `json:"privateKey"`
	Cancels    []map[string]interface{} `json:"cancels"`
	Testnet    bool                     `json:"testnet"`
	Mainnet    bool                     `json:"mainnet"`
}
