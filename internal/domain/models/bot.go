package models

import "time"

type BotConfig struct {
	OrdersPerSide int     `json:"ordersPerSide"`
	OrderSize     float64 `json:"orderSize"`
	BidSkew       float64 `json:"bidSkew"`
	AskSkew       float64 `json:"askSkew"`
	BulkMode      bool    `json:"bulkMode"`
}

type BotStartRequest struct {
	Strategy string    `json:"strategy"`
	Coin     string    `json:"coin"`
	Config   BotConfig `json:"config"`
}

type BotLogEntry struct {
	Seq     int64     `json:"seq"`
	Time    time.Time `json:"time"`
	Type    string    `json:"type"`
	Message string    `json:"message"`
}

type BotStatus struct {
	Running   bool          `json:"running"`
	Strategy  string        `json:"strategy,omitempty"`
	Coin      string        `json:"coin,omitempty"`
	Account   string        `json:"account,omitempty"`
	Config    BotConfig     `json:"config"`
	StartedAt *time.Time    `json:"startedAt,omitempty"`
	UpdatedAt *time.Time    `json:"updatedAt,omitempty"`
	LastRunAt *time.Time    `json:"lastRunAt,omitempty"`
	LastPrice float64       `json:"lastPrice,omitempty"`
	VWAP      float64       `json:"vwap,omitempty"`
	StdDev    float64       `json:"stdDev,omitempty"`
	OrderIDs  []int64       `json:"orderIds,omitempty"`
	LastError string        `json:"lastError,omitempty"`
	Logs      []BotLogEntry `json:"logs,omitempty"`
}
