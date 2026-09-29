package testutil

import (
	"context"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/ports/cache"
	"hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/internal/ports/streaming"
)

type MockPriceCache struct {
	data map[string]cache.PriceCacheEntry
}

func NewMockPriceCache() *MockPriceCache {
	return &MockPriceCache{data: make(map[string]cache.PriceCacheEntry)}
}

func (m *MockPriceCache) Get(coin string) (cache.PriceCacheEntry, bool) {
	entry, ok := m.data[coin]
	return entry, ok
}

func (m *MockPriceCache) Set(coin string, entry cache.PriceCacheEntry) {
	m.data[coin] = entry
}

func (m *MockPriceCache) GetAll() map[string]cache.PriceCacheEntry {
	return m.data
}

func (m *MockPriceCache) Delete(coin string) {
	delete(m.data, coin)
}

type MockMetadataCache struct {
	decimals    map[string]int
	tickSize    map[string]float64
	maxLeverage map[string]int
}

func NewMockMetadataCache() *MockMetadataCache {
	return &MockMetadataCache{
		decimals:    make(map[string]int),
		tickSize:    make(map[string]float64),
		maxLeverage: make(map[string]int),
	}
}

func (m *MockMetadataCache) GetDecimals(coin string) int {
	return m.decimals[coin]
}

func (m *MockMetadataCache) Has(coin string) bool {
	_, ok := m.decimals[coin]
	return ok
}

func (m *MockMetadataCache) GetTickSize(coin string) float64 {
	return m.tickSize[coin]
}

func (m *MockMetadataCache) GetMaxLeverage(coin string) int {
	return m.maxLeverage[coin]
}

func (m *MockMetadataCache) SetDecimals(coin string, decimals int) {
	m.decimals[coin] = decimals
}

func (m *MockMetadataCache) SetTickSize(coin string, size float64) {
	m.tickSize[coin] = size
}

func (m *MockMetadataCache) SetMaxLeverage(coin string, lev int) {
	m.maxLeverage[coin] = lev
}

type MockPublisher struct {
	Events []streaming.Event
}

func NewMockPublisher() *MockPublisher {
	return &MockPublisher{Events: make([]streaming.Event, 0)}
}

func (m *MockPublisher) Publish(event streaming.Event) {
	m.Events = append(m.Events, event)
}

func (m *MockPublisher) Subscribe() <-chan streaming.Event {
	ch := make(chan streaming.Event, 10)
	return ch
}

type MockExchange struct {
	PlaceOrderFunc         func(req models.OrderRequest) (interface{}, error)
	PlaceBulkOrdersFunc    func(orders []models.OrderRequest) ([]interface{}, error)
	PlaceTriggerOrderFunc  func(req models.TriggerOrderRequest) error
	PlaceTriggerOrdersFunc func(reqs []models.TriggerOrderRequest) []error
	CancelOrderFunc        func(address, coin string, oid int64, testnet bool) error
	BulkCancelOrdersFunc   func(address string, cancels []models.CancelEntry, testnet bool) ([]int64, error)
	ModifyOrderFunc        func(req models.ModifyOrderRequest) (int64, error)
	BulkModifyOrdersFunc   func(modifies []models.ModifyOrderRequestItem) ([]int64, error)
	GetBuilderDexStateFunc func(address, dex string, includeOrders bool) (exchange.BuilderDexState, error)
	ClosePositionFunc      func(privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error)
	GetAccountFunc         func(address string) (map[string]interface{}, error)
	GetActiveAssetDataFunc func(address, coin string) (map[string]interface{}, error)
	GetAssetCtxsFunc       func(dex string) ([]interface{}, error)
	GetMidPriceFunc        func(coin string, testnet bool) (float64, error)
}

func NewMockExchange() *MockExchange {
	return &MockExchange{}
}

func (m *MockExchange) PlaceOrder(ctx context.Context, req models.OrderRequest) (interface{}, error) {
	if m.PlaceOrderFunc != nil {
		return m.PlaceOrderFunc(req)
	}
	return nil, nil
}

func (m *MockExchange) PlaceBulkOrders(ctx context.Context, orders []models.OrderRequest) ([]interface{}, error) {
	if m.PlaceBulkOrdersFunc != nil {
		return m.PlaceBulkOrdersFunc(orders)
	}
	return nil, nil
}

func (m *MockExchange) CancelOrder(ctx context.Context, address, coin string, oid int64, testnet bool) error {
	if m.CancelOrderFunc != nil {
		return m.CancelOrderFunc(address, coin, oid, testnet)
	}
	return nil
}

func (m *MockExchange) BulkCancelOrders(ctx context.Context, address string, cancels []models.CancelEntry, testnet bool) ([]int64, error) {
	if m.BulkCancelOrdersFunc != nil {
		return m.BulkCancelOrdersFunc(address, cancels, testnet)
	}
	oids := make([]int64, 0, len(cancels))
	for _, c := range cancels {
		oids = append(oids, c.Oid)
	}
	return oids, nil
}

func (m *MockExchange) GetAccount(ctx context.Context, address string) (map[string]interface{}, error) {
	if m.GetAccountFunc != nil {
		return m.GetAccountFunc(address)
	}
	return nil, nil
}

func (m *MockExchange) GetBuilderDexes(ctx context.Context) ([]string, error) {
	return []string{"xyz"}, nil
}

func (m *MockExchange) GetBuilderDexState(ctx context.Context, address, dex string, includeOrders bool) (exchange.BuilderDexState, error) {
	if m.GetBuilderDexStateFunc != nil {
		return m.GetBuilderDexStateFunc(address, dex, includeOrders)
	}
	return exchange.BuilderDexState{Dex: dex}, nil
}

// Implement remaining interface methods as no-ops
func (m *MockExchange) CancelByCloid(ctx context.Context, address, coin, cloid string, testnet bool) error {
	return nil
}
func (m *MockExchange) ModifyOrder(ctx context.Context, req models.ModifyOrderRequest) (int64, error) {
	if m.ModifyOrderFunc != nil {
		return m.ModifyOrderFunc(req)
	}
	return 0, nil
}
func (m *MockExchange) BulkModifyOrders(ctx context.Context, privateKey string, modifies []models.ModifyOrderRequestItem, mainnet bool) ([]int64, error) {
	if m.BulkModifyOrdersFunc != nil {
		return m.BulkModifyOrdersFunc(modifies)
	}
	return make([]int64, len(modifies)), nil
}
func (m *MockExchange) PlaceTriggerOrder(ctx context.Context, req models.TriggerOrderRequest) error {
	if m.PlaceTriggerOrderFunc != nil {
		return m.PlaceTriggerOrderFunc(req)
	}
	return nil
}
func (m *MockExchange) PlaceTriggerOrders(ctx context.Context, reqs []models.TriggerOrderRequest) []error {
	if m.PlaceTriggerOrdersFunc != nil {
		return m.PlaceTriggerOrdersFunc(reqs)
	}
	out := make([]error, len(reqs))
	for i, req := range reqs {
		out[i] = m.PlaceTriggerOrder(ctx, req)
	}
	return out
}
func (m *MockExchange) PlaceTwapOrder(ctx context.Context, req models.TwapOrderRequest) (interface{}, error) {
	return nil, nil
}
func (m *MockExchange) CancelTwapOrder(ctx context.Context, req models.TwapCancelRequest) (interface{}, error) {
	return nil, nil
}
func (m *MockExchange) ScheduleCancel(ctx context.Context, address string, time *int64, testnet bool) error {
	return nil
}
func (m *MockExchange) ClosePosition(ctx context.Context, privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error) {
	if m.ClosePositionFunc != nil {
		return m.ClosePositionFunc(privateKey, address, coin, fraction, positionSize, positionSzi, testnet)
	}
	return models.ClosePositionResult{Status: "ok"}, nil
}
func (m *MockExchange) SetLeverage(ctx context.Context, privateKey, address, coin string, leverage int, isCross, testnet bool) error {
	return nil
}
func (m *MockExchange) UpdateIsolatedMargin(ctx context.Context, privateKey, address, coin string, ntli float64, testnet bool) error {
	return nil
}
func (m *MockExchange) GetFills(ctx context.Context, address string, startTime int64) ([]interface{}, error) {
	return nil, nil
}
func (m *MockExchange) GetOpenOrders(ctx context.Context, address string) ([]interface{}, error) {
	return nil, nil
}
func (m *MockExchange) GetActiveAssetData(ctx context.Context, address, coin string) (map[string]interface{}, error) {
	if m.GetActiveAssetDataFunc != nil {
		return m.GetActiveAssetDataFunc(address, coin)
	}
	return nil, nil
}
func (m *MockExchange) GetAssetCtxs(ctx context.Context, dex string) ([]interface{}, error) {
	if m.GetAssetCtxsFunc != nil {
		return m.GetAssetCtxsFunc(dex)
	}
	return nil, nil
}
func (m *MockExchange) GetMidPrice(ctx context.Context, coin string, testnet bool) (float64, error) {
	if m.GetMidPriceFunc != nil {
		return m.GetMidPriceFunc(coin, testnet)
	}
	return 0, nil
}
func (m *MockExchange) GetL2Snapshot(ctx context.Context, coin string, depth int, testnet bool) (interface{}, error) {
	return nil, nil
}
func (m *MockExchange) GetAddressFromPrivateKey(ctx context.Context, pk string) (string, error) {
	return "0x0000000000000000000000000000000000000000", nil
}
func (m *MockExchange) CheckWalletExistsOnExchange(ctx context.Context, privateKey string, testnet bool) (bool, string, error) {
	return true, "0x0000000000000000000000000000000000000000", nil
}

func (m *MockExchange) WarmUpForKey(ctx context.Context, privateKey string, testnet bool) {}
