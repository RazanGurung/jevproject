package typesafe

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	DefaultBaseURL = "https://api.typesafe.ai/v1"
	DefaultModel   = "jev-latest"

	DefaultMaxFailures = 3
	DefaultCooldown    = 20 * time.Second
)

type cacheEntry struct {
	response  *SystemOneResponse
	expiresAt time.Time
}

// Client is a thread-safe client for TypeSafe AI's Jev "System One" decision engine.
// The API key is kept strictly anonymous in memory and is never logged or exposed.
type Client struct {
	apiKey     string
	baseURL    string
	model      string
	httpClient *http.Client
	mu         sync.RWMutex
	cacheMu    sync.RWMutex
	cache      map[string]cacheEntry
	cacheTTL   time.Duration

	cbMu           sync.RWMutex
	consecFailures int
	cbOpenUntil    time.Time
}

// QuestionSpec defines a single question primitive (choice, score, or noul) for Jev.
type QuestionSpec struct {
	Type         string      `json:"type"`                   // "choice", "score", or "noul"
	Instructions string      `json:"instructions,omitempty"` // Context/prompt for the decision
	Criteria     interface{} `json:"criteria,omitempty"`     // map[string]string for choice, []string for score
}

// SystemOneRequest is the payload sent to POST /v1/systemone.
type SystemOneRequest struct {
	Model     string                  `json:"model"`
	State     string                  `json:"state"`
	Questions map[string]QuestionSpec `json:"questions"`
}

// DecisionAnswer represents the structured answer returned by Jev for a question.
type DecisionAnswer struct {
	Type          string             `json:"type"`
	Choice        string             `json:"choice,omitempty"`
	Score         float64            `json:"score,omitempty"`
	Noul          float64            `json:"noul,omitempty"`
	Confidence    float64            `json:"confidence,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	Legend        map[string]string  `json:"legend,omitempty"`
}

// SystemOneResponse is the payload received from POST /v1/systemone.
type SystemOneResponse struct {
	Model   string                    `json:"model"`
	Answers map[string]DecisionAnswer `json:"answers"`
	Usage   struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

// ResolveKey locates the TypeSafe API key in order of priority:
// 1. TYPESAFE_API_KEY environment variable
// 2. PEZ_TYPESAFE_API_KEY environment variable
// 3. data/typesafe_key.txt (gitignored local file)
// 4. typesafe_key.txt (gitignored local file)
func ResolveKey() string {
	if k := strings.TrimSpace(os.Getenv("TYPESAFE_API_KEY")); k != "" {
		return k
	}
	if k := strings.TrimSpace(os.Getenv("PEZ_TYPESAFE_API_KEY")); k != "" {
		return k
	}
	if data, err := os.ReadFile("data/typesafe_key.txt"); err == nil {
		if k := strings.TrimSpace(string(data)); k != "" {
			return k
		}
	}
	if data, err := os.ReadFile("typesafe_key.txt"); err == nil {
		if k := strings.TrimSpace(string(data)); k != "" {
			return k
		}
	}
	return ""
}

// NewClient creates a new Client with the given API key.
// If apiKey is empty, it attempts to resolve the key from environment/disk.
func NewClient(apiKey, baseURL, model string, httpClient *http.Client) *Client {
	if apiKey == "" {
		apiKey = ResolveKey()
	}
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	if model == "" {
		model = DefaultModel
	}
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 10 * time.Second,
		}
	}
	return &Client{
		apiKey:     apiKey,
		baseURL:    baseURL,
		model:      model,
		httpClient: httpClient,
		cache:      make(map[string]cacheEntry),
		cacheTTL:   1 * time.Second,
	}
}

// IsAvailable returns true if an API key is configured.
func (c *Client) IsAvailable() bool {
	if c == nil {
		return false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.apiKey) > 0
}

// Model returns the configured model identifier.
func (c *Client) Model() string {
	if c == nil {
		return ""
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.model
}

// SetKey updates the API key at runtime.
func (c *Client) SetKey(key string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.apiKey = strings.TrimSpace(key)
}

// IsCircuitOpen returns true if the circuit breaker is currently open due to consecutive failures.
func (c *Client) IsCircuitOpen() bool {
	if c == nil {
		return false
	}
	c.cbMu.RLock()
	defer c.cbMu.RUnlock()
	if c.consecFailures >= DefaultMaxFailures {
		return time.Now().Before(c.cbOpenUntil)
	}
	return false
}

func (c *Client) recordSuccess() {
	c.cbMu.Lock()
	c.consecFailures = 0
	c.cbMu.Unlock()
}

func (c *Client) recordFailure() {
	c.cbMu.Lock()
	c.consecFailures++
	if c.consecFailures >= DefaultMaxFailures {
		c.cbOpenUntil = time.Now().Add(DefaultCooldown)
	}
	c.cbMu.Unlock()
}

// Decide submits a System One decision request to the Jev model.
func (c *Client) Decide(ctx context.Context, state string, questions map[string]QuestionSpec) (*SystemOneResponse, error) {
	if c == nil || !c.IsAvailable() {
		return nil, fmt.Errorf("typesafe jev client is not configured with an API key")
	}

	if c.IsCircuitOpen() {
		return nil, fmt.Errorf("typesafe circuit breaker open (cooling down after consecutive failures)")
	}

	c.mu.RLock()
	apiKey := c.apiKey
	baseURL := c.baseURL
	model := c.model
	c.mu.RUnlock()

	reqPayload := SystemOneRequest{
		Model:     model,
		State:     state,
		Questions: questions,
	}

	bodyBytes, err := json.Marshal(reqPayload)
	if err != nil {
		return nil, fmt.Errorf("failed to encode request: %w", err)
	}

	h := sha256.Sum256(bodyBytes)
	cacheKey := fmt.Sprintf("%s:%x", model, h)
	c.cacheMu.RLock()
	if c.cache != nil {
		if entry, ok := c.cache[cacheKey]; ok && time.Now().Before(entry.expiresAt) {
			c.cacheMu.RUnlock()
			return entry.response, nil
		}
	}
	c.cacheMu.RUnlock()

	url := baseURL + "/systemone"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create http request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("typesafe api request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode >= 500 {
			c.recordFailure()
		}
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("typesafe api HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(errBody)))
	}

	var result SystemOneResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("failed to decode typesafe api response: %w", err)
	}

	c.recordSuccess()

	if c.cacheTTL > 0 {
		c.cacheMu.Lock()
		if c.cache == nil {
			c.cache = make(map[string]cacheEntry)
		}
		if len(c.cache) > 256 {
			now := time.Now()
			for k, v := range c.cache {
				if now.After(v.expiresAt) {
					delete(c.cache, k)
				}
			}
		}
		c.cache[cacheKey] = cacheEntry{
			response:  &result,
			expiresAt: time.Now().Add(c.cacheTTL),
		}
		c.cacheMu.Unlock()
	}

	return &result, nil
}
