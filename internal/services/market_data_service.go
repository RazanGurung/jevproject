package services

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"hyperliquid-go/internal/ports/cache"
	"hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/pkg/utils"
)

// Liquidity floors shared by the market-movers and market-mispricing rankings so
// both surface only tradable tickers — and the mispricing warm-up skips dead
// names, cutting its load. Notional OI = markPx × openInterest; volume is the
// 24h notional (dayNtlVlm). Tunable via PEZ_MIN_TICKER_OI / PEZ_MIN_TICKER_VOL.
var (
	minTickerOINotionalUSD = envFloatDefault("PEZ_MIN_TICKER_OI", 3_000_000)
	minTickerDayVolUSD     = envFloatDefault("PEZ_MIN_TICKER_VOL", 1_000_000)
)

func envFloatDefault(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(key)), 64); err == nil && v > 0 {
		return v
	}
	return def
}

// meetsLiquidityFloor reports whether an asset ctx clears the shared notional-OI
// and 24h-volume floors, so only tickers with real liquidity and volume are
// ranked (movers) or tracked (mispricing).
func meetsLiquidityFloor(ctxMap map[string]interface{}) bool {
	if minTickerOINotionalUSD > 0 {
		markPx, okPx := parseInterfaceFloat(ctxMap["markPx"])
		oi, okOI := parseInterfaceFloat(ctxMap["openInterest"])
		if !okPx || !okOI || markPx*oi < minTickerOINotionalUSD {
			return false
		}
	}
	if minTickerDayVolUSD > 0 {
		vol, okVol := parseInterfaceFloat(ctxMap["dayNtlVlm"])
		if !okVol || vol < minTickerDayVolUSD {
			return false
		}
	}
	return true
}

// AssetSnapshot is a compact per-coin market snapshot used by the watchlist
// and other multi-coin surfaces for trading-trigger context (change, volume,
// open interest, funding). Populated from the same metaAndAssetCtxs payload
// that backs Get24hChanges.
type AssetSnapshot struct {
	Change  string  `json:"change"`
	DayVol  float64 `json:"dayNtlVlm,omitempty"`
	OI      float64 `json:"oi,omitempty"`
	Funding float64 `json:"funding,omitempty"`
	MarkPx  float64 `json:"markPx,omitempty"`
}

type MarketDataService struct {
	lifecycleCtx      context.Context
	exchange          exchange.Exchange
	priceCache        cache.PriceCache
	metadataCache     cache.CoinMetadataCache
	changesMu         sync.RWMutex
	changesCache      map[string]string
	// snapshotsCache rides with changesCache (same fetch); kept separately so
	// the string map stays a cheap drop-in for callers that only need %.
	snapshotsCache    map[string]AssetSnapshot
	changesAt         time.Time
	moversMu          sync.RWMutex
	moversCache       []MoverEntry
	moversAt          time.Time
	newsClient        *http.Client
	newsMu            sync.RWMutex
	newsCache         map[string]newsCacheEntry
	newsBatchCache    map[string]newsBatchCacheEntry
	newsInFlight      map[string]*newsInFlight
	xNewsMirrorBase   string
	xNewsFeeds        []xNewsFeed
	directNewsFeeds   []*newsFeedState
	directNewsByCoin  map[string][]*MarketNewsItem
	globalNewsItems   []*MarketNewsItem
	newsSeen          map[string]time.Time
	newsByFingerprint map[string]*MarketNewsItem
	newsSink          func([]*MarketNewsItem)
	bskyNewsAccounts  []string
	newsSourceHealth  map[string]NewsSourceHealth

	// Non-24/7 market close-reference tracking. Candidate discovery stays
	// independent from the asynchronous 1m reference resolver.
	mispricingMu         sync.RWMutex
	mispricingCache      []MispricingEntry
	mispricingAt         time.Time
	mispricingRefMu      sync.Mutex
	mispricingRefs       map[mispricingReferenceKey]float64
	mispricingRefFlight  map[mispricingReferenceKey]bool
	mispricingRetryAfter map[mispricingReferenceKey]time.Time
	mispricingRefFetcher MispricingReferenceFetcher
	mispricingRefSem     chan struct{}
	mispricingNow        func() time.Time
	jevService           *JevService
}

func (s *MarketDataService) SetJevService(js *JevService) { s.jevService = js }

func (s *MarketDataService) SetLifecycleContext(ctx context.Context) { s.lifecycleCtx = ctx }

func (s *MarketDataService) backgroundContext() context.Context {
	if s.lifecycleCtx != nil {
		return s.lifecycleCtx
	}
	return context.Background()
}

type MarketNewsOptions struct {
	XNewsMirrorBase string
	XNewsAccounts   []string
	ExtraRSSFeeds   []string
	BskyAccounts    []string
}

func NewMarketDataService(
	exchange exchange.Exchange,
	priceCache cache.PriceCache,
	metadataCache cache.CoinMetadataCache,
	newsClient *http.Client,
	options MarketNewsOptions,
) *MarketDataService {
	if newsClient == nil {
		newsClient = http.DefaultClient
	}
	xNewsFeeds := parseXNewsFeeds(options.XNewsMirrorBase, options.XNewsAccounts)
	return &MarketDataService{
		exchange:             exchange,
		priceCache:           priceCache,
		metadataCache:        metadataCache,
		changesCache:         map[string]string{},
		newsClient:           newsClient,
		newsCache:            map[string]newsCacheEntry{},
		newsBatchCache:       map[string]newsBatchCacheEntry{},
		newsInFlight:         map[string]*newsInFlight{},
		xNewsMirrorBase:      strings.TrimSpace(options.XNewsMirrorBase),
		xNewsFeeds:           xNewsFeeds,
		directNewsFeeds:      buildDirectNewsFeeds(options.ExtraRSSFeeds),
		directNewsByCoin:     map[string][]*MarketNewsItem{},
		globalNewsItems:      []*MarketNewsItem{},
		newsSeen:             map[string]time.Time{},
		newsByFingerprint:    map[string]*MarketNewsItem{},
		bskyNewsAccounts:     normalizeNewsAccounts(options.BskyAccounts),
		newsSourceHealth:     map[string]NewsSourceHealth{},
		mispricingRefs:       map[mispricingReferenceKey]float64{},
		mispricingRefFlight:  map[mispricingReferenceKey]bool{},
		mispricingRetryAfter: map[mispricingReferenceKey]time.Time{},
		mispricingRefSem:     make(chan struct{}, 3),
		mispricingNow:        time.Now,
	}
}

type MarketNewsItem struct {
	Coin                 string             `json:"coin"`
	Headline             string             `json:"headline"`
	Description          string             `json:"description,omitempty"`
	URL                  string             `json:"url"`
	Source               string             `json:"source"`
	PublishedAt          string             `json:"publishedAt"`
	Sentiment            float64            `json:"sentiment"`
	Provider             string             `json:"provider"`
	ID                   string             `json:"id,omitempty"`
	Coins                []string           `json:"coins,omitempty"`
	Scope                string             `json:"scope,omitempty"`
	SourceTier           string             `json:"sourceTier,omitempty"`
	Verification         string             `json:"verification,omitempty"`
	IngestedAt           string             `json:"ingestedAt,omitempty"`
	DetectedPrices       map[string]float64 `json:"detectedPrices,omitempty"`
	Relevance            float64            `json:"relevance,omitempty"`
	CorroborationCount   int                `json:"corroborationCount,omitempty"`
	CorroboratingSources []string           `json:"corroboratingSources,omitempty"`
}

type NewsSourceHealth struct {
	Provider      string    `json:"provider"`
	LastAttemptAt time.Time `json:"lastAttemptAt,omitempty"`
	LastSuccessAt time.Time `json:"lastSuccessAt,omitempty"`
	LastError     string    `json:"lastError,omitempty"`
	Items         int       `json:"items"`
}

type newsCacheEntry struct {
	items     []*MarketNewsItem
	expiresAt time.Time
	found     bool
}

type newsBatchCacheEntry struct {
	items     map[string][]*MarketNewsItem
	err       string
	expiresAt time.Time
}

type newsInFlight struct {
	done  chan struct{}
	items []*MarketNewsItem
	err   error
}

// maxNewsItemsPerCoin caps how many ranked headlines are kept per coin. The
// radar's featured (current-chart) row renders up to this many; compact rows
// render fewer.
const maxNewsItemsPerCoin = 6

// maxNewsDescriptionLen bounds a rendered snippet length (chars).
const maxNewsDescriptionLen = 160

var htmlTagPattern = regexp.MustCompile(`(?s)<[^>]*>`)

// cleanNewsDescription turns a raw RSS <description> into a plain-text snippet
// suitable for display under a headline. It strips HTML, unescapes entities,
// collapses whitespace, and truncates on a word boundary. It returns "" when
// the result is empty or essentially a duplicate of the headline (e.g. Google
// News descriptions are usually just a related-link list, not a real summary).
func cleanNewsDescription(raw, headline string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	text = htmlTagPattern.ReplaceAllString(text, " ")
	text = html.UnescapeString(text)
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return ""
	}

	// Drop snippets that just restate the headline.
	normalized := strings.ToLower(text)
	normalizedHeadline := strings.ToLower(strings.TrimSpace(headline))
	if normalizedHeadline != "" && (normalized == normalizedHeadline ||
		strings.HasPrefix(normalized, normalizedHeadline) ||
		strings.HasPrefix(normalizedHeadline, normalized)) {
		return ""
	}

	runes := []rune(text)
	if len(runes) <= maxNewsDescriptionLen {
		return text
	}
	truncated := string(runes[:maxNewsDescriptionLen])
	if idx := strings.LastIndex(truncated, " "); idx > 0 {
		truncated = truncated[:idx]
	}
	return strings.TrimSpace(truncated) + "…"
}

func pickBestNewsItems(coin string, query newsQuery, data []googleNewsRSSItem) []*MarketNewsItem {
	type scoredNewsItem struct {
		item  *MarketNewsItem
		score float64
	}

	scored := make([]scoredNewsItem, 0, len(data))
	for _, article := range data {
		headline := cleanGoogleNewsHeadline(article.Title, article.Source.Name)
		if strings.TrimSpace(headline) == "" {
			continue
		}
		publishedTime, ok := parseNewsPublishedAt(article.PublishedAt)
		if !ok {
			continue
		}
		if publishedTime.After(time.Now().Add(5*time.Minute)) || time.Since(publishedTime) > maxNewsAge {
			continue
		}
		if !isRelevantGoogleNewsHeadline(headline, query) {
			continue
		}
		impact := scoreNewsImpact(headline, "", query)
		if impact < minimumNewsImpact {
			continue
		}
		item := &MarketNewsItem{
			Coin:        coin,
			Headline:    headline,
			Description: cleanNewsDescription(article.Description, headline),
			URL:         strings.TrimSpace(article.Link),
			Source:      strings.TrimSpace(article.Source.Name),
			PublishedAt: article.PublishedAt,
			Sentiment:   scoreHeadlineSentiment(headline, query),
			Provider:    "google-news-rss",
			Relevance:   impact,
		}
		scored = append(scored, scoredNewsItem{
			item:  item,
			score: scoreNewsArticle(headline, article.PublishedAt, query) + impact*20,
		})
	}

	if len(scored) == 0 {
		return nil
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].item.PublishedAt > scored[j].item.PublishedAt
		}
		return scored[i].score > scored[j].score
	})

	results := make([]*MarketNewsItem, 0, maxNewsItemsPerCoin)
	seenTitles := map[string]struct{}{}
	for _, candidate := range scored {
		titleKey := strings.ToLower(strings.TrimSpace(candidate.item.Headline))
		if titleKey == "" {
			continue
		}
		if _, exists := seenTitles[titleKey]; exists {
			continue
		}
		seenTitles[titleKey] = struct{}{}
		results = append(results, candidate.item)
		if len(results) == maxNewsItemsPerCoin {
			break
		}
	}
	return results
}

func parseNewsPublishedAt(publishedAt string) (time.Time, bool) {
	candidates := []string{time.RFC1123Z, time.RFC1123, time.RFC3339}
	for _, layout := range candidates {
		parsed, err := time.Parse(layout, strings.TrimSpace(publishedAt))
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func cleanGoogleNewsHeadline(title, source string) string {
	headline := strings.TrimSpace(title)
	source = strings.TrimSpace(source)
	if headline == "" {
		return ""
	}
	suffix := " - " + source
	if source != "" && strings.HasSuffix(headline, suffix) {
		headline = strings.TrimSpace(strings.TrimSuffix(headline, suffix))
	}
	return headline
}

func cleanRSSHeadline(title string) string {
	headline := strings.TrimSpace(title)
	if headline == "" {
		return ""
	}
	headline = strings.ReplaceAll(headline, "\n", " ")
	headline = strings.ReplaceAll(headline, "\t", " ")
	headline = strings.Join(strings.Fields(headline), " ")
	return strings.TrimSpace(headline)
}

func scoreHeadlineSentiment(title string, query newsQuery) float64 {
	titleLower := strings.ToLower(strings.TrimSpace(title))
	if titleLower == "" {
		return 0
	}

	bullish := scoreWeightedPhrases(titleLower, bullishHeadlinePhrases)
	bearish := scoreWeightedPhrases(titleLower, bearishHeadlinePhrases)
	net := bullish - bearish

	aliasHits := 0.0
	for _, alias := range query.aliases {
		if aliasMatches(titleLower, alias) {
			aliasHits += 1
		}
	}
	if aliasHits > 0 {
		net *= 1 + minFloat(aliasHits, 2)*0.15
	}
	if strings.Contains(titleLower, " not ") || strings.Contains(titleLower, " no ") || strings.Contains(titleLower, " denies ") {
		net *= 0.85
	}
	return clampFloat(net, -1, 1)
}

func scoreNewsImpact(title, sourceTier string, query newsQuery) float64 {
	titleLower := strings.ToLower(strings.TrimSpace(title))
	if titleLower == "" {
		return 0
	}
	for _, phrase := range lowImpactNewsPhrases {
		if strings.Contains(titleLower, phrase) {
			return 0
		}
	}

	impact := 0.0
	for _, phrase := range priceImpactPhrases {
		if aliasMatches(titleLower, phrase.phrase) && phrase.weight > impact {
			impact = phrase.weight
		}
	}

	aliasConfidence := 0.0
	for _, alias := range query.aliases {
		if aliasMatches(titleLower, alias) {
			aliasConfidence += 0.15
		}
	}
	impact += minFloat(aliasConfidence, 0.25)

	switch strings.ToLower(strings.TrimSpace(sourceTier)) {
	case "official":
		impact += 0.2
	case "publisher":
		impact += 0.05
	}
	return clampFloat(impact, 0, 1)
}

func scoreWeightedPhrases(title string, phrases []weightedPhrase) float64 {
	score := 0.0
	for _, phrase := range phrases {
		if phrase.phrase == "" {
			continue
		}
		idx := strings.Index(title, phrase.phrase)
		if idx < 0 {
			continue
		}
		if hasNegationNear(title, idx) {
			score -= phrase.weight * 0.55
			continue
		}
		score += phrase.weight
	}
	return score
}

func hasNegationNear(title string, phraseIdx int) bool {
	if phraseIdx < 0 {
		return false
	}
	start := phraseIdx - 20
	if start < 0 {
		start = 0
	}
	window := title[start:phraseIdx]
	for _, negation := range []string{"not ", "no ", "without ", "denies ", "denied ", "avoid ", "avoids ", "averts "} {
		if strings.Contains(window, negation) {
			return true
		}
	}
	return false
}

func clampFloat(value, low, high float64) float64 {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func minFloat(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}

func isRelevantGoogleNewsHeadline(title string, query newsQuery) bool {
	titleLower := strings.ToLower(strings.TrimSpace(title))
	if titleLower == "" {
		return false
	}
	for _, exclude := range query.excludes {
		exclude = strings.ToLower(strings.TrimSpace(exclude))
		if exclude != "" && strings.Contains(titleLower, exclude) {
			return false
		}
	}
	for _, alias := range query.aliases {
		if aliasMatches(titleLower, alias) {
			return true
		}
	}
	return false
}

// aliasMatches reports whether the (already lower-cased) headline references the
// given alias. Multi-word names and longer aliases use a plain substring match;
// short single-token aliases (e.g. ticker symbols like "btc" or common-word
// tokens) require a word boundary so "pump" does not match "pumping" and "move"
// does not match "movement".
func aliasMatches(titleLower, alias string) bool {
	alias = strings.ToLower(strings.TrimSpace(alias))
	if alias == "" {
		return false
	}
	if strings.ContainsAny(alias, " .") || len(alias) >= 6 {
		return strings.Contains(titleLower, alias)
	}
	return containsWord(titleLower, alias)
}

// containsWord reports whether word appears in haystack delimited by
// non-alphanumeric boundaries (start/end of string count as boundaries).
func containsWord(haystack, word string) bool {
	if word == "" {
		return false
	}
	from := 0
	for from <= len(haystack)-len(word) {
		idx := strings.Index(haystack[from:], word)
		if idx < 0 {
			return false
		}
		start := from + idx
		end := start + len(word)
		if !byteIsAlnum(haystack, start-1) && !byteIsAlnum(haystack, end) {
			return true
		}
		from = start + 1
	}
	return false
}

func byteIsAlnum(s string, i int) bool {
	if i < 0 || i >= len(s) {
		return false
	}
	c := s[i]
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func scoreNewsArticle(title, publishedAt string, query newsQuery) float64 {
	score := 0.0
	titleLower := strings.ToLower(strings.TrimSpace(title))
	for _, alias := range query.aliases {
		if aliasMatches(titleLower, alias) {
			score += 8
		}
	}

	publishedTime, ok := parseNewsPublishedAt(publishedAt)
	if ok {
		age := time.Since(publishedTime)
		switch {
		case age <= 30*time.Minute:
			score += 10
		case age <= 2*time.Hour:
			score += 7
		case age <= 6*time.Hour:
			score += 5
		case age <= 24*time.Hour:
			score += 3
		case age <= 72*time.Hour:
			score += 1
		default:
			score -= 2
		}
	}

	return score
}

func mergeNewsItems(primary, extra []*MarketNewsItem) []*MarketNewsItem {
	if len(extra) == 0 {
		return primary
	}
	merged := append([]*MarketNewsItem(nil), primary...)
	seen := map[string]struct{}{}
	for _, item := range merged {
		key := normalizedNewsIdentity(item)
		if key != "" {
			seen[key] = struct{}{}
		}
	}
	for _, item := range extra {
		key := normalizedNewsIdentity(item)
		if key != "" {
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
		}
		merged = append(merged, item)
	}
	sort.SliceStable(merged, func(i, j int) bool {
		left, leftOK := parseNewsPublishedAt(merged[i].PublishedAt)
		right, rightOK := parseNewsPublishedAt(merged[j].PublishedAt)
		switch {
		case leftOK && rightOK:
			return left.After(right)
		case leftOK:
			return true
		case rightOK:
			return false
		default:
			return merged[i].Headline < merged[j].Headline
		}
	})
	if len(merged) > maxNewsItemsPerCoin {
		return merged[:maxNewsItemsPerCoin]
	}
	return merged
}

func normalizedNewsIdentity(item *MarketNewsItem) string {
	if item == nil {
		return ""
	}
	parts := []string{
		strings.ToLower(strings.TrimSpace(item.Headline)),
		strings.ToLower(strings.TrimSpace(item.Source)),
		strings.TrimSpace(item.PublishedAt),
	}
	return strings.Join(parts, "|")
}

func parseXNewsFeeds(mirrorBase string, accounts []string) []xNewsFeed {
	mirrorBase = strings.TrimSpace(mirrorBase)
	if mirrorBase == "" || len(accounts) == 0 {
		return nil
	}
	base := strings.TrimRight(mirrorBase, "/")
	feeds := make([]xNewsFeed, 0, len(accounts))
	seen := map[string]struct{}{}
	for _, raw := range accounts {
		handle := normalizeXHandle(raw)
		if handle == "" {
			continue
		}
		key := strings.ToLower(handle)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		feeds = append(feeds, xNewsFeed{
			handle: handle,
			url:    base + "/" + handle + "/rss",
		})
	}
	return feeds
}

func normalizeXHandle(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	value = strings.TrimPrefix(value, "@")
	if !strings.Contains(value, "://") && !strings.Contains(value, "/") {
		return strings.TrimSpace(value)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	handle := strings.TrimSpace(parts[0])
	if handle == "" || strings.EqualFold(handle, "i") || strings.EqualFold(handle, "home") || strings.EqualFold(handle, "explore") {
		return ""
	}
	return strings.TrimPrefix(handle, "@")
}

func canonicalizeXLink(rawLink, fallbackHandle string) string {
	link := strings.TrimSpace(rawLink)
	if link == "" {
		return ""
	}
	parsed, err := url.Parse(link)
	if err != nil {
		return link
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) >= 3 && strings.EqualFold(parts[1], "status") {
		handle := parts[0]
		if handle == "" {
			handle = strings.TrimPrefix(strings.TrimSpace(fallbackHandle), "@")
		}
		if handle != "" {
			return "https://x.com/" + handle + "/status/" + parts[2]
		}
	}
	return link
}

func (s *MarketDataService) GetL2Snapshot(ctx context.Context, coin string, depth int, testnet bool) (interface{}, error) {
	if s.exchange == nil {
		return nil, nil
	}
	return s.exchange.GetL2Snapshot(ctx, coin, depth, testnet)
}

func (s *MarketDataService) GetCoinMeta(ctx context.Context, coin string) (map[string]interface{}, error) {
	if s.metadataCache == nil {
		return nil, nil
	}
	return map[string]interface{}{
		"szDecimals":  s.metadataCache.GetDecimals(coin),
		"tickSize":    s.metadataCache.GetTickSize(coin),
		"maxLeverage": s.metadataCache.GetMaxLeverage(coin),
	}, nil
}

// GetAllCachedMeta returns all cached coin metadata (used when no specific coin is requested).
func (s *MarketDataService) GetAllCachedMeta() map[string]interface{} {
	if s.metadataCache == nil {
		return map[string]interface{}{}
	}
	// Type assert to concrete implementation for bulk methods
	if mc, ok := s.metadataCache.(interface {
		GetAllDecimals() map[string]int
		GetAllTickSizes() map[string]float64
		GetAllMaxLeverages() map[string]int
	}); ok {
		decimals := mc.GetAllDecimals()
		tickSizes := mc.GetAllTickSizes()
		maxLeverage := mc.GetAllMaxLeverages()
		return map[string]interface{}{
			"szDecimals":  decimals,
			"decimals":    decimals,
			"tickSizes":   tickSizes,
			"maxLeverage": maxLeverage,
			"leverage":    maxLeverage,
		}
	}
	return map[string]interface{}{}
}

func (s *MarketDataService) Get24hChanges(ctx context.Context) (map[string]string, error) {
	snapshots, err := s.GetAssetSnapshots(ctx)
	if err != nil {
		return nil, err
	}
	changes := make(map[string]string, len(snapshots))
	for coin, snap := range snapshots {
		if snap.Change != "" {
			changes[coin] = snap.Change
		}
	}
	return changes, nil
}

// GetAssetSnapshots returns per-coin 24h change plus volume / OI / funding from
// the latest metaAndAssetCtxs payload. Prefer this over Get24hChanges when the
// client needs trading-trigger columns (watchlist).
func (s *MarketDataService) GetAssetSnapshots(ctx context.Context) (map[string]AssetSnapshot, error) {
	if s.exchange == nil {
		return map[string]AssetSnapshot{}, nil
	}

	defaultCtxs, err := s.exchange.GetAssetCtxs(ctx, "")
	if err != nil {
		if cached, ok := s.getCachedAssetSnapshots(); ok {
			return cached, nil
		}
		return nil, err
	}

	snapshots := make(map[string]AssetSnapshot, len(defaultCtxs))
	mergeSnapshots := func(assetCtxs []interface{}, prefix string) {
		for _, raw := range assetCtxs {
			ctxMap, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}

			coin := getStringField(ctxMap, "coin", "name")
			if coin == "" {
				continue
			}
			if prefix != "" && len(coin) >= len(prefix) && coin[:len(prefix)] != prefix {
				coin = prefix + coin
			} else if prefix != "" && len(coin) < len(prefix) {
				coin = prefix + coin
			}

			change, okChange := extract24hChange(ctxMap)
			if !okChange {
				continue
			}

			snap := AssetSnapshot{Change: fmt.Sprintf("%.2f", change)}
			if markPx, ok := parseInterfaceFloat(ctxMap["markPx"]); ok && markPx > 0 {
				snap.MarkPx = markPx
				if oi, okOI := parseInterfaceFloat(ctxMap["openInterest"]); okOI && oi > 0 {
					snap.OI = markPx * oi
				}
			}
			if vol, ok := parseInterfaceFloat(ctxMap["dayNtlVlm"]); ok && vol > 0 {
				snap.DayVol = vol
			}
			// Asset-ctx funding is the current predicted rate (decimal). Store as
			// percent points (×100) so clients can display without re-scaling.
			if funding, ok := parseInterfaceFloat(ctxMap["funding"]); ok {
				snap.Funding = funding * 100
			}
			snapshots[coin] = snap
		}
	}

	mergeSnapshots(defaultCtxs, "")

	if xyzCtxs, err := s.exchange.GetAssetCtxs(ctx, "xyz"); err == nil {
		mergeSnapshots(xyzCtxs, "xyz:")
	} else if cached, ok := s.getCachedAssetSnapshots(); ok {
		for coin, snap := range cached {
			if utils.IsHip3Coin(coin) {
				snapshots[coin] = snap
			}
		}
	}

	s.setCachedAssetSnapshots(snapshots)
	return snapshots, nil
}

// MoverEntry is a per-coin snapshot of 24h change and notional open interest,
// used to rank top gainers/losers within the high-OI cohort.
type MoverEntry struct {
	Coin   string  `json:"coin"`
	Change float64 `json:"change"`
	OI     float64 `json:"oi"`
}

// RankedMovers is the topbar-ready split of the high-OI cohort into the two
// rows the browser renders directly: top gainers and top losers.
type RankedMovers struct {
	Gainers []MoverEntry `json:"gainers"`
	Losers  []MoverEntry `json:"losers"`
}

const moversMaxPerRow = 40

// rankMovers keeps coins with valid OI/change, takes the top 50% by notional
// open interest (the at-or-above-median cohort), then splits that cohort into
// gainers (change desc) and losers (change asc), each capped at maxPerRow.
// This is the server-side owner of the ranking the browser used to do; the
// browser now renders the returned rows as-is.
func rankMovers(entries []MoverEntry, maxPerRow int) RankedMovers {
	if maxPerRow <= 0 {
		maxPerRow = moversMaxPerRow
	}

	valid := make([]MoverEntry, 0, len(entries))
	for _, e := range entries {
		if e.Coin == "" || e.OI <= 0 {
			continue
		}
		valid = append(valid, e)
	}

	byOI := make([]MoverEntry, len(valid))
	copy(byOI, valid)
	sort.SliceStable(byOI, func(i, j int) bool { return byOI[i].OI > byOI[j].OI })

	// Top 50% by count = pairs at or above the median OI.
	cohortSize := (len(byOI) + 1) / 2
	cohort := byOI[:cohortSize]

	gainers := make([]MoverEntry, 0, cohortSize)
	losers := make([]MoverEntry, 0, cohortSize)
	for _, e := range cohort {
		switch {
		case e.Change > 0:
			gainers = append(gainers, e)
		case e.Change < 0:
			losers = append(losers, e)
		}
	}
	sort.SliceStable(gainers, func(i, j int) bool { return gainers[i].Change > gainers[j].Change })
	sort.SliceStable(losers, func(i, j int) bool { return losers[i].Change < losers[j].Change })

	if len(gainers) > maxPerRow {
		gainers = gainers[:maxPerRow]
	}
	if len(losers) > maxPerRow {
		losers = losers[:maxPerRow]
	}
	return RankedMovers{Gainers: gainers, Losers: losers}
}

// GetRankedMovers returns the high-OI cohort already split into gainers/losers
// rows. The browser renders these directly instead of ranking client-side.
func (s *MarketDataService) GetRankedMovers(ctx context.Context) (RankedMovers, error) {
	movers, err := s.GetMarketMovers(ctx)
	if err != nil {
		return RankedMovers{Gainers: []MoverEntry{}, Losers: []MoverEntry{}}, err
	}
	return rankMovers(movers, moversMaxPerRow), nil
}

// GetMarketMovers returns per-coin 24h change and notional OI across the default
// and xyz dexes. It reuses the same asset-context source as Get24hChanges; the
// 24h change and openInterest/markPx all come from one metaAndAssetCtxs response.
func (s *MarketDataService) GetMarketMovers(ctx context.Context) ([]MoverEntry, error) {
	if s.exchange == nil {
		return []MoverEntry{}, nil
	}

	defaultCtxs, err := s.exchange.GetAssetCtxs(ctx, "")
	if err != nil {
		if cached, ok := s.getCachedMovers(); ok {
			return cached, nil
		}
		return nil, err
	}

	movers := make([]MoverEntry, 0, len(defaultCtxs))
	mergeMovers := func(assetCtxs []interface{}, prefix string) {
		for _, raw := range assetCtxs {
			ctxMap, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}

			coin := getStringField(ctxMap, "coin", "name")
			if coin == "" {
				continue
			}
			if prefix != "" && (len(coin) < len(prefix) || coin[:len(prefix)] != prefix) {
				coin = prefix + coin
			}

			change, okChange := extract24hChange(ctxMap)
			if !okChange {
				continue
			}
			// Only rank tickers with real liquidity and volume (shared with the
			// market-mispricing filter).
			if !meetsLiquidityFloor(ctxMap) {
				continue
			}
			markPx, okMark := parseInterfaceFloat(ctxMap["markPx"])
			openInterest, okOI := parseInterfaceFloat(ctxMap["openInterest"])
			if !okMark || !okOI {
				continue
			}
			oi := markPx * openInterest
			if oi <= 0 {
				continue
			}

			movers = append(movers, MoverEntry{Coin: coin, Change: change, OI: oi})
		}
	}

	mergeMovers(defaultCtxs, "")

	if xyzCtxs, err := s.exchange.GetAssetCtxs(ctx, "xyz"); err == nil {
		mergeMovers(xyzCtxs, "xyz:")
	} else if cached, ok := s.getCachedMovers(); ok {
		for _, entry := range cached {
			if strings.HasPrefix(entry.Coin, "xyz:") {
				movers = append(movers, entry)
			}
		}
	}

	s.setCachedMovers(movers)
	return movers, nil
}

func (s *MarketDataService) getCachedMovers() ([]MoverEntry, bool) {
	s.moversMu.RLock()
	defer s.moversMu.RUnlock()
	if len(s.moversCache) == 0 || time.Since(s.moversAt) > 10*time.Minute {
		return nil, false
	}
	cached := make([]MoverEntry, len(s.moversCache))
	copy(cached, s.moversCache)
	return cached, true
}

func (s *MarketDataService) setCachedMovers(movers []MoverEntry) {
	if len(movers) == 0 {
		return
	}
	copyMovers := make([]MoverEntry, len(movers))
	copy(copyMovers, movers)
	s.moversMu.Lock()
	s.moversCache = copyMovers
	s.moversAt = time.Now()
	s.moversMu.Unlock()
}

func (s *MarketDataService) getCachedAssetSnapshots() (map[string]AssetSnapshot, bool) {
	s.changesMu.RLock()
	defer s.changesMu.RUnlock()
	if len(s.snapshotsCache) == 0 || time.Since(s.changesAt) > 10*time.Minute {
		return nil, false
	}
	cached := make(map[string]AssetSnapshot, len(s.snapshotsCache))
	for coin, snap := range s.snapshotsCache {
		cached[coin] = snap
	}
	return cached, true
}

func (s *MarketDataService) setCachedAssetSnapshots(snapshots map[string]AssetSnapshot) {
	if len(snapshots) == 0 {
		return
	}
	copySnaps := make(map[string]AssetSnapshot, len(snapshots))
	copyChanges := make(map[string]string, len(snapshots))
	for coin, snap := range snapshots {
		copySnaps[coin] = snap
		if snap.Change != "" {
			copyChanges[coin] = snap.Change
		}
	}
	s.changesMu.Lock()
	s.snapshotsCache = copySnaps
	s.changesCache = copyChanges
	s.changesAt = time.Now()
	s.changesMu.Unlock()
}

func extract24hChange(ctxMap map[string]interface{}) (float64, bool) {
	for _, key := range []string{"change24h", "priceChange24h", "priceChange", "pctChange", "dayPxChange"} {
		if value, ok := parseInterfaceFloat(ctxMap[key]); ok {
			return value, true
		}
	}

	markPx, okMark := parseInterfaceFloat(ctxMap["markPx"])
	prevDayPx, okPrev := parseInterfaceFloat(ctxMap["prevDayPx"])
	if okMark && okPrev && prevDayPx != 0 {
		return ((markPx - prevDayPx) / prevDayPx) * 100, true
	}

	return 0, false
}

func getStringField(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := m[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

func parseInterfaceFloat(v interface{}) (float64, bool) {
	switch value := v.(type) {
	case float64:
		return value, true
	case float32:
		return float64(value), true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case string:
		if value == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}
