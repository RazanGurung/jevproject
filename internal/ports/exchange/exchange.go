package exchange

import (
	"context"

	"hyperliquid-go/internal/domain/models"
)

type BuilderDexState struct {
	Dex       string        `json:"dex"`
	Positions []interface{} `json:"assetPositions"`
	Orders    []interface{} `json:"orders,omitempty"`
}

type Exchange interface {
	// Orders
	PlaceOrder(ctx context.Context, req models.OrderRequest) (interface{}, error)
	PlaceBulkOrders(ctx context.Context, orders []models.OrderRequest) ([]interface{}, error)
	CancelOrder(ctx context.Context, address, coin string, oid int64, testnet bool) error
	BulkCancelOrders(ctx context.Context, address string, cancels []models.CancelEntry, testnet bool) ([]int64, error)
	CancelByCloid(ctx context.Context, address, coin, cloid string, testnet bool) error
	ModifyOrder(ctx context.Context, req models.ModifyOrderRequest) (int64, error)
	BulkModifyOrders(ctx context.Context, privateKey string, modifies []models.ModifyOrderRequestItem, mainnet bool) ([]int64, error)
	PlaceTriggerOrder(ctx context.Context, req models.TriggerOrderRequest) error
	// PlaceTriggerOrders submits one or more reduce-only triggers. Two legs
	// are grouped as positionTpsl. The returned slice is per-request: a nil
	// entry means that leg was accepted even if a sibling failed.
	PlaceTriggerOrders(ctx context.Context, reqs []models.TriggerOrderRequest) []error
	PlaceTwapOrder(ctx context.Context, req models.TwapOrderRequest) (interface{}, error)
	CancelTwapOrder(ctx context.Context, req models.TwapCancelRequest) (interface{}, error)
	ScheduleCancel(ctx context.Context, address string, time *int64, testnet bool) error

	// Positions
	ClosePosition(ctx context.Context, privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error)
	SetLeverage(ctx context.Context, privateKey, address, coin string, leverage int, isCross, testnet bool) error
	UpdateIsolatedMargin(ctx context.Context, privateKey, address, coin string, ntli float64, testnet bool) error

	// Account
	GetAccount(ctx context.Context, address string) (map[string]interface{}, error)
	GetFills(ctx context.Context, address string, startTime int64) ([]interface{}, error)
	GetOpenOrders(ctx context.Context, address string) ([]interface{}, error)
	// Builder dex account state (positions always; orders when includeOrders).
	// Prefer this over any dex-specific helper — xyz is just one builder dex.
	GetBuilderDexes(ctx context.Context) ([]string, error)
	GetBuilderDexState(ctx context.Context, address, dex string, includeOrders bool) (BuilderDexState, error)
	GetActiveAssetData(ctx context.Context, address, coin string) (map[string]interface{}, error)
	GetAssetCtxs(ctx context.Context, dex string) ([]interface{}, error)

	// Market Data
	GetMidPrice(ctx context.Context, coin string, testnet bool) (float64, error)
	GetL2Snapshot(ctx context.Context, coin string, depth int, testnet bool) (interface{}, error)

	// Utility
	GetAddressFromPrivateKey(ctx context.Context, pk string) (string, error)
	CheckWalletExistsOnExchange(ctx context.Context, privateKey string, testnet bool) (bool, string, error)
	WarmUpForKey(ctx context.Context, privateKey string, testnet bool)
}
