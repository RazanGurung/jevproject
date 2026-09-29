package websocket

import (
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

func (m *WebSocketManager) StartHeartbeat() {
	go func() {
		defer close(m.HeartbeatDone)

		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-m.MarketStopCh:
				return
			case <-ticker.C:
				hb := fmt.Sprintf(`{"type":"heartbeat","time":"%s"}`, time.Now().Format(time.RFC3339))
				m.broadcastHeartbeat([]byte(hb))
				if debugLogsEnabled() {
					log.Printf("stream heartbeat sent (clients=%d)", m.StreamClientCount())
				}
			}
		}
	}()
}

func (m *WebSocketManager) broadcastHeartbeat(data []byte) {
	m.StreamMu.RLock()
	clients := make([]*streamClient, 0, len(m.streamClients))
	for client := range m.streamClients {
		clients = append(clients, client)
	}
	m.StreamMu.RUnlock()
	for _, client := range clients {
		m.sendRawToClient(client, data)
	}
}

func (m *WebSocketManager) StreamClientCount() int {
	m.StreamMu.RLock()
	defer m.StreamMu.RUnlock()
	return len(m.streamClients)
}

func (m *WebSocketManager) TradingClientCount() int {
	m.StreamMu.RLock()
	defer m.StreamMu.RUnlock()
	count := 0
	for client := range m.streamClients {
		if client.kind.acceptsTrading() {
			count++
		}
	}
	return count
}

func (m *WebSocketManager) IsMarketConnected() bool {
	m.MarketWsMu.RLock()
	defer m.MarketWsMu.RUnlock()
	return m.MarketWsConn != nil
}

func (m *WebSocketManager) SetUserSession(pk, accountAddr string) {
	if len(pk) >= 64 {
		pkClean := pk
		if len(pkClean) == 66 && pkClean[:2] == "0x" {
			pkClean = pkClean[2:]
		}
		signerAddr := ""
		if keyBytes, err := hex.DecodeString(pkClean); err == nil {
			if ecdsaKey, err := crypto.ToECDSA(keyBytes); err == nil {
				signerAddr = crypto.PubkeyToAddress(ecdsaKey.PublicKey).Hex()
			}
		}
		if accountAddr == "" {
			accountAddr = signerAddr
		}
		m.UserWsMu.Lock()
		sameSession := m.UserWsKey == pkClean && m.UserAccountAddr == accountAddr
		hasLiveConn := m.UserWsConn != nil
		if sameSession && hasLiveConn {
			m.UserSignerAddr = signerAddr
			m.UserAddr = accountAddr
			m.UserAccountAddr = accountAddr
			m.UserWsMu.Unlock()
			return
		}
		m.UserWsKey = pkClean
		m.UserSignerAddr = signerAddr
		m.UserAddr = accountAddr
		m.UserAccountAddr = accountAddr
		if m.UserWsConn != nil {
			_ = m.UserWsConn.Close()
			m.UserWsConn = nil
		}
		m.UserWsMu.Unlock()
		m.TriggerUserWebSocket()
	}
}

func (m *WebSocketManager) ClearUserSession() {
	m.UserWsMu.Lock()
	if m.UserWsConn != nil {
		_ = m.UserWsConn.Close()
		m.UserWsConn = nil
	}
	m.UserWsKey = ""
	m.UserAddr = ""
	m.UserAccountAddr = ""
	m.UserSignerAddr = ""
	m.UserWsMu.Unlock()
}

func shortAddr(addr string) string {
	if len(addr) > 10 {
		return addr[:10] + "..."
	}
	return addr
}

func (m *WebSocketManager) hasUserSession() bool {
	m.UserWsMu.Lock()
	defer m.UserWsMu.Unlock()
	return len(m.UserWsKey) >= 64
}

func normalizeAccountAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	if len(addr) == 42 && strings.HasPrefix(strings.ToLower(addr), "0x") {
		return strings.ToLower(addr)
	}
	return ""
}

func debugLogsEnabled() bool {
	switch os.Getenv("PEZ_DEBUG_LOGS") {
	case "1", "true", "TRUE", "yes", "YES", "on", "ON":
		return true
	default:
		return false
	}
}

func (m *WebSocketManager) GetBBOCache() map[string]BBOCache {
	m.BBOCacheMu.RLock()
	defer m.BBOCacheMu.RUnlock()
	result := make(map[string]BBOCache, len(m.BBOCache))
	for k, v := range m.BBOCache {
		result[k] = v
	}
	return result
}
