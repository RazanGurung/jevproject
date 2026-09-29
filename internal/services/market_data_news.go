package services

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type newsQuery struct {
	search   string
	aliases  []string
	excludes []string
	locale   newsLocale
}

type xNewsFeed struct {
	handle string
	url    string
}

type weightedPhrase struct {
	phrase string
	weight float64
}

const maxNewsAge = 72 * time.Hour
const maxNewsBatchCacheEntries = 256

const minimumNewsImpact = 0.45

// These phrases identify content that mentions a ticker but is rarely a
// catalyst. Keeping this list narrow avoids suppressing legitimate reporting
// while removing the recurring SEO/promo clutter common in free RSS results.
var lowImpactNewsPhrases = []string{
	"price prediction", "price forecast", "technical analysis", "chart analysis",
	"what is ", "how to buy", "how to trade", "beginner's guide", "beginners guide",
	"should you buy", "worth buying", "best crypto", "top cryptocurrencies",
	"could reach", "may reach", "analyst predicts", "analyst says", "here's why",
	"things to know", "everything you need to know", "sponsored", "press release",
	"presale", "giveaway", "casino", "gambling", "podcast", "newsletter",
}

// Impact weights describe concrete catalysts or market-moving conditions. An
// asset-name match contributes additional confidence, but a name match alone
// is no longer enough to enter the feed.
var priceImpactPhrases = []weightedPhrase{
	{phrase: "hack", weight: 0.9}, {phrase: "exploit", weight: 0.9},
	{phrase: "breach", weight: 0.85}, {phrase: "stolen", weight: 0.85},
	{phrase: "depeg", weight: 0.9}, {phrase: "bankruptcy", weight: 0.9},
	{phrase: "insolvent", weight: 0.9}, {phrase: "halts withdrawals", weight: 0.9},
	{phrase: "network outage", weight: 0.85}, {phrase: "chain halted", weight: 0.85},
	{phrase: "sec sues", weight: 0.85}, {phrase: "charged", weight: 0.75},
	{phrase: "lawsuit", weight: 0.7}, {phrase: "settlement", weight: 0.65},
	{phrase: "investigation", weight: 0.65}, {phrase: "probe", weight: 0.6},
	{phrase: "approved", weight: 0.7}, {phrase: "approval", weight: 0.65},
	{phrase: "rejected", weight: 0.65}, {phrase: "denied", weight: 0.6},
	{phrase: "etf", weight: 0.55}, {phrase: "inflows", weight: 0.6},
	{phrase: "outflows", weight: 0.6}, {phrase: "liquidation", weight: 0.55},
	{phrase: "delisting", weight: 0.75}, {phrase: "listed on", weight: 0.6},
	{phrase: "exchange listing", weight: 0.65}, {phrase: "token unlock", weight: 0.7},
	{phrase: "token burn", weight: 0.6}, {phrase: "mainnet", weight: 0.55},
	{phrase: "hard fork", weight: 0.6}, {phrase: "network upgrade", weight: 0.55},
	{phrase: "acquisition", weight: 0.65}, {phrase: "merger", weight: 0.65},
	{phrase: "earnings", weight: 0.55}, {phrase: "revenue", weight: 0.5},
	{phrase: "guidance", weight: 0.55}, {phrase: "treasury", weight: 0.5},
	{phrase: "buys", weight: 0.5}, {phrase: "acquires", weight: 0.55},
	{phrase: "sells", weight: 0.45}, {phrase: "funding", weight: 0.4},
	{phrase: "interest rate", weight: 0.7}, {phrase: "rate cut", weight: 0.65},
	{phrase: "rate hike", weight: 0.65}, {phrase: "federal reserve", weight: 0.65},
	{phrase: "fomc", weight: 0.65}, {phrase: "monetary policy", weight: 0.65},
	{phrase: "inflation", weight: 0.6},
	{phrase: "cpi", weight: 0.6}, {phrase: "payrolls", weight: 0.55},
	{phrase: "tariff", weight: 0.55}, {phrase: "sanction", weight: 0.6},
	{phrase: "regulation", weight: 0.55}, {phrase: "regulator", weight: 0.55},
	{phrase: "legislation", weight: 0.55}, {phrase: "license", weight: 0.5},
	{phrase: "reserve", weight: 0.45}, {phrase: "whale", weight: 0.4},
	{phrase: "mining difficulty", weight: 0.45}, {phrase: "hashrate", weight: 0.45},
	{phrase: "production", weight: 0.4}, {phrase: "inventory", weight: 0.45},
	{phrase: "inventories", weight: 0.45}, {phrase: "stockpile", weight: 0.45},
	{phrase: "supply", weight: 0.4}, {phrase: "demand", weight: 0.4},
	{phrase: "exports", weight: 0.4}, {phrase: "imports", weight: 0.4},
	{phrase: "adoption", weight: 0.4}, {phrase: "launch", weight: 0.4},
	{phrase: "partnership", weight: 0.3}, {phrase: "integrates", weight: 0.35},
	{phrase: "surges", weight: 0.35}, {phrase: "soars", weight: 0.35},
	{phrase: "rallies", weight: 0.35}, {phrase: "jumps", weight: 0.35},
	{phrase: "plunges", weight: 0.4}, {phrase: "tumbles", weight: 0.35},
	{phrase: "slides", weight: 0.35}, {phrase: "slips", weight: 0.35},
	{phrase: "rises", weight: 0.35}, {phrase: "advances", weight: 0.35},
	{phrase: "climbs", weight: 0.35}, {phrase: "rebounds", weight: 0.35},
	{phrase: "rebound", weight: 0.35}, {phrase: "falls", weight: 0.35},
	{phrase: "drops", weight: 0.35}, {phrase: "drop", weight: 0.35},
	{phrase: "selloff", weight: 0.45}, {phrase: "record high", weight: 0.45},
}

var bullishHeadlinePhrases = []weightedPhrase{
	{phrase: "sec approves", weight: 1.2},
	{phrase: "etf approval", weight: 1.15},
	{phrase: "wins approval", weight: 1.05},
	{phrase: "approved", weight: 0.65},
	{phrase: "greenlit", weight: 0.7},
	{phrase: "record inflows", weight: 1.1},
	{phrase: "net inflows", weight: 0.95},
	{phrase: "inflows", weight: 0.7},
	{phrase: "accumulation", weight: 0.6},
	{phrase: "buyback", weight: 0.85},
	{phrase: "treasury purchase", weight: 0.75},
	{phrase: "strategic reserve", weight: 0.8},
	{phrase: "partners with", weight: 0.8},
	{phrase: "partnership", weight: 0.65},
	{phrase: "integrates with", weight: 0.8},
	{phrase: "integration", weight: 0.6},
	{phrase: "mainnet launch", weight: 0.95},
	{phrase: "goes live", weight: 0.7},
	{phrase: "launch", weight: 0.5},
	{phrase: "upgrade", weight: 0.45},
	{phrase: "governance approved", weight: 0.75},
	{phrase: "institutional adoption", weight: 0.95},
	{phrase: "adoption", weight: 0.55},
	{phrase: "earnings beat", weight: 0.8},
	{phrase: "beats expectations", weight: 0.75},
	{phrase: "strong guidance", weight: 0.75},
	{phrase: "raises guidance", weight: 0.8},
	{phrase: "profit jumps", weight: 0.7},
	{phrase: "breakout", weight: 0.7},
	{phrase: "breaks above", weight: 0.75},
	{phrase: "reclaims", weight: 0.55},
	{phrase: "all-time high", weight: 0.95},
	{phrase: "new high", weight: 0.65},
	{phrase: "short squeeze", weight: 0.55},
	{phrase: "supply shock", weight: 0.8},
	{phrase: "whale buying", weight: 0.7},
	{phrase: "listed on", weight: 0.75},
	{phrase: "exchange listing", weight: 0.75},
	{phrase: "adds support", weight: 0.6},
	{phrase: "token burn", weight: 0.85},
	{phrase: "burns supply", weight: 0.8},
	{phrase: "deflationary", weight: 0.7},
	{phrase: "lawsuit dismissed", weight: 1.1},
	{phrase: "charges dropped", weight: 1.0},
	{phrase: "license granted", weight: 0.85},
	{phrase: "regulatory clarity", weight: 0.85},
	{phrase: "ceasefire", weight: 0.6},
	{phrase: "rate cuts", weight: 0.55},
	{phrase: "liquidity injection", weight: 0.8},
}

var bearishHeadlinePhrases = []weightedPhrase{
	{phrase: "smart contract exploit", weight: 1.2},
	{phrase: "bridge exploit", weight: 1.2},
	{phrase: "hack", weight: 1.05},
	{phrase: "exploit", weight: 1.05},
	{phrase: "breach", weight: 0.95},
	{phrase: "drain", weight: 0.9},
	{phrase: "stolen", weight: 0.85},
	{phrase: "attack", weight: 0.7},
	{phrase: "record outflows", weight: 1.1},
	{phrase: "net outflows", weight: 0.95},
	{phrase: "outflows", weight: 0.7},
	{phrase: "redemptions", weight: 0.7},
	{phrase: "selloff", weight: 0.8},
	{phrase: "dump", weight: 0.7},
	{phrase: "capitulation", weight: 0.75},
	{phrase: "breakdown", weight: 0.7},
	{phrase: "breaks below", weight: 0.8},
	{phrase: "loses support", weight: 0.75},
	{phrase: "new low", weight: 0.7},
	{phrase: "long liquidation", weight: 0.95},
	{phrase: "liquidation", weight: 0.75},
	{phrase: "forced selling", weight: 0.9},
	{phrase: "bankruptcy", weight: 1.2},
	{phrase: "insolvent", weight: 1.1},
	{phrase: "restructuring", weight: 0.55},
	{phrase: "defaults", weight: 0.85},
	{phrase: "earnings miss", weight: 0.8},
	{phrase: "misses expectations", weight: 0.75},
	{phrase: "cuts guidance", weight: 0.85},
	{phrase: "weak guidance", weight: 0.75},
	{phrase: "profit warning", weight: 0.85},
	{phrase: "revenue falls", weight: 0.6},
	{phrase: "plunge", weight: 0.75},
	{phrase: "tumbles", weight: 0.65},
	{phrase: "crashes", weight: 0.8},
	{phrase: "delisting", weight: 1.0},
	{phrase: "suspends trading", weight: 1.0},
	{phrase: "halts withdrawals", weight: 1.15},
	{phrase: "withdrawals paused", weight: 1.05},
	{phrase: "shutdown", weight: 0.95},
	{phrase: "winds down", weight: 0.85},
	{phrase: "token unlock", weight: 0.7},
	{phrase: "large unlock", weight: 0.85},
	{phrase: "dilution", weight: 0.8},
	{phrase: "sec sues", weight: 1.15},
	{phrase: "lawsuit", weight: 0.75},
	{phrase: "probe", weight: 0.65},
	{phrase: "investigation", weight: 0.75},
	{phrase: "charged", weight: 0.75},
	{phrase: "fined", weight: 0.7},
	{phrase: "sanctions", weight: 0.75},
	{phrase: "ban", weight: 0.65},
	{phrase: "rejected", weight: 0.75},
	{phrase: "denied", weight: 0.65},
	{phrase: "regulatory crackdown", weight: 1.05},
	{phrase: "fraud", weight: 1.0},
	{phrase: "manipulation", weight: 0.8},
	{phrase: "rug pull", weight: 1.2},
	{phrase: "depeg", weight: 1.1},
	{phrase: "network outage", weight: 1.05},
	{phrase: "chain halted", weight: 1.1},
	{phrase: "downtime", weight: 0.7},
	{phrase: "security incident", weight: 0.95},
	{phrase: "whale selling", weight: 0.7},
	{phrase: "insider selling", weight: 0.8},
	{phrase: "rate hike", weight: 0.55},
	{phrase: "hawkish", weight: 0.45},
	{phrase: "war escalation", weight: 0.7},
	{phrase: "recession fears", weight: 0.55},
}

type newsLocale struct {
	HL   string
	GL   string
	CEID string
}

type googleNewsRSS struct {
	Channel struct {
		Items []googleNewsRSSItem `xml:"item"`
	} `xml:"channel"`
}

type googleNewsRSSItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	PublishedAt string `xml:"pubDate"`
	Source      struct {
		Name string `xml:",chardata"`
		URL  string `xml:"url,attr"`
	} `xml:"source"`
}

type genericRSS struct {
	Channel struct {
		Items []genericRSSItem `xml:"item"`
	} `xml:"channel"`
}

type genericRSSItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	PublishedAt string `xml:"pubDate"`
	Source      struct {
		Name string `xml:",chardata"`
	} `xml:"source"`
}

func (s *MarketDataService) GetNewsConfig() map[string]interface{} {
	provider := "google-news-rss"
	providers := []string{"google-news-rss"}
	if len(s.directNewsFeeds) > 0 {
		providers = append(providers, "direct-rss-atom")
	}
	if len(s.xNewsFeeds) > 0 {
		providers = append(providers, "x-rss")
	}
	if len(s.bskyNewsAccounts) > 0 {
		providers = append(providers, "bluesky")
	}
	provider = strings.Join(providers, "+")
	return map[string]interface{}{
		"configured":      true,
		"provider":        provider,
		"providers":       providers,
		"xEnabled":        len(s.xNewsFeeds) > 0,
		"xAccounts":       len(s.xNewsFeeds),
		"blueskyEnabled":  len(s.bskyNewsAccounts) > 0,
		"blueskyAccounts": len(s.bskyNewsAccounts),
		"directFeeds":     len(s.directNewsFeeds),
		"health":          s.GetNewsSourceHealth(),
	}
}

func (s *MarketDataService) GetNews(ctx context.Context, coins []string) (map[string][]*MarketNewsItem, error) {
	cacheKey := normalizedNewsBatchKey(coins)
	if cached, err, ok := s.getCachedNewsBatch(cacheKey); ok {
		return cached, err
	}

	normalizedCoins := make([]string, 0, len(coins))
	seen := map[string]struct{}{}
	for _, coin := range coins {
		normalized := normalizeNewsCoin(coin)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		normalizedCoins = append(normalizedCoins, normalized)
	}
	out := make(map[string][]*MarketNewsItem, len(normalizedCoins))
	var outMu sync.Mutex
	var firstErr error
	jobs := make(chan string)
	var wg sync.WaitGroup
	workers := 4
	if len(normalizedCoins) < workers {
		workers = len(normalizedCoins)
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for coin := range jobs {
				items, err := s.getNewsForCoin(ctx, coin)
				outMu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				if len(items) > 0 {
					out[coin] = items
				}
				outMu.Unlock()
			}
		}()
	}
	for _, coin := range normalizedCoins {
		jobs <- coin
	}
	close(jobs)
	wg.Wait()
	s.setCachedNewsBatch(cacheKey, out, firstErr)
	return out, firstErr
}

func normalizeNewsCoin(coin string) string {
	value := strings.TrimSpace(coin)
	if value == "" {
		return ""
	}
	upper := strings.ToUpper(value)
	if strings.HasPrefix(upper, "XYZ:") {
		return "xyz:" + strings.TrimPrefix(upper, "XYZ:")
	}
	if strings.HasPrefix(value, "k") && len(value) > 1 {
		return "k" + strings.ToUpper(value[1:])
	}
	return upper
}

func normalizedNewsBatchKey(coins []string) string {
	normalized := make([]string, 0, len(coins))
	for _, coin := range coins {
		coin = strings.TrimSpace(coin)
		if coin == "" {
			continue
		}
		normalized = append(normalized, normalizeNewsCoin(coin))
	}
	sort.Strings(normalized)
	return strings.Join(normalized, ",")
}

func cloneNewsItemsMap(items map[string][]*MarketNewsItem) map[string][]*MarketNewsItem {
	if items == nil {
		return map[string][]*MarketNewsItem{}
	}
	cloned := make(map[string][]*MarketNewsItem, len(items))
	for coin, entries := range items {
		cloned[coin] = append([]*MarketNewsItem(nil), entries...)
	}
	return cloned
}

func (s *MarketDataService) getCachedNewsBatch(key string) (map[string][]*MarketNewsItem, error, bool) {
	if key == "" {
		return nil, nil, false
	}
	s.newsMu.RLock()
	defer s.newsMu.RUnlock()
	entry, ok := s.newsBatchCache[key]
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, nil, false
	}
	var err error
	if entry.err != "" {
		err = fmt.Errorf("%s", entry.err)
	}
	return cloneNewsItemsMap(entry.items), err, true
}

func (s *MarketDataService) setCachedNewsBatch(key string, items map[string][]*MarketNewsItem, err error) {
	if key == "" {
		return
	}
	errText := ""
	if err != nil {
		errText = err.Error()
	}
	s.newsMu.Lock()
	now := time.Now()
	for cacheKey, entry := range s.newsBatchCache {
		if now.After(entry.expiresAt) {
			delete(s.newsBatchCache, cacheKey)
		}
	}
	if _, exists := s.newsBatchCache[key]; !exists && len(s.newsBatchCache) >= maxNewsBatchCacheEntries {
		var oldestKey string
		var oldest time.Time
		for cacheKey, entry := range s.newsBatchCache {
			if oldestKey == "" || entry.expiresAt.Before(oldest) {
				oldestKey, oldest = cacheKey, entry.expiresAt
			}
		}
		if oldestKey != "" {
			delete(s.newsBatchCache, oldestKey)
		}
	}
	s.newsBatchCache[key] = newsBatchCacheEntry{
		items:     cloneNewsItemsMap(items),
		err:       errText,
		expiresAt: now.Add(20 * time.Second),
	}
	s.newsMu.Unlock()
}

func (s *MarketDataService) getNewsForCoin(ctx context.Context, coin string) ([]*MarketNewsItem, error) {
	if items, ok := s.getCachedNews(coin); ok {
		return mergeNewsItems(items, s.directNewsForCoin(coin)), nil
	}
	s.newsMu.Lock()
	if flight := s.newsInFlight[coin]; flight != nil {
		s.newsMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return append([]*MarketNewsItem(nil), flight.items...), flight.err
		}
	}
	flight := &newsInFlight{done: make(chan struct{})}
	s.newsInFlight[coin] = flight
	s.newsMu.Unlock()

	flight.items, flight.err = s.fetchNewsForCoin(ctx, coin)
	s.newsMu.Lock()
	delete(s.newsInFlight, coin)
	close(flight.done)
	s.newsMu.Unlock()
	return append([]*MarketNewsItem(nil), flight.items...), flight.err
}

func (s *MarketDataService) fetchNewsForCoin(ctx context.Context, coin string) ([]*MarketNewsItem, error) {
	if items, ok := s.getCachedNews(coin); ok {
		return mergeNewsItems(items, s.directNewsForCoin(coin)), nil
	}

	query := buildNewsQuery(coin)
	if strings.TrimSpace(query.search) == "" {
		return nil, nil
	}

	items, err := s.fetchGoogleNewsForCoin(ctx, coin, query)
	s.recordNewsSourceHealth("google-news-rss", len(items), err, false)
	if err != nil {
		// Direct/streamed items are independent of Google. Preserve them during
		// an aggregator outage instead of turning a partial failure into an empty
		// Radar row.
		direct := s.directNewsForCoin(coin)
		if len(direct) > 0 {
			return direct, err
		}
		return nil, err
	}
	items = mergeNewsItems(items, s.directNewsForCoin(coin))
	s.setCachedNews(coin, items)
	return items, nil
}

func (s *MarketDataService) fetchGoogleNewsForCoin(ctx context.Context, coin string, query newsQuery) ([]*MarketNewsItem, error) {
	params := url.Values{}
	params.Set("q", query.search)
	params.Set("hl", query.locale.HL)
	params.Set("gl", query.locale.GL)
	params.Set("ceid", query.locale.CEID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://news.google.com/rss/search?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "PEZ-HL37/1.0 market-radar-news")
	req.Header.Set("Accept", "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1")

	resp, err := s.newsClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("news provider error: google news rss returned %d", resp.StatusCode)
	}

	var parsed googleNewsRSS
	if err := xml.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}

	items := pickBestNewsItems(coin, query, parsed.Channel.Items)
	for _, item := range items {
		s.enrichGoogleNewsItem(item)
	}
	return items, nil
}

func (s *MarketDataService) enrichGoogleNewsItem(item *MarketNewsItem) {
	if item == nil {
		return
	}
	item.Coins = []string{item.Coin}
	item.Scope = "coin"
	item.SourceTier = "aggregator"
	item.Verification = "reported"
	item.IngestedAt = time.Now().UTC().Format(time.RFC3339Nano)
	item.DetectedPrices = s.detectedPrices(item.Coins)
	item.ID = stableNewsID(item)
}

func (s *MarketDataService) getCachedNews(coin string) ([]*MarketNewsItem, bool) {
	s.newsMu.RLock()
	defer s.newsMu.RUnlock()
	entry, ok := s.newsCache[coin]
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, false
	}
	return entry.items, entry.found
}

func (s *MarketDataService) setCachedNews(coin string, items []*MarketNewsItem) {
	ttl := 30 * time.Second
	if len(items) > 0 {
		ttl = 45 * time.Second
	}
	s.newsMu.Lock()
	s.newsCache[coin] = newsCacheEntry{
		items:     items,
		expiresAt: time.Now().Add(ttl),
		found:     true,
	}
	s.newsMu.Unlock()
}

var usNewsLocale = newsLocale{HL: "en-US", GL: "US", CEID: "US:en"}

// newsProfiles maps an UPPERCASE trading symbol (including the "XYZ:" builder-dex
// prefix) to its news search profile. buildNewsQuery upper-cases the incoming
// coin, so the frontend's lowercase "xyz:" symbols resolve here.
//
// Two rules keep matching accurate:
//   - search queries are name-led — Google News indexes company/token names, not
//     tickers, so equities like xyz:SKHX must search "SK Hynix" to find anything.
//   - aliases carry the distinguishing names (and, for unambiguous tickers, the
//     ticker). Ambiguous common-word tokens (PUMP, MOVE, NOT…) deliberately omit
//     the bare ticker so the relevance filter does not match unrelated headlines
//     (the word "pump", "move", etc.). See aliasMatches in market_data_service.go.
var newsProfiles = map[string]newsQuery{
	// --- Major crypto (perp dex) ---
	"BTC":     {search: `("Bitcoin" OR BTC) when:3d`, aliases: []string{"bitcoin", "btc"}, locale: usNewsLocale},
	"ETH":     {search: `("Ethereum" OR ETH) when:3d`, aliases: []string{"ethereum", "eth"}, locale: usNewsLocale},
	"SOL":     {search: `("Solana" OR SOL) when:3d`, aliases: []string{"solana", "sol"}, locale: usNewsLocale},
	"XRP":     {search: `("XRP" OR Ripple) when:3d`, aliases: []string{"xrp", "ripple"}, locale: usNewsLocale},
	"HYPE":    {search: `("Hyperliquid" OR HYPE) when:3d`, aliases: []string{"hyperliquid"}, locale: usNewsLocale},
	"BNB":     {search: `("BNB" OR Binance Coin) when:3d`, aliases: []string{"binance coin", "bnb"}, locale: usNewsLocale},
	"INJ":     {search: `("Injective" OR INJ crypto) when:3d`, aliases: []string{"injective", "inj"}, locale: usNewsLocale},
	"ARB":     {search: `("Arbitrum" OR ARB crypto) when:3d`, aliases: []string{"arbitrum", "arb"}, locale: usNewsLocale},
	"LINK":    {search: `("Chainlink" OR LINK crypto) when:3d`, aliases: []string{"chainlink", "link"}, excludes: []string{"golf", "zelda"}, locale: usNewsLocale},
	"AVAX":    {search: `("Avalanche" OR AVAX crypto) when:3d`, aliases: []string{"avalanche", "avax"}, locale: usNewsLocale},
	"DOGE":    {search: `("Dogecoin" OR DOGE crypto) when:3d`, aliases: []string{"dogecoin", "doge"}, locale: usNewsLocale},
	"SUI":     {search: `("Sui" OR SUI crypto) when:3d`, aliases: []string{"sui"}, locale: usNewsLocale},
	"TIA":     {search: `("Celestia" OR TIA crypto) when:3d`, aliases: []string{"celestia", "tia"}, locale: usNewsLocale},
	"MATIC":   {search: `("Polygon" OR MATIC crypto) when:3d`, aliases: []string{"polygon", "matic"}, locale: usNewsLocale},
	"POL":     {search: `("Polygon" OR POL crypto) when:3d`, aliases: []string{"polygon"}, locale: usNewsLocale},
	"ATOM":    {search: `("Cosmos" OR ATOM crypto) when:3d`, aliases: []string{"cosmos", "atom"}, locale: usNewsLocale},
	"PEPE":    {search: `("PEPE coin" OR "Pepe cryptocurrency") when:3d`, aliases: []string{"pepe"}, locale: usNewsLocale},
	"DOT":     {search: `("Polkadot" OR DOT crypto) when:3d`, aliases: []string{"polkadot", "dot"}, locale: usNewsLocale},
	"UNI":     {search: `("Uniswap" OR UNI crypto) when:3d`, aliases: []string{"uniswap", "uni"}, locale: usNewsLocale},
	"LTC":     {search: `("Litecoin" OR LTC crypto) when:3d`, aliases: []string{"litecoin", "ltc"}, locale: usNewsLocale},
	"BCH":     {search: `("Bitcoin Cash" OR BCH crypto) when:3d`, aliases: []string{"bitcoin cash", "bch"}, locale: usNewsLocale},
	"NEAR":    {search: `("NEAR Protocol" OR NEAR crypto) when:3d`, aliases: []string{"near protocol", "near"}, locale: usNewsLocale},
	"APT":     {search: `("Aptos" OR APT crypto) when:3d`, aliases: []string{"aptos", "apt"}, locale: usNewsLocale},
	"OP":      {search: `("Optimism" OR OP crypto) when:3d`, aliases: []string{"optimism crypto", "optimism token"}, locale: usNewsLocale},
	"TAO":     {search: `("Bittensor" OR TAO crypto) when:3d`, aliases: []string{"bittensor", "tao"}, locale: usNewsLocale},
	"SEI":     {search: `("Sei Network" OR SEI crypto) when:3d`, aliases: []string{"sei network", "sei"}, locale: usNewsLocale},
	"RUNE":    {search: `("THORChain" OR RUNE crypto) when:3d`, aliases: []string{"thorchain", "rune"}, locale: usNewsLocale},
	"FET":     {search: `("Fetch.ai" OR FET crypto) when:3d`, aliases: []string{"fetch.ai", "fet"}, locale: usNewsLocale},
	"WIF":     {search: `("dogwifhat" OR WIF crypto) when:3d`, aliases: []string{"dogwifhat", "wif"}, locale: usNewsLocale},
	"FLOKI":   {search: `("Floki" OR FLOKI crypto) when:3d`, aliases: []string{"floki"}, locale: usNewsLocale},
	"BONK":    {search: `("Bonk" OR BONK crypto) when:3d`, aliases: []string{"bonk"}, locale: usNewsLocale},
	"BOME":    {search: `("Book of Meme" OR BOME crypto) when:3d`, aliases: []string{"book of meme", "bome"}, locale: usNewsLocale},
	"ADA":     {search: `("Cardano" OR ADA crypto) when:3d`, aliases: []string{"cardano", "ada"}, locale: usNewsLocale},
	"SHIB":    {search: `("Shiba Inu" OR SHIB crypto) when:3d`, aliases: []string{"shiba inu", "shib"}, locale: usNewsLocale},
	"AAVE":    {search: `("Aave" OR AAVE crypto) when:3d`, aliases: []string{"aave"}, locale: usNewsLocale},
	"MKR":     {search: `("Maker" OR MakerDAO OR MKR crypto) when:3d`, aliases: []string{"makerdao", "maker dao", "mkr"}, locale: usNewsLocale},
	"CRV":     {search: `("Curve Finance" OR CRV crypto) when:3d`, aliases: []string{"curve finance", "crv"}, locale: usNewsLocale},
	"LDO":     {search: `("Lido" OR LDO crypto) when:3d`, aliases: []string{"lido", "ldo"}, locale: usNewsLocale},
	"RENDER":  {search: `("Render Network" OR RENDER crypto) when:3d`, aliases: []string{"render network", "render token"}, locale: usNewsLocale},
	"RNDR":    {search: `("Render Network" OR RNDR crypto) when:3d`, aliases: []string{"render network", "rndr"}, locale: usNewsLocale},
	"ENS":     {search: `("Ethereum Name Service" OR ENS crypto) when:3d`, aliases: []string{"ethereum name service", "ens crypto"}, locale: usNewsLocale},
	"JUP":     {search: `("Jupiter" OR JUP crypto) when:3d`, aliases: []string{"jupiter exchange", "jupiter dex", "jup"}, locale: usNewsLocale},
	"PYTH":    {search: `("Pyth Network" OR PYTH crypto) when:3d`, aliases: []string{"pyth network", "pyth"}, locale: usNewsLocale},
	"JTO":     {search: `("Jito" OR JTO crypto) when:3d`, aliases: []string{"jito", "jto"}, locale: usNewsLocale},
	"WLD":     {search: `("Worldcoin" OR World Network OR WLD crypto) when:3d`, aliases: []string{"worldcoin", "world network"}, locale: usNewsLocale},
	"ENA":     {search: `("Ethena" OR ENA crypto) when:3d`, aliases: []string{"ethena", "ena"}, locale: usNewsLocale},
	"ONDO":    {search: `("Ondo Finance" OR ONDO crypto) when:3d`, aliases: []string{"ondo finance", "ondo"}, locale: usNewsLocale},
	"TON":     {search: `("Toncoin" OR TON crypto) when:3d`, aliases: []string{"toncoin"}, locale: usNewsLocale},
	"HBAR":    {search: `("Hedera" OR HBAR crypto) when:3d`, aliases: []string{"hedera", "hbar"}, locale: usNewsLocale},
	"XLM":     {search: `("Stellar Lumens" OR XLM crypto) when:3d`, aliases: []string{"stellar lumens", "stellar crypto", "xlm"}, locale: usNewsLocale},
	"ICP":     {search: `("Internet Computer" OR ICP crypto) when:3d`, aliases: []string{"internet computer", "icp"}, locale: usNewsLocale},
	"ALGO":    {search: `("Algorand" OR ALGO crypto) when:3d`, aliases: []string{"algorand", "algo"}, locale: usNewsLocale},
	"FIL":     {search: `("Filecoin" OR FIL crypto) when:3d`, aliases: []string{"filecoin", "fil"}, locale: usNewsLocale},
	"TURBO":   {search: `("Turbo" OR TURBO crypto) when:3d`, aliases: []string{"turbo coin", "turbo crypto"}, locale: usNewsLocale},
	"VIRTUAL": {search: `("Virtuals Protocol" OR VIRTUAL crypto) when:3d`, aliases: []string{"virtuals protocol", "virtuals"}, locale: usNewsLocale},
	"AI16Z":   {search: `("ai16z" OR "ai16z crypto") when:3d`, aliases: []string{"ai16z"}, locale: usNewsLocale},
	"AIXBT":   {search: `("aixbt") when:3d`, aliases: []string{"aixbt"}, locale: usNewsLocale},

	// --- Ambiguous common-word / meme tokens (no bare-ticker alias on purpose) ---
	"PUMP":     {search: `("pump.fun" OR Pumpfun) when:3d`, aliases: []string{"pump.fun", "pumpfun"}, locale: usNewsLocale},
	"TRUMP":    {search: `("Official Trump" OR "TRUMP coin" OR "TRUMP token") when:3d`, aliases: []string{"official trump", "trump coin", "trump token", "trump meme"}, locale: usNewsLocale},
	"MELANIA":  {search: `("Melania Meme" OR "MELANIA coin" OR "MELANIA token") when:3d`, aliases: []string{"melania meme", "melania coin", "melania token"}, locale: usNewsLocale},
	"FARTCOIN": {search: `("Fartcoin") when:3d`, aliases: []string{"fartcoin"}, locale: usNewsLocale},
	"PENGU":    {search: `("Pudgy Penguins" OR "PENGU token") when:3d`, aliases: []string{"pudgy penguins", "pengu"}, locale: usNewsLocale},
	"POPCAT":   {search: `("Popcat" OR "Popcat crypto") when:3d`, aliases: []string{"popcat"}, locale: usNewsLocale},
	"MOODENG":  {search: `("Moo Deng" OR Moodeng crypto) when:3d`, aliases: []string{"moo deng", "moodeng"}, locale: usNewsLocale},
	"PNUT":     {search: `("Peanut the Squirrel" OR "PNUT crypto") when:3d`, aliases: []string{"peanut the squirrel", "pnut"}, locale: usNewsLocale},
	"CHILLGUY": {search: `("Chill Guy" OR Chillguy crypto) when:3d`, aliases: []string{"chill guy", "chillguy"}, locale: usNewsLocale},
	"BRETT":    {search: `("Brett coin" OR "Brett crypto") when:3d`, aliases: []string{"brett coin", "brett crypto"}, locale: usNewsLocale},
	"MEW":      {search: `("cat in a dogs world" OR "MEW crypto") when:3d`, aliases: []string{"cat in a dogs world", "mew coin"}, locale: usNewsLocale},
	"GOAT":     {search: `("Goatseus Maximus" OR "GOAT crypto") when:3d`, aliases: []string{"goatseus maximus", "goatseus"}, locale: usNewsLocale},
	"BERA":     {search: `("Berachain") when:3d`, aliases: []string{"berachain"}, locale: usNewsLocale},
	"SAND":     {search: `("The Sandbox" OR "Sandbox crypto") when:3d`, aliases: []string{"the sandbox", "sandbox crypto"}, locale: usNewsLocale},
	"GALA":     {search: `("Gala Games" OR "GALA crypto") when:3d`, aliases: []string{"gala games", "gala crypto"}, locale: usNewsLocale},
	"SKY":      {search: `("Sky Protocol" OR "Sky crypto" OR MakerDAO) when:3d`, aliases: []string{"sky protocol", "sky crypto"}, locale: usNewsLocale},
	"S":        {search: `("Sonic Labs" OR "Sonic crypto" OR "Sonic blockchain") when:3d`, aliases: []string{"sonic labs", "sonic crypto", "sonic blockchain"}, locale: usNewsLocale},
	"ME":       {search: `("Magic Eden") when:3d`, aliases: []string{"magic eden"}, locale: usNewsLocale},
	"MOVE":     {search: `("Movement Labs" OR "Movement crypto") when:3d`, aliases: []string{"movement labs", "movement crypto"}, locale: usNewsLocale},
	"NOT":      {search: `("Notcoin") when:3d`, aliases: []string{"notcoin"}, locale: usNewsLocale},
	"IO":       {search: `("io.net") when:3d`, aliases: []string{"io.net"}, locale: usNewsLocale},
	"IP":       {search: `("Story Protocol" OR "IP token crypto") when:3d`, aliases: []string{"story protocol"}, locale: usNewsLocale},
	"W":        {search: `("Wormhole crypto" OR "Wormhole token") when:3d`, aliases: []string{"wormhole"}, locale: usNewsLocale},
	"OM":       {search: `("Mantra" OR "OM token crypto") when:3d`, aliases: []string{"mantra crypto", "mantra om"}, locale: usNewsLocale},
	"BABY":     {search: `("Babylon" OR "BABY token crypto") when:3d`, aliases: []string{"babylon crypto", "babylon token"}, locale: usNewsLocale},
	"VINE":     {search: `("Vine coin" OR "Vine crypto") when:3d`, aliases: []string{"vine coin", "vine crypto"}, locale: usNewsLocale},

	// --- xyz builder-dex: US equities ---
	"XYZ:TSLA":  {search: `("Tesla" OR TSLA) when:3d`, aliases: []string{"tesla", "tsla"}, locale: usNewsLocale},
	"XYZ:NVDA":  {search: `("Nvidia" OR NVDA) when:3d`, aliases: []string{"nvidia", "nvda"}, locale: usNewsLocale},
	"XYZ:AAPL":  {search: `("Apple" OR AAPL) when:3d`, aliases: []string{"apple", "aapl"}, locale: usNewsLocale},
	"XYZ:MSFT":  {search: `("Microsoft" OR MSFT) when:3d`, aliases: []string{"microsoft", "msft"}, locale: usNewsLocale},
	"XYZ:GOOGL": {search: `("Alphabet" OR Google OR GOOGL) when:3d`, aliases: []string{"alphabet", "google", "googl"}, locale: usNewsLocale},
	"XYZ:AMZN":  {search: `("Amazon" OR AMZN) when:3d`, aliases: []string{"amazon", "amzn"}, locale: usNewsLocale},
	"XYZ:META":  {search: `("Meta Platforms" OR META) when:3d`, aliases: []string{"meta platforms", "meta"}, locale: usNewsLocale},
	"XYZ:ORCL":  {search: `("Oracle" OR ORCL) when:3d`, aliases: []string{"oracle corp", "oracle stock", "orcl"}, locale: usNewsLocale},
	"XYZ:AMD":   {search: `("AMD" OR "Advanced Micro Devices") when:3d`, aliases: []string{"advanced micro devices", "amd"}, locale: usNewsLocale},
	"XYZ:INTC":  {search: `("Intel" OR INTC) when:3d`, aliases: []string{"intel", "intc"}, locale: usNewsLocale},
	"XYZ:MU":    {search: `("Micron" OR MU stock) when:3d`, aliases: []string{"micron"}, locale: usNewsLocale},
	"XYZ:QCOM":  {search: `("Qualcomm" OR QCOM) when:3d`, aliases: []string{"qualcomm", "qcom"}, locale: usNewsLocale},
	"XYZ:AVGO":  {search: `("Broadcom" OR AVGO) when:3d`, aliases: []string{"broadcom", "avgo"}, locale: usNewsLocale},
	"XYZ:MRVL":  {search: `("Marvell Technology" OR MRVL) when:3d`, aliases: []string{"marvell", "mrvl"}, locale: usNewsLocale},
	"XYZ:WDC":   {search: `("Western Digital" OR WDC) when:3d`, aliases: []string{"western digital", "wdc"}, locale: usNewsLocale},
	"XYZ:SNDK":  {search: `("SanDisk" OR SNDK) when:3d`, aliases: []string{"sandisk", "sndk"}, locale: usNewsLocale},
	"XYZ:DELL":  {search: `("Dell Technologies" OR DELL) when:3d`, aliases: []string{"dell technologies", "dell stock"}, locale: usNewsLocale},
	"XYZ:IBM":   {search: `("IBM" OR "International Business Machines") when:3d`, aliases: []string{"ibm", "international business machines"}, locale: usNewsLocale},
	"XYZ:NOW":   {search: `("ServiceNow" OR NOW stock) when:3d`, aliases: []string{"servicenow"}, locale: usNewsLocale},
	"XYZ:NFLX":  {search: `("Netflix" OR NFLX) when:3d`, aliases: []string{"netflix", "nflx"}, locale: usNewsLocale},
	"XYZ:ZM":    {search: `("Zoom Video" OR "Zoom Communications") when:3d`, aliases: []string{"zoom video", "zoom communications"}, locale: usNewsLocale},
	"XYZ:EBAY":  {search: `("eBay" OR EBAY) when:3d`, aliases: []string{"ebay"}, locale: usNewsLocale},
	"XYZ:COST":  {search: `("Costco" OR COST stock) when:3d`, aliases: []string{"costco"}, locale: usNewsLocale},
	"XYZ:LLY":   {search: `("Eli Lilly" OR LLY) when:3d`, aliases: []string{"eli lilly", "lly"}, locale: usNewsLocale},
	"XYZ:HIMS":  {search: `("Hims & Hers" OR HIMS) when:3d`, aliases: []string{"hims & hers", "hims and hers", "hims"}, locale: usNewsLocale},
	"XYZ:HOOD":  {search: `("Robinhood" OR HOOD) when:3d`, aliases: []string{"robinhood", "hood stock"}, locale: usNewsLocale},
	"XYZ:COIN":  {search: `("Coinbase" OR COIN stock) when:3d`, aliases: []string{"coinbase"}, locale: usNewsLocale},
	"XYZ:MSTR":  {search: `("Strategy" OR MicroStrategy OR MSTR) when:3d`, aliases: []string{"microstrategy", "mstr"}, locale: usNewsLocale},
	"XYZ:CRCL":  {search: `("Circle Internet" OR "Circle stock" OR "Circle IPO") when:3d`, aliases: []string{"circle internet", "circle stock", "circle ipo"}, locale: usNewsLocale},
	"XYZ:PLTR":  {search: `("Palantir" OR PLTR) when:3d`, aliases: []string{"palantir", "pltr"}, locale: usNewsLocale},
	"XYZ:CRWV":  {search: `("CoreWeave" OR CRWV) when:3d`, aliases: []string{"coreweave", "crwv"}, locale: usNewsLocale},
	"XYZ:NBIS":  {search: `("Nebius" OR NBIS) when:3d`, aliases: []string{"nebius", "nbis"}, locale: usNewsLocale},
	"XYZ:RKLB":  {search: `("Rocket Lab" OR RKLB) when:3d`, aliases: []string{"rocket lab", "rklb"}, locale: usNewsLocale},
	"XYZ:DKNG":  {search: `("DraftKings" OR DKNG) when:3d`, aliases: []string{"draftkings", "dkng"}, locale: usNewsLocale},
	"XYZ:GME":   {search: `("GameStop" OR GME) when:3d`, aliases: []string{"gamestop", "gme"}, locale: usNewsLocale},
	"XYZ:RIVN":  {search: `("Rivian" OR RIVN) when:3d`, aliases: []string{"rivian", "rivn"}, locale: usNewsLocale},
	"XYZ:BX":    {search: `("Blackstone" OR BX stock) when:3d`, aliases: []string{"blackstone"}, locale: usNewsLocale},
	"XYZ:USAR":  {search: `("USA Rare Earth" OR USAR) when:3d`, aliases: []string{"usa rare earth", "usar"}, locale: usNewsLocale},
	"XYZ:LITE":  {search: `("Lumentum" OR LITE stock) when:3d`, aliases: []string{"lumentum"}, locale: usNewsLocale},
	"XYZ:BE":    {search: `("Bloom Energy" OR BE stock) when:3d`, aliases: []string{"bloom energy"}, locale: usNewsLocale},
	"XYZ:BB":    {search: `("BlackBerry" OR BB stock) when:3d`, aliases: []string{"blackberry"}, locale: usNewsLocale},
	"XYZ:BIRD":  {search: `("Allbirds" OR BIRD stock) when:3d`, aliases: []string{"allbirds"}, locale: usNewsLocale},
	"XYZ:SPCX":  {search: `("SpaceX" OR SPCX) when:3d`, aliases: []string{"spacex"}, locale: usNewsLocale},

	// --- xyz builder-dex: foreign equities ---
	"XYZ:SKHX":     {search: `("SK Hynix" OR SKHynix) when:3d`, aliases: []string{"sk hynix", "skhynix"}, locale: usNewsLocale},
	"XYZ:SMSN":     {search: `("Samsung Electronics" OR Samsung) when:3d`, aliases: []string{"samsung"}, locale: usNewsLocale},
	"XYZ:TSM":      {search: `("Taiwan Semiconductor" OR TSMC) when:3d`, aliases: []string{"taiwan semiconductor", "tsmc"}, locale: usNewsLocale},
	"XYZ:ASML":     {search: `("ASML" OR "ASML Holding") when:3d`, aliases: []string{"asml"}, locale: usNewsLocale},
	"XYZ:ARM":      {search: `("Arm Holdings" OR "ARM stock") when:3d`, aliases: []string{"arm holdings"}, locale: usNewsLocale},
	"XYZ:NOK":      {search: `("Nokia" OR NOK stock) when:3d`, aliases: []string{"nokia"}, locale: usNewsLocale},
	"XYZ:BABA":     {search: `("Alibaba" OR BABA) when:3d`, aliases: []string{"alibaba", "baba"}, locale: usNewsLocale},
	"XYZ:KIOXIA":   {search: `("Kioxia") when:3d`, aliases: []string{"kioxia"}, locale: usNewsLocale},
	"XYZ:SOFTBANK": {search: `("SoftBank") when:3d`, aliases: []string{"softbank"}, locale: usNewsLocale},
	"XYZ:HYUNDAI":  {search: `("Hyundai Motor" OR Hyundai) when:3d`, aliases: []string{"hyundai"}, locale: usNewsLocale},
	"XYZ:ZHIPU":    {search: `("Zhipu AI") when:3d`, aliases: []string{"zhipu"}, locale: usNewsLocale},
	"XYZ:MINIMAX":  {search: `("MiniMax AI") when:3d`, aliases: []string{"minimax"}, locale: usNewsLocale},
	"XYZ:DRAM":     {search: `("DRAM prices" OR "memory chip prices") when:3d`, aliases: []string{"dram"}, locale: usNewsLocale},

	// --- xyz builder-dex: indices ---
	"XYZ:XYZ100": {search: `("Nasdaq 100" OR NDX) when:3d`, aliases: []string{"nasdaq 100", "nasdaq", "ndx", "tech stocks"}, locale: usNewsLocale},
	"XYZ:SP500":  {search: `("S&P 500" OR "SP 500" OR SPX) when:3d`, aliases: []string{"s&p 500", "sp 500", "spx", "wall street", "u.s. stocks", "us stocks"}, locale: usNewsLocale},
	"XYZ:KR200":  {search: `("KOSPI 200" OR KOSPI) when:3d`, aliases: []string{"kospi"}, locale: usNewsLocale},
	"XYZ:JP225":  {search: `("Nikkei 225" OR Nikkei) when:3d`, aliases: []string{"nikkei"}, locale: usNewsLocale},

	// --- xyz builder-dex: ETFs ---
	"XYZ:EWY":  {search: `("iShares MSCI South Korea ETF" OR "Korea ETF") when:3d`, aliases: []string{"south korea etf", "korea etf"}, locale: usNewsLocale},
	"XYZ:EWJ":  {search: `("iShares MSCI Japan ETF" OR "Japan ETF") when:3d`, aliases: []string{"japan etf"}, locale: usNewsLocale},
	"XYZ:EWZ":  {search: `("iShares MSCI Brazil ETF" OR "Brazil ETF") when:3d`, aliases: []string{"brazil etf"}, locale: usNewsLocale},
	"XYZ:EWT":  {search: `("iShares MSCI Taiwan ETF" OR "Taiwan ETF") when:3d`, aliases: []string{"taiwan etf"}, locale: usNewsLocale},
	"XYZ:XLE":  {search: `("Energy Select Sector" OR "energy stocks") when:3d`, aliases: []string{"energy select sector", "energy stocks"}, locale: usNewsLocale},
	"XYZ:SMH":  {search: `("VanEck Semiconductor ETF" OR "semiconductor stocks") when:3d`, aliases: []string{"semiconductor etf", "semiconductor stocks"}, locale: usNewsLocale},
	"XYZ:URNM": {search: `("uranium miners" OR "Sprott Uranium") when:3d`, aliases: []string{"uranium miners", "sprott uranium"}, locale: usNewsLocale},

	// --- xyz builder-dex: commodities ---
	"XYZ:GOLD":      {search: `("gold price" OR gold futures) when:3d`, aliases: []string{"gold"}, locale: usNewsLocale},
	"XYZ:SILVER":    {search: `("silver price" OR silver futures) when:3d`, aliases: []string{"silver"}, locale: usNewsLocale},
	"XYZ:PLATINUM":  {search: `("platinum price" OR platinum futures) when:3d`, aliases: []string{"platinum"}, locale: usNewsLocale},
	"XYZ:PALLADIUM": {search: `("palladium price" OR palladium futures) when:3d`, aliases: []string{"palladium"}, locale: usNewsLocale},
	"XYZ:COPPER":    {search: `("copper price" OR copper futures) when:3d`, aliases: []string{"copper"}, locale: usNewsLocale},
	"XYZ:NATGAS":    {search: `("natural gas price" OR "natural gas futures") when:3d`, aliases: []string{"natural gas"}, locale: usNewsLocale},
	"XYZ:CL":        {search: `("WTI crude oil" OR "crude oil futures") when:3d`, aliases: []string{"wti", "crude oil", "oil"}, locale: usNewsLocale},
	"XYZ:BRENTOIL":  {search: `("Brent crude oil" OR "Brent oil price") when:3d`, aliases: []string{"brent crude", "brent oil"}, locale: usNewsLocale},

	// --- xyz builder-dex: FX ---
	"XYZ:JPY": {search: `("USD/JPY" OR "yen" OR "Bank of Japan") when:3d`, aliases: []string{"usd/jpy", "yen", "bank of japan"}, locale: usNewsLocale},
	"XYZ:EUR": {search: `("EUR/USD" OR "euro currency" OR "European Central Bank") when:3d`, aliases: []string{"eur/usd", "euro currency", "european central bank"}, locale: usNewsLocale},
	"XYZ:GBP": {search: `("GBP/USD" OR "British pound" OR "Bank of England") when:3d`, aliases: []string{"gbp/usd", "british pound", "bank of england"}, locale: usNewsLocale},
}

func buildNewsQuery(coin string) newsQuery {
	trimmed := strings.TrimSpace(coin)
	if trimmed == "" {
		return newsQuery{}
	}
	symbol := strings.ToUpper(trimmed)
	if profile, ok := newsProfiles[symbol]; ok {
		return profile
	}
	// Normalize Hyperliquid "1000x" k-prefixed perps (kPEPE, kSHIB, kBONK…) to
	// their base token profile.
	if strings.HasPrefix(trimmed, "k") && len(trimmed) > 1 {
		if profile, ok := newsProfiles[strings.ToUpper(trimmed[1:])]; ok {
			return profile
		}
	}
	// Improved default fallback. Qualify the search so the provider returns the
	// right context, and keep a single short ticker alias (word-boundary matched
	// in aliasMatches) so we still filter to relevant headlines.
	if strings.HasPrefix(symbol, "XYZ:") {
		ticker := strings.TrimPrefix(symbol, "XYZ:")
		return newsQuery{
			search:  fmt.Sprintf(`("%s" stock OR shares) when:3d`, ticker),
			aliases: []string{strings.ToLower(ticker)},
			locale:  usNewsLocale,
		}
	}
	return newsQuery{
		search:  fmt.Sprintf(`("%s" crypto OR token OR coin) when:3d`, symbol),
		aliases: []string{strings.ToLower(symbol)},
		locale:  usNewsLocale,
	}
}
