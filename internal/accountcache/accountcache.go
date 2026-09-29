package accountcache

import (
	"os"
	"regexp"
	"strings"
	"sync"
)

var (
	cachedAccountAddress string
	mu                   sync.RWMutex
)

var accountAddressRegex = regexp.MustCompile(`^0x[a-fA-F0-9]{40}$`)

func normalizeAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	if accountAddressRegex.MatchString(addr) {
		return strings.ToLower(addr)
	}
	return ""
}

func Cache(addr string) {
	addr = normalizeAddress(addr)
	mu.Lock()
	cachedAccountAddress = addr
	mu.Unlock()
}

func Get() string {
	mu.RLock()
	defer mu.RUnlock()
	return cachedAccountAddress
}

func GetWithFallback() string {
	if addr := Get(); addr != "" {
		return addr
	}

	addr := os.Getenv("PEZ_ACCOUNT_ADDRESS")
	if addr == "" {
		addr = os.Getenv("ACCOUNT_ADDRESS")
	}
	if addr == "" {
		if data, err := os.ReadFile("hyperliquid_account.txt"); err == nil {
			addr = string(data)
		}
	}

	return normalizeAddress(addr)
}

func Clear() {
	mu.Lock()
	cachedAccountAddress = ""
	mu.Unlock()
}
