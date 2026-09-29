package websocket

import (
	"hyperliquid-go/internal/services"
	"time"
)

// BroadcastNews sends low-volume read-only news events over the market lane.
// Each client receives global events plus events for its active/background
// market subscription; account and trading clients never receive them.
func (m *WebSocketManager) BroadcastNews(items []*services.MarketNewsItem) {
	if len(items) == 0 {
		return
	}
	m.StreamMu.RLock()
	clients := make([]*streamClient, 0, len(m.streamClients))
	for client := range m.streamClients {
		if client.kind.acceptsMarket() {
			clients = append(clients, client)
		}
	}
	m.StreamMu.RUnlock()

	for _, client := range clients {
		filtered := filterNewsForClient(client, items)
		if len(filtered) == 0 {
			continue
		}
		m.sendToClient(client, map[string]interface{}{
			"channel": "news",
			"data": map[string]interface{}{
				"items":    filtered,
				"asOf":     time.Now().UTC(),
				"snapshot": false,
			},
		})
	}
}

func filterNewsForClient(client *streamClient, items []*services.MarketNewsItem) []*services.MarketNewsItem {
	if client == nil {
		return nil
	}
	client.mu.Lock()
	active := client.market.Coin
	tradeCoins := client.market.TradeCoins
	client.mu.Unlock()

	out := make([]*services.MarketNewsItem, 0, len(items))
	for _, item := range items {
		if item == nil {
			continue
		}
		if item.Scope == "global" || len(item.Coins) == 0 {
			out = append(out, item)
			continue
		}
		for _, coin := range item.Coins {
			if coin == active || tradeCoins[coin] {
				out = append(out, item)
				break
			}
		}
	}
	return out
}
