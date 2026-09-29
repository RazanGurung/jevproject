package main

// Session key/address helpers and color palette template routes.

import (
	"log"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"hyperliquid-go/internal/accountcache"
	"hyperliquid-go/internal/keycache"
	"hyperliquid-go/internal/preferences"
	"github.com/gin-gonic/gin"
)


func preloadKeyOnStartup() {
	pk := keycache.GetWithFallback()
	if len(pk) >= 64 && runtime.wsManager != nil {
		log.Printf("KEY: pre-loaded from environment/file, initializing user WebSocket")
		runtime.wsManager.SetUserSession(pk, loadAccountAddress())
	}
}

// colorPaletteTemplatesPath is the durable on-disk store for the four Colors
// popover templates. It lives under data/ so browser cache clears cannot wipe it.
const colorPaletteTemplatesPath = "data/color-palette-templates.json"

// =============================================================================
// COLOR PALETTE TEMPLATES
// =============================================================================

func getColorPaletteTemplates(c *gin.Context) {
	doc, err := preferences.LoadColorTemplates(colorPaletteTemplatesPath)
	if err != nil {
		// Corrupt file: serve empty slots so the UI can still open; log for repair.
		slog.Warn("color palette templates load failed", "error", err.Error(), "path", colorPaletteTemplatesPath)
		c.JSON(http.StatusOK, preferences.EmptyColorTemplates())
		return
	}
	c.JSON(http.StatusOK, doc)
}

func putColorPaletteTemplates(c *gin.Context) {
	var doc preferences.ColorTemplatesDoc
	if err := c.ShouldBindJSON(&doc); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid color templates payload"})
		return
	}
	normalized, err := preferences.NormalizeColorTemplates(doc)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := preferences.SaveColorTemplates(colorPaletteTemplatesPath, normalized); err != nil {
		// Path/IO failures are 500; validation already ran above.
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, normalized)
}

// =============================================================================
// AUTH
// =============================================================================

func hasSavedKey(c *gin.Context) {
	key := keycache.GetWithFallback()
	if len(key) >= 64 {
		c.JSON(http.StatusOK, gin.H{
			"hasKey":      true,
			"hasSavedKey": true,
		})
	} else {
		c.JSON(http.StatusOK, gin.H{
			"hasKey":      false,
			"hasSavedKey": false,
		})
	}
}

// setKey accepts a private key at runtime, caches it, and starts the user WS.
func setKey(c *gin.Context) {
	var req struct {
		PrivateKey     string `json:"privateKey"`
		AccountAddress string `json:"accountAddress"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.PrivateKey == "__AUTO__" {
		req.PrivateKey = keycache.GetWithFallback()
	}

	CachePrivateKeyFromFrontend(req.PrivateKey)

	if keycache.Get() == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid private key"})
		return
	}

	accountAddress := normalizeAccountAddress(req.AccountAddress)
	if accountAddress == "" {
		accountAddress = loadAccountAddress()
	}
	accountcache.Cache(accountAddress)

	if runtime.wsManager != nil {
		runtime.wsManager.SetUserSession(keycache.Get(), accountAddress)
	}

	// Pre-warm all xyz caches in the background so the first xyz order runs at full speed.
	if runtime.exchAdapter != nil {
		pk := keycache.Get()
		go runtime.exchAdapter.WarmUpForKey(serverLifecycleCtx, pk, false)
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "message": "key cached, user WebSocket started", "accountAddress": accountAddress})
}

func clearKey(c *gin.Context) {
	keycache.Clear()
	accountcache.Clear()
	if runtime.wsManager != nil {
		runtime.wsManager.ClearUserSession()
	}
	if runtime.exchAdapter != nil {
		runtime.exchAdapter.ClearParsedKeyCache()
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func loadAccountAddress() string {
	return accountcache.GetWithFallback()
}

// accountAddressPattern is compiled once; normalizeAccountAddress sits on the
// wallet/session hot path and must not recompile a regex per call.
var accountAddressPattern = regexp.MustCompile(`^0x[a-fA-F0-9]{40}$`)

func normalizeAccountAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	if accountAddressPattern.MatchString(addr) {
		return strings.ToLower(addr)
	}
	return ""
}

// CachePrivateKeyFromFrontend caches a private key received from the frontend.
func CachePrivateKeyFromFrontend(pk string) {
	keycache.Cache(pk)
	if len(pk) >= 64 {
		log.Printf("KEY: received from frontend, cached for WebSocket")
	}
}
