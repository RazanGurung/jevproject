package keycache

import (
	"crypto/ecdsa"
	"os"
	"sync"

	"github.com/ethereum/go-ethereum/crypto"
)

var (
	cachedPrivateKey string
	cachedECDSAKey   *ecdsa.PrivateKey
	mu               sync.RWMutex
)

func normalizeKey(pk string) string {
	if len(pk) == 66 && pk[:2] == "0x" {
		return pk[2:]
	}
	return pk
}

// Cache caches a private key and pre-parses its ECDSA key.
func Cache(pk string) {
	pk = normalizeKey(pk)
	if len(pk) < 64 {
		return
	}
	ecdsaKey, _ := crypto.HexToECDSA(pk)
	mu.Lock()
	cachedPrivateKey = pk
	cachedECDSAKey = ecdsaKey
	mu.Unlock()
}

// Get returns the cached private key.
func Get() string {
	mu.RLock()
	defer mu.RUnlock()
	return cachedPrivateKey
}

// GetECDSA returns the cached pre-parsed ECDSA private key, or nil if not cached.
func GetECDSA() *ecdsa.PrivateKey {
	mu.RLock()
	defer mu.RUnlock()
	return cachedECDSAKey
}

// GetWithFallback returns cached key, or reads from env/file.
func GetWithFallback() string {
	// Try cached first
	if pk := Get(); len(pk) >= 64 {
		return pk
	}

	// Try environment variables
	pk := os.Getenv("PEZ_PRIVATE_KEY")
	if pk == "" {
		pk = os.Getenv("PRIVATE_KEY")
	}

	// Try file
	if pk == "" {
		if data, err := os.ReadFile("hyperliquid_key.txt"); err == nil {
			pk = string(data)
		}
	}

	// Normalize
	pk = normalizeKey(pk)
	if len(pk) >= 64 {
		return pk
	}

	return ""
}

// GetWithFallbackECDSA returns the cached pre-parsed ECDSA key, or parses from env/file.
func GetWithFallbackECDSA() *ecdsa.PrivateKey {
	mu.RLock()
	if cachedECDSAKey != nil {
		defer mu.RUnlock()
		return cachedECDSAKey
	}
	mu.RUnlock()

	pk := GetWithFallback()
	if pk == "" {
		return nil
	}
	ecdsaKey, err := crypto.HexToECDSA(pk)
	if err != nil {
		return nil
	}
	mu.Lock()
	if cachedPrivateKey == pk || cachedPrivateKey == "" {
		cachedPrivateKey = pk
		cachedECDSAKey = ecdsaKey
	}
	mu.Unlock()
	return ecdsaKey
}

// Clear removes the in-memory cached private key and parsed ECDSA key.
func Clear() {
	mu.Lock()
	cachedPrivateKey = ""
	cachedECDSAKey = nil
	mu.Unlock()
}

