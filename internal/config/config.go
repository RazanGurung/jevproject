package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port              string
	BindAddress       string
	MainnetURL        string
	TestnetURL        string
	ServeWeb          bool
	AllowedOrigins    []string
	WebAPIBaseURL     string
	BotStateFile      string
	XNewsMirrorBase   string
	XNewsAccounts     []string
	NewsExtraRSSFeeds []string
	BskyNewsAccounts  []string
	APIToken          string
	// QuickNodeWsURL is a QuickNode HyperCore /hypercore/ws endpoint (incl. token).
	// When set, the server streams market-wide liquidations from it (ground truth
	// via the fills `liquidation` field). Empty => the feed stays dormant and the
	// LIQS panel shows own-account liquidations only.
	QuickNodeWsURL       string
	QuickNodeMinNotional float64
}

// ValidateExposure prevents an accidental LAN/public trading endpoint. A
// non-loopback bind is intentional only when it is paired with API auth.
func (c *Config) ValidateExposure() error {
	addr := strings.TrimSpace(c.BindAddress)
	if addr == "" || strings.EqualFold(addr, "localhost") {
		return nil
	}
	ip := net.ParseIP(addr)
	if ip != nil && ip.IsLoopback() {
		return nil
	}
	if strings.TrimSpace(c.APIToken) == "" {
		return fmt.Errorf("PEZ_BIND_ADDR=%q requires PEZ_API_TOKEN", addr)
	}
	return nil
}

func Load() *Config {
	return &Config{
		Port:                 getEnv("PORT", "5000"),
		BindAddress:          strings.TrimSpace(getEnv("PEZ_BIND_ADDR", "127.0.0.1")),
		MainnetURL:           "https://api.hyperliquid.xyz",
		TestnetURL:           "https://testnet-api.hyperliquid.xyz",
		ServeWeb:             getEnvBool("PEZ_SERVE_WEB", true),
		AllowedOrigins:       getEnvCSV("PEZ_ALLOWED_ORIGINS"),
		WebAPIBaseURL:        strings.TrimSpace(getEnv("PEZ_WEB_API_BASE_URL", "")),
		BotStateFile:         strings.TrimSpace(getEnv("PEZ_BOT_STATE_FILE", "data/bot-state.json")),
		XNewsMirrorBase:      strings.TrimSpace(getEnv("PEZ_X_NEWS_MIRROR_BASE", "")),
		XNewsAccounts:        getEnvCSV("PEZ_X_NEWS_ACCOUNTS"),
		NewsExtraRSSFeeds:    getEnvCSV("PEZ_NEWS_EXTRA_RSS_FEEDS"),
		BskyNewsAccounts:     getEnvCSV("PEZ_BSKY_NEWS_ACCOUNTS"),
		APIToken:             strings.TrimSpace(getEnv("PEZ_API_TOKEN", "")),
		QuickNodeWsURL:       strings.TrimSpace(getEnv("HL_QUICKNODE_WS", "")),
		QuickNodeMinNotional: getEnvFloat("HL_QUICKNODE_MIN_NOTIONAL", 10000),
	}
}

func getEnvFloat(key string, defaultValue float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return defaultValue
	}
	if value, err := strconv.ParseFloat(raw, 64); err == nil {
		return value
	}
	return defaultValue
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	value := os.Getenv(key)
	switch value {
	case "1", "true", "TRUE", "yes", "YES", "on", "ON":
		return true
	case "0", "false", "FALSE", "no", "NO", "off", "OFF":
		return false
	default:
		return defaultValue
	}
}

func getEnvCSV(key string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		values = append(values, value)
	}
	return values
}
