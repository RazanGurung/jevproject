package preload

import (
	"io"
	"net/http"
	"strings"
	"testing"

	cacheinfra "hyperliquid-go/internal/infrastructure/cache"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestLoadCoinDecimalsCanonicalizesBuilderPrefixOnce(t *testing.T) {
	loadedDexes := []string{}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(req.Body)
		bodyStr := string(body)
		response := `{"universe":[{"name":"BTC","szDecimals":5}]}`
		if strings.Contains(bodyStr, `"type":"perpDexs"`) {
			// Upstream exposes multiple builder dexs; only xyz may be loaded.
			response = `[null,{"name":"xyz"},{"name":"vntl"},{"name":"para"}]`
		} else if strings.Contains(bodyStr, `"dex":"xyz"`) {
			loadedDexes = append(loadedDexes, "xyz")
			response = `{"universe":[{"name":"xyz:NVDA","szDecimals":2,"maxLeverage":10,"tickSize":"0.01"}]}`
		} else if strings.Contains(bodyStr, `"dex":`) {
			// Any non-xyz dex meta request is a product-policy regression.
			t.Fatalf("unexpected non-xyz dex meta preload: %s", bodyStr)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(response)), Header: make(http.Header)}, nil
	})}
	metadata := cacheinfra.NewMemoryMetadataCache()
	service := NewPreloadService(PreloadConfig{HTTPClient: client, APIURL: "https://example.invalid", Metadata: metadata})

	service.LoadCoinDecimals()

	if !metadata.Has("xyz:NVDA") {
		t.Fatal("canonical xyz:NVDA metadata key missing")
	}
	if metadata.Has("xyz:xyz:NVDA") {
		t.Fatal("double-prefixed builder metadata key must not be created")
	}
	if len(loadedDexes) != 1 || loadedDexes[0] != "xyz" {
		t.Fatalf("loaded builder dexes=%v want [xyz]", loadedDexes)
	}
	if metadata.Has("vntl:BTC") || metadata.Has("para:AVGO") {
		t.Fatal("non-xyz HIP-3 markets must not enter metadata")
	}
}
