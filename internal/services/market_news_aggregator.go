package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	directNewsPollInterval      = 20 * time.Second
	directNewsFailureBackoff    = time.Minute
	directNewsFailureBackoffMax = 30 * time.Minute
	maxDirectFeedBody           = 2 << 20
	maxStoredNewsPerCoin        = 100
	maxStoredGlobalNews         = 5000
	newsRetention               = 72 * time.Hour
)

var (
	newsFetchTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_news_fetch_total", Help: "News source refresh outcomes by provider.",
	}, []string{"provider", "result"})
	newsIngestedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pez_news_ingested_total", Help: "Unique news items ingested by source tier.",
	}, []string{"tier"})
	newsSourceLagSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "pez_news_source_lag_seconds", Help: "Publication-to-ingestion lag by provider.",
		Buckets: prometheus.ExponentialBuckets(1, 2, 14),
	}, []string{"provider"})
	newsCacheItems = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "pez_news_cache_items", Help: "Unique retained news fingerprints.",
	})
)

func init() {
	prometheus.MustRegister(newsFetchTotal, newsIngestedTotal, newsSourceLagSeconds, newsCacheItems)
}

type newsFeedState struct {
	Name                string
	URL                 string
	SourceTier          string
	ETag                string
	LastModified        string
	ConsecutiveFailures int
	RetryAt             time.Time
}

type atomFeed struct {
	Title   string          `xml:"title"`
	Entries []atomFeedEntry `xml:"entry"`
}

type atomFeedEntry struct {
	Title     string `xml:"title"`
	Summary   string `xml:"summary"`
	Content   string `xml:"content"`
	Updated   string `xml:"updated"`
	Published string `xml:"published"`
	Links     []struct {
		Href string `xml:"href,attr"`
		Rel  string `xml:"rel,attr"`
	} `xml:"link"`
}

type normalizedFeedItem struct {
	Headline    string
	Description string
	URL         string
	Source      string
	PublishedAt string
}

var defaultDirectNewsFeeds = []newsFeedState{
	{Name: "CoinDesk", URL: "https://www.coindesk.com/arc/outboundfeeds/rss/", SourceTier: "publisher"},
	{Name: "Decrypt", URL: "https://decrypt.co/feed", SourceTier: "publisher"},
	{Name: "Cointelegraph", URL: "https://cointelegraph.com/rss", SourceTier: "publisher"},
	{Name: "CryptoSlate", URL: "https://cryptoslate.com/feed/", SourceTier: "publisher"},
	{Name: "Bloomberg Markets", URL: "https://feeds.bloomberg.com/markets/news.rss", SourceTier: "publisher"},
	{Name: "U.S. SEC", URL: "https://www.sec.gov/news/pressreleases.rss", SourceTier: "official"},
	{Name: "U.S. CFTC", URL: "https://www.cftc.gov/RSS/RSSENF/rssenf.xml", SourceTier: "official"},
	{Name: "Federal Reserve", URL: "https://www.federalreserve.gov/feeds/press_all.xml", SourceTier: "official"},
	{Name: "U.S. EIA", URL: "https://www.eia.gov/rss/todayinenergy.xml", SourceTier: "official"},
	{Name: "U.S. EIA Press", URL: "https://www.eia.gov/rss/press_rss.xml", SourceTier: "official"},
	{Name: "European Central Bank", URL: "https://www.ecb.europa.eu/rss/press.html", SourceTier: "official"},
}

func buildDirectNewsFeeds(extra []string) []*newsFeedState {
	feeds := make([]*newsFeedState, 0, len(defaultDirectNewsFeeds)+len(extra))
	seen := map[string]struct{}{}
	appendFeed := func(feed newsFeedState) {
		parsed, err := url.Parse(strings.TrimSpace(feed.URL))
		if err != nil || !safeNewsURL(parsed) {
			return
		}
		key := strings.ToLower(parsed.String())
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		copy := feed
		feeds = append(feeds, &copy)
	}
	for _, feed := range defaultDirectNewsFeeds {
		appendFeed(feed)
	}
	for _, raw := range extra {
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			continue
		}
		appendFeed(newsFeedState{Name: parsed.Hostname(), URL: parsed.String(), SourceTier: "publisher"})
	}
	return feeds
}

func safeNewsURL(parsed *url.URL) bool {
	if parsed == nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Hostname() == "" {
		return false
	}
	if ip := net.ParseIP(parsed.Hostname()); ip != nil {
		return !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsUnspecified() && !ip.IsLinkLocalUnicast()
	}
	return !strings.EqualFold(parsed.Hostname(), "localhost")
}

func normalizeNewsAccounts(accounts []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(accounts))
	for _, raw := range accounts {
		value := strings.TrimSpace(strings.TrimPrefix(raw, "@"))
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func (s *MarketDataService) SetNewsSink(sink func([]*MarketNewsItem)) {
	s.newsMu.Lock()
	s.newsSink = sink
	s.newsMu.Unlock()
}

func (s *MarketDataService) StartNewsAggregator(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	if len(s.directNewsFeeds) > 0 || len(s.xNewsFeeds) > 0 {
		go s.runDirectNewsLoop(ctx)
	}
	if len(s.bskyNewsAccounts) > 0 {
		go s.runBlueskyNewsLoop(ctx)
	}
}

func (s *MarketDataService) runDirectNewsLoop(ctx context.Context) {
	s.refreshDirectNews(ctx)
	ticker := time.NewTicker(directNewsPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.refreshDirectNews(ctx)
		}
	}
}

func (s *MarketDataService) refreshDirectNews(ctx context.Context) {
	s.refreshDirectNewsAt(ctx, time.Now())
}

func (s *MarketDataService) refreshDirectNewsAt(ctx context.Context, now time.Time) {
	for _, feed := range s.directNewsFeeds {
		if now.Before(feed.RetryAt) {
			continue
		}
		items, notModified, err := s.fetchDirectFeed(ctx, feed)
		s.recordNewsSourceHealth(feed.Name, len(items), err, notModified)
		if err != nil {
			feed.ConsecutiveFailures++
			feed.RetryAt = now.Add(directNewsRetryDelay(feed.ConsecutiveFailures))
			continue
		}
		feed.ConsecutiveFailures = 0
		feed.RetryAt = time.Time{}
		if notModified || len(items) == 0 {
			continue
		}
		s.publishNewNews(s.ingestNewsItems(s.classifyFeedItems(items, feed.SourceTier, "rss")))
	}
	// Legacy X mirrors are fetched once per cycle, then classified across every
	// market. This replaces the old N feeds × M requested coins fan-out.
	for _, feed := range s.xNewsFeeds {
		items, err := s.fetchGenericFeed(ctx, feed.url, "@"+feed.handle)
		s.recordNewsSourceHealth("x:"+feed.handle, len(items), err, false)
		if err != nil || len(items) == 0 {
			continue
		}
		classified := s.classifyFeedItems(items, "social", "x-rss")
		for _, item := range classified {
			item.Verification = "unverified"
			item.URL = canonicalizeXLink(item.URL, feed.handle)
		}
		s.publishNewNews(s.ingestNewsItems(classified))
	}
}

func directNewsRetryDelay(consecutiveFailures int) time.Duration {
	if consecutiveFailures <= 1 {
		return directNewsFailureBackoff
	}
	delay := directNewsFailureBackoff
	for i := 1; i < consecutiveFailures && delay < directNewsFailureBackoffMax; i++ {
		delay *= 2
	}
	if delay > directNewsFailureBackoffMax {
		return directNewsFailureBackoffMax
	}
	return delay
}

func (s *MarketDataService) fetchDirectFeed(ctx context.Context, feed *newsFeedState) ([]normalizedFeedItem, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feed.URL, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", "PEZ market-radar/2.0")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml")
	if feed.ETag != "" {
		req.Header.Set("If-None-Match", feed.ETag)
	}
	if feed.LastModified != "" {
		req.Header.Set("If-Modified-Since", feed.LastModified)
	}
	client := *s.newsClient
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many news feed redirects")
		}
		if !safeNewsURL(next.URL) {
			return fmt.Errorf("unsafe news feed redirect")
		}
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, true, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("feed returned %d", resp.StatusCode)
	}
	feed.ETag = strings.TrimSpace(resp.Header.Get("ETag"))
	feed.LastModified = strings.TrimSpace(resp.Header.Get("Last-Modified"))
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDirectFeedBody+1))
	if err != nil {
		return nil, false, err
	}
	if len(body) > maxDirectFeedBody {
		return nil, false, fmt.Errorf("feed body exceeds %d bytes", maxDirectFeedBody)
	}
	items, err := parseSyndicationFeed(body, feed.Name)
	return items, false, err
}

func (s *MarketDataService) fetchGenericFeed(ctx context.Context, feedURL, source string) ([]normalizedFeedItem, error) {
	feed := &newsFeedState{Name: source, URL: feedURL, SourceTier: "social"}
	items, _, err := s.fetchDirectFeed(ctx, feed)
	return items, err
}

func parseSyndicationFeed(body []byte, fallbackSource string) ([]normalizedFeedItem, error) {
	var rss genericRSS
	if err := xml.Unmarshal(body, &rss); err == nil && len(rss.Channel.Items) > 0 {
		out := make([]normalizedFeedItem, 0, len(rss.Channel.Items))
		for _, item := range rss.Channel.Items {
			source := strings.TrimSpace(item.Source.Name)
			if source == "" {
				source = fallbackSource
			}
			out = append(out, normalizedFeedItem{
				Headline:    cleanRSSHeadline(item.Title),
				Description: cleanNewsDescription(item.Description, item.Title),
				URL:         strings.TrimSpace(item.Link), Source: source,
				PublishedAt: strings.TrimSpace(item.PublishedAt),
			})
		}
		return out, nil
	}
	var atom atomFeed
	if err := xml.Unmarshal(body, &atom); err != nil {
		return nil, err
	}
	out := make([]normalizedFeedItem, 0, len(atom.Entries))
	for _, entry := range atom.Entries {
		link := ""
		for _, candidate := range entry.Links {
			if candidate.Rel == "" || candidate.Rel == "alternate" {
				link = strings.TrimSpace(candidate.Href)
				break
			}
		}
		published := strings.TrimSpace(entry.Published)
		if published == "" {
			published = strings.TrimSpace(entry.Updated)
		}
		description := entry.Summary
		if strings.TrimSpace(description) == "" {
			description = entry.Content
		}
		out = append(out, normalizedFeedItem{
			Headline:    cleanRSSHeadline(entry.Title),
			Description: cleanNewsDescription(description, entry.Title),
			URL:         link, Source: fallbackSource, PublishedAt: published,
		})
	}
	return out, nil
}

func isAcceptableNewsTime(raw string) (time.Time, bool) {
	parsed, ok := parseNewsPublishedAt(raw)
	if !ok {
		return time.Time{}, false
	}
	now := time.Now()
	if parsed.After(now.Add(5*time.Minute)) || now.Sub(parsed) > newsRetention {
		return time.Time{}, false
	}
	return parsed, true
}

func isMacroRelevant(headline string) bool {
	text := strings.ToLower(headline)
	for _, phrase := range []string{
		"crypto", "bitcoin", "ethereum", "etf", "exchange", "market", "trading", "fraud",
		"interest rate", "inflation", "monetary policy", "bank", "liquidity", "sanction",
		"oil", "gold", "tariff", "securities", "derivatives", "futures", "stablecoin",
	} {
		if strings.Contains(text, phrase) {
			return true
		}
	}
	return false
}

func (s *MarketDataService) classifyFeedItems(items []normalizedFeedItem, sourceTier, provider string) []*MarketNewsItem {
	out := make([]*MarketNewsItem, 0, len(items))
	for _, raw := range items {
		published, ok := isAcceptableNewsTime(raw.PublishedAt)
		if !ok || raw.Headline == "" {
			continue
		}
		classificationText := strings.TrimSpace(raw.Headline + " " + raw.Source)
		coins := make([]string, 0, 4)
		for symbol, profile := range newsProfiles {
			if isRelevantGoogleNewsHeadline(classificationText, profile) {
				coins = append(coins, canonicalProfileCoin(symbol))
			}
		}
		coins = uniqueSortedStrings(coins)
		if len(coins) == 0 && !isMacroRelevant(classificationText) {
			continue
		}
		impact := scoreNewsImpact(classificationText, sourceTier, newsQueryForCoins(coins))
		if impact < minimumNewsImpact {
			continue
		}
		scope := "coin"
		if len(coins) == 0 {
			scope = "global"
		} else if len(coins) > 1 {
			scope = "multi-asset"
		}
		item := &MarketNewsItem{
			Coin: firstString(coins), Coins: coins, Scope: scope,
			Headline: raw.Headline, Description: raw.Description, URL: raw.URL,
			Source: raw.Source, PublishedAt: published.Format(time.RFC3339),
			Sentiment: scoreHeadlineSentiment(raw.Headline, newsQueryForCoins(coins)),
			Provider:  provider, SourceTier: sourceTier, Verification: "reported",
			IngestedAt:     time.Now().UTC().Format(time.RFC3339Nano),
			DetectedPrices: s.detectedPrices(coins), Relevance: impact,
		}
		item.ID = stableNewsID(item)
		newsSourceLagSeconds.WithLabelValues(provider).Observe(maxNewsFloat(0, time.Since(published).Seconds()))
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool { return getItemTime(out[i]).After(getItemTime(out[j])) })
	return out
}

func newsQueryForCoins(coins []string) newsQuery {
	if len(coins) == 0 {
		return newsQuery{}
	}
	return newsProfiles[strings.ToUpper(coins[0])]
}

func canonicalProfileCoin(symbol string) string {
	if strings.HasPrefix(symbol, "XYZ:") {
		return "xyz:" + strings.TrimPrefix(symbol, "XYZ:")
	}
	return symbol
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func (s *MarketDataService) detectedPrices(coins []string) map[string]float64 {
	if s.priceCache == nil || len(coins) == 0 {
		return nil
	}
	out := make(map[string]float64, len(coins))
	for _, coin := range coins {
		entry, ok := s.priceCache.Get(coin)
		if !ok {
			continue
		}
		mid := (entry.Buy + entry.Sell) / 2
		if mid > 0 {
			out[coin] = mid
		}
	}
	return out
}

func stableNewsID(item *MarketNewsItem) string {
	value := strings.ToLower(strings.Join([]string{item.Provider, item.URL, item.Headline}, "|"))
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:12])
}

func newsHeadlineFingerprint(item *MarketNewsItem) string {
	if item == nil {
		return ""
	}
	text := strings.ToLower(item.Headline)
	text = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == ' ' {
			return r
		}
		return ' '
	}, text)
	words := strings.Fields(text)
	if len(words) > 16 {
		words = words[:16]
	}
	return strings.Join(words, " ")
}

func getItemTime(item *MarketNewsItem) time.Time {
	if item == nil {
		return time.Time{}
	}
	parsed, _ := parseNewsPublishedAt(item.PublishedAt)
	return parsed
}

func (s *MarketDataService) ingestNewsItems(items []*MarketNewsItem) []*MarketNewsItem {
	if len(items) == 0 {
		return nil
	}
	now := time.Now()
	s.newsMu.Lock()
	defer s.newsMu.Unlock()
	for id, seenAt := range s.newsSeen {
		if now.Sub(seenAt) > newsRetention {
			delete(s.newsSeen, id)
			if strings.HasPrefix(id, "fp:") {
				delete(s.newsByFingerprint, strings.TrimPrefix(id, "fp:"))
			}
		}
	}
	newItems := make([]*MarketNewsItem, 0, len(items))
	for _, item := range items {
		if item == nil || item.ID == "" {
			continue
		}
		if _, exists := s.newsSeen[item.ID]; exists {
			continue
		}
		fingerprint := newsHeadlineFingerprint(item)
		if existing := s.newsByFingerprint[fingerprint]; fingerprint != "" && existing != nil {
			s.newsSeen[item.ID] = now
			s.newsSeen["fp:"+fingerprint] = now
			if !strings.EqualFold(existing.Source, item.Source) && !containsStringFold(existing.CorroboratingSources, item.Source) {
				existing.CorroboratingSources = append(existing.CorroboratingSources, item.Source)
				existing.CorroborationCount = 1 + len(existing.CorroboratingSources)
				existing.Verification = "corroborated"
				newItems = append(newItems, existing)
			}
			continue
		}
		s.newsSeen[item.ID] = now
		if fingerprint != "" {
			s.newsSeen["fp:"+fingerprint] = now
			s.newsByFingerprint[fingerprint] = item
		}
		newItems = append(newItems, item)
		newsIngestedTotal.WithLabelValues(item.SourceTier).Inc()
		if item.Scope == "global" || len(item.Coins) == 0 {
			s.globalNewsItems = prependBoundedNews(s.globalNewsItems, item, maxStoredGlobalNews)
		}
		for _, coin := range item.Coins {
			s.directNewsByCoin[coin] = prependBoundedNews(s.directNewsByCoin[coin], item, maxStoredNewsPerCoin)
		}
	}
	newsCacheItems.Set(float64(len(s.newsByFingerprint)))
	return newItems
}

func maxNewsFloat(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}

func containsStringFold(values []string, want string) bool {
	for _, value := range values {
		if strings.EqualFold(value, want) {
			return true
		}
	}
	return false
}

func prependBoundedNews(items []*MarketNewsItem, item *MarketNewsItem, limit int) []*MarketNewsItem {
	items = append([]*MarketNewsItem{item}, items...)
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}

func (s *MarketDataService) publishNewNews(items []*MarketNewsItem) {
	if len(items) == 0 {
		return
	}
	s.newsMu.RLock()
	sink := s.newsSink
	s.newsMu.RUnlock()
	if sink != nil {
		sink(items)
	}
}

func (s *MarketDataService) directNewsForCoin(coin string) []*MarketNewsItem {
	key := canonicalProfileCoin(strings.ToUpper(strings.TrimSpace(coin)))
	s.newsMu.RLock()
	defer s.newsMu.RUnlock()
	return append([]*MarketNewsItem(nil), s.directNewsByCoin[key]...)
}

func (s *MarketDataService) GetGlobalNews() []*MarketNewsItem {
	s.newsMu.RLock()
	defer s.newsMu.RUnlock()
	return append([]*MarketNewsItem(nil), s.globalNewsItems...)
}

func (s *MarketDataService) recordNewsSourceHealth(provider string, count int, err error, notModified bool) {
	now := time.Now().UTC()
	s.newsMu.Lock()
	health := s.newsSourceHealth[provider]
	health.Provider = provider
	health.LastAttemptAt = now
	if err != nil {
		newsFetchTotal.WithLabelValues(provider, "error").Inc()
		health.LastError = err.Error()
	} else {
		result := "success"
		if notModified {
			result = "not_modified"
		}
		newsFetchTotal.WithLabelValues(provider, result).Inc()
		health.LastSuccessAt = now
		health.LastError = ""
		if !notModified {
			health.Items = count
		}
	}
	s.newsSourceHealth[provider] = health
	s.newsMu.Unlock()
}

func (s *MarketDataService) GetNewsSourceHealth() map[string]NewsSourceHealth {
	s.newsMu.RLock()
	defer s.newsMu.RUnlock()
	out := make(map[string]NewsSourceHealth, len(s.newsSourceHealth))
	for provider, health := range s.newsSourceHealth {
		out[provider] = health
	}
	return out
}

type bskyResolveResponse struct {
	DID string `json:"did"`
}

type bskyJetstreamEvent struct {
	DID    string `json:"did"`
	TimeUS int64  `json:"time_us"`
	Kind   string `json:"kind"`
	Commit struct {
		Operation  string `json:"operation"`
		Collection string `json:"collection"`
		RKey       string `json:"rkey"`
		Record     struct {
			Text      string `json:"text"`
			CreatedAt string `json:"createdAt"`
		} `json:"record"`
	} `json:"commit"`
}

func (s *MarketDataService) resolveBskyAccounts(ctx context.Context) map[string]string {
	out := map[string]string{}
	for _, handle := range s.bskyNewsAccounts {
		endpoint := "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=" + url.QueryEscape(handle)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := s.newsClient.Do(req)
		if err != nil {
			s.recordNewsSourceHealth("bsky:"+handle, 0, err, false)
			continue
		}
		var resolved bskyResolveResponse
		err = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&resolved)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || err != nil || resolved.DID == "" {
			if err == nil {
				err = fmt.Errorf("resolve returned %d", resp.StatusCode)
			}
			s.recordNewsSourceHealth("bsky:"+handle, 0, err, false)
			continue
		}
		out[resolved.DID] = handle
		s.recordNewsSourceHealth("bsky:"+handle, 0, nil, false)
	}
	return out
}

func (s *MarketDataService) runBlueskyNewsLoop(ctx context.Context) {
	accounts := s.resolveBskyAccounts(ctx)
	if len(accounts) == 0 {
		return
	}
	backoff := time.Second
	var cursor int64
	for ctx.Err() == nil {
		params := url.Values{}
		params.Add("wantedCollections", "app.bsky.feed.post")
		for did := range accounts {
			params.Add("wantedDids", did)
		}
		if cursor > 0 {
			params.Set("cursor", fmt.Sprintf("%d", cursor))
		}
		endpoint := "wss://jetstream2.us-west.bsky.network/subscribe?" + params.Encode()
		conn, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
		if err != nil {
			s.recordNewsSourceHealth("bluesky", 0, err, false)
			if !waitNewsBackoff(ctx, backoff) {
				return
			}
			backoff = minNewsDuration(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		for ctx.Err() == nil {
			_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
			var event bskyJetstreamEvent
			if err := conn.ReadJSON(&event); err != nil {
				s.recordNewsSourceHealth("bluesky", 0, err, false)
				break
			}
			if event.TimeUS > cursor {
				cursor = event.TimeUS
			}
			if event.Kind != "commit" || event.Commit.Operation != "create" || event.Commit.Collection != "app.bsky.feed.post" {
				continue
			}
			handle := accounts[event.DID]
			text := cleanRSSHeadline(event.Commit.Record.Text)
			if handle == "" || text == "" {
				continue
			}
			createdAt := event.Commit.Record.CreatedAt
			if createdAt == "" {
				createdAt = time.Now().UTC().Format(time.RFC3339)
			}
			items := s.classifyFeedItems([]normalizedFeedItem{{
				Headline: text, Source: "@" + handle, PublishedAt: createdAt,
				URL: "https://bsky.app/profile/" + handle + "/post/" + event.Commit.RKey,
			}}, "social", "bluesky")
			for _, item := range items {
				item.Verification = "unverified"
			}
			s.publishNewNews(s.ingestNewsItems(items))
			s.recordNewsSourceHealth("bluesky", len(items), nil, false)
		}
		conn.Close()
	}
}

func waitNewsBackoff(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func minNewsDuration(left, right time.Duration) time.Duration {
	if left < right {
		return left
	}
	return right
}
