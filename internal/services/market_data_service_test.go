package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type rewriteTransport struct {
	baseURL string
}

func (t rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rewritten := req.Clone(req.Context())
	rewritten.URL.Scheme = "http"
	rewritten.URL.Host = strings.TrimPrefix(t.baseURL, "http://")
	return http.DefaultTransport.RoundTrip(rewritten)
}

func TestDefaultCFTCFeedUsesCurrentOfficialURL(t *testing.T) {
	for _, feed := range defaultDirectNewsFeeds {
		if feed.Name != "U.S. CFTC" {
			continue
		}
		const want = "https://www.cftc.gov/RSS/RSSENF/rssenf.xml"
		if feed.URL != want {
			t.Fatalf("CFTC feed URL = %q, want %q", feed.URL, want)
		}
		return
	}
	t.Fatal("default CFTC feed is missing")
}

func TestDirectNewsFailuresBackOffAndRecover(t *testing.T) {
	var hits int32
	var recovered int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if atomic.LoadInt32(&recovered) == 0 {
			http.Error(w, "unavailable", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(`<?xml version="1.0"?><rss><channel></channel></rss>`))
	}))
	defer server.Close()

	client := &http.Client{Timeout: 2 * time.Second, Transport: rewriteTransport{baseURL: server.URL}}
	svc := NewMarketDataService(nil, nil, nil, client, MarketNewsOptions{})
	feed := &newsFeedState{Name: "test", URL: "https://example.test/feed", SourceTier: "official"}
	svc.directNewsFeeds = []*newsFeedState{feed}

	now := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)
	svc.refreshDirectNewsAt(context.Background(), now)
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("first refresh made %d requests, want 1", got)
	}
	if feed.ConsecutiveFailures != 1 || !feed.RetryAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("first failure state = failures %d retry %v", feed.ConsecutiveFailures, feed.RetryAt)
	}

	svc.refreshDirectNewsAt(context.Background(), now.Add(20*time.Second))
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("refresh during backoff made %d requests, want 1", got)
	}

	atomic.StoreInt32(&recovered, 1)
	svc.refreshDirectNewsAt(context.Background(), feed.RetryAt)
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("retry made %d requests, want 2", got)
	}
	if feed.ConsecutiveFailures != 0 || !feed.RetryAt.IsZero() {
		t.Fatalf("successful retry did not reset failure state: %+v", feed)
	}
}

func TestDirectNewsRetryDelayCaps(t *testing.T) {
	tests := []struct {
		failures int
		want     time.Duration
	}{
		{failures: 1, want: time.Minute},
		{failures: 2, want: 2 * time.Minute},
		{failures: 6, want: 30 * time.Minute},
		{failures: 20, want: 30 * time.Minute},
	}
	for _, test := range tests {
		if got := directNewsRetryDelay(test.failures); got != test.want {
			t.Errorf("failures %d: delay %v, want %v", test.failures, got, test.want)
		}
	}
}

func TestMarketNewsCachesMisses(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><rss><channel></channel></rss>`))
	}))
	defer server.Close()

	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: rewriteTransport{baseURL: server.URL},
	}

	svc := NewMarketDataService(nil, nil, nil, client, MarketNewsOptions{})

	ctx := context.Background()
	first, err := svc.getNewsForCoin(ctx, "BTC")
	if err != nil {
		t.Fatalf("first fetch error: %v", err)
	}
	if len(first) != 0 {
		t.Fatalf("expected no news item on first fetch, got %+v", first)
	}

	second, err := svc.getNewsForCoin(ctx, "BTC")
	if err != nil {
		t.Fatalf("second fetch error: %v", err)
	}
	if len(second) != 0 {
		t.Fatalf("expected no news item on second fetch, got %+v", second)
	}

	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("expected provider to be hit once, got %d", got)
	}
}

func TestPickBestNewsItemsPrefersFreshRelevantArticles(t *testing.T) {
	now := time.Now().UTC()
	query := newsQuery{search: `("Bitcoin" OR BTC) when:3d`, aliases: []string{"bitcoin", "btc"}}
	data := []googleNewsRSSItem{
		{
			Title:       "Macro markets drift lower ahead of payrolls - Wire",
			Link:        "https://example.com/macro",
			PublishedAt: now.Add(-10 * time.Minute).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Wire"},
		},
		{
			Title:       "Bitcoin breaks above key resistance as ETF flows jump - Desk",
			Link:        "https://example.com/btc-breakout",
			PublishedAt: now.Add(-20 * time.Minute).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Desk"},
		},
		{
			Title:       "Bitcoin miners see margin pressure despite rally - Journal",
			Link:        "https://example.com/btc-miners",
			PublishedAt: now.Add(-90 * time.Minute).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Journal"},
		},
	}

	items := pickBestNewsItems("BTC", query, data)
	if len(items) != 1 {
		t.Fatalf("expected only the market-moving item, got %d", len(items))
	}
	if got := items[0].Headline; got != "Bitcoin breaks above key resistance as ETF flows jump" {
		t.Fatalf("expected most relevant BTC headline first, got %q", got)
	}
}

func TestPickBestNewsItemsKeepsImpactfulStoriesFor72Hours(t *testing.T) {
	now := time.Now().UTC()
	query := newsQuery{search: `("Bitcoin" OR BTC) when:3d`, aliases: []string{"bitcoin", "btc"}}
	data := []googleNewsRSSItem{
		{
			Title:       "Bitcoin ETF inflows accelerate - Desk",
			Link:        "https://example.com/fresh",
			PublishedAt: now.Add(-2 * time.Hour).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Desk"},
		},
		{
			Title:       "Bitcoin exchange reserves fall - Wire",
			Link:        "https://example.com/old",
			PublishedAt: now.Add(-30 * time.Hour).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Wire"},
		},
		{
			Title:       "Bitcoin network upgrade approved - Wire",
			Link:        "https://example.com/too-old",
			PublishedAt: now.Add(-60 * time.Hour).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Wire"},
		},
		{
			Title:       "Bitcoin exchange hack triggers selloff - Wire",
			Link:        "https://example.com/expired",
			PublishedAt: now.Add(-80 * time.Hour).Format(time.RFC1123Z),
			Source: struct {
				Name string `xml:",chardata"`
				URL  string `xml:"url,attr"`
			}{Name: "Wire"},
		},
	}

	items := pickBestNewsItems("BTC", query, data)
	if len(items) != 3 {
		t.Fatalf("expected impactful 2h, 30h, and 60h items to remain, got %d", len(items))
	}
	if items[0].Headline != "Bitcoin ETF inflows accelerate" {
		t.Fatalf("expected fresh headline, got %q", items[0].Headline)
	}
	for _, item := range items {
		if item.Headline == "Bitcoin exchange hack triggers selloff" {
			t.Fatal("headline older than 72 hours was retained")
		}
	}
}

func TestScoreNewsImpactRejectsTickerMentionsWithoutCatalysts(t *testing.T) {
	query := newsQuery{aliases: []string{"bitcoin", "btc"}}
	highImpact := []string{
		"Bitcoin ETF posts record inflows",
		"Bitcoin exchange halts withdrawals after hack",
		"Strategy buys more Bitcoin for its treasury",
	}
	for _, headline := range highImpact {
		if score := scoreNewsImpact(headline, "publisher", query); score < minimumNewsImpact {
			t.Errorf("expected market-moving headline %q to pass, score=%f", headline, score)
		}
	}

	lowImpact := []string{
		"Bitcoin price prediction for next month",
		"What is Bitcoin and how does it work?",
		"Bitcoin community celebrates its anniversary",
	}
	for _, headline := range lowImpact {
		if score := scoreNewsImpact(headline, "publisher", query); score >= minimumNewsImpact {
			t.Errorf("expected low-impact headline %q to be rejected, score=%f", headline, score)
		}
	}
}

func TestScoreHeadlineSentimentBullish(t *testing.T) {
	query := newsQuery{aliases: []string{"bitcoin", "btc"}}
	score := scoreHeadlineSentiment("Bitcoin jumps as SEC approves ETF after record inflows", query)
	if score <= 0.15 {
		t.Fatalf("expected bullish score, got %f", score)
	}
}

func TestScoreHeadlineSentimentBearish(t *testing.T) {
	query := newsQuery{aliases: []string{"solana", "sol"}}
	score := scoreHeadlineSentiment("Solana plunges after network outage and exploit fears", query)
	if score >= -0.15 {
		t.Fatalf("expected bearish score, got %f", score)
	}
}

func TestScoreHeadlineSentimentHandlesNegation(t *testing.T) {
	query := newsQuery{aliases: []string{"xrp"}}
	score := scoreHeadlineSentiment("XRP not approved for ETF despite speculation", query)
	if score >= 0 {
		t.Fatalf("expected non-bullish negated score, got %f", score)
	}
}

func TestMarketNewsKeepsGoogleLinkWithoutRedirectFanout(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC1123Z)
	var redirectHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rss/search":
			w.Header().Set("Content-Type", "application/rss+xml")
			_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><item>
<title>Bitcoin jumps on ETF demand - Desk</title>
<link>https://news.google.com/rss/articles/CBMiTWh0dHBzOi8vbmV3cy5nb29nbGUuY29tL2JpdGNvaW4</link>
<pubDate>` + now + `</pubDate>
<source url="https://desk.example">Desk</source>
</item></channel></rss>`))
		case "/rss/articles/CBMiTWh0dHBzOi8vbmV3cy5nb29nbGUuY29tL2JpdGNvaW4":
			atomic.AddInt32(&redirectHits, 1)
			http.Redirect(w, r, "https://publisher.example/story", http.StatusFound)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: rewriteTransport{baseURL: server.URL},
	}

	svc := NewMarketDataService(nil, nil, nil, client, MarketNewsOptions{})
	items, err := svc.getNewsForCoin(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("expected no fetch error, got %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected one item, got %d", len(items))
	}
	if !strings.Contains(items[0].URL, "news.google.com/rss/articles") {
		t.Fatalf("expected original Google News URL, got %q", items[0].URL)
	}
	if got := atomic.LoadInt32(&redirectHits); got != 0 {
		t.Fatalf("expected no per-headline redirect request, got %d", got)
	}
	if items[0].Headline != "Bitcoin jumps on ETF demand" {
		t.Fatalf("expected cleaned headline, got %q", items[0].Headline)
	}
}

func TestParseXNewsFeedsBuildsMirrorRSSURLsFromAccountURLs(t *testing.T) {
	feeds := parseXNewsFeeds("https://nitter.poast.org", []string{
		"https://x.com/tier10k",
		"https://twitter.com/WatcherGuru",
		"@tier10k",
	})

	if len(feeds) != 2 {
		t.Fatalf("expected 2 unique feeds, got %d", len(feeds))
	}
	if feeds[0].url != "https://nitter.poast.org/tier10k/rss" {
		t.Fatalf("unexpected first feed url: %q", feeds[0].url)
	}
	if feeds[1].url != "https://nitter.poast.org/WatcherGuru/rss" {
		t.Fatalf("unexpected second feed url: %q", feeds[1].url)
	}
}

func TestMarketNewsMergesConfiguredXFeeds(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC1123Z)
	var googleHits int32
	var xHits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rss/search":
			atomic.AddInt32(&googleHits, 1)
			w.Header().Set("Content-Type", "application/rss+xml")
			_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><item>
<title>Bitcoin jumps on ETF demand - Desk</title>
<link>https://news.google.com/rss/articles/CBMiTWh0dHBzOi8vbmV3cy5nb29nbGUuY29tL2JpdGNvaW4</link>
<pubDate>` + now + `</pubDate>
<source url="https://desk.example">Desk</source>
</item></channel></rss>`))
		case "/rss/articles/CBMiTWh0dHBzOi8vbmV3cy5nb29nbGUuY29tL2JpdGNvaW4":
			http.Redirect(w, r, "https://publisher.example/story", http.StatusFound)
		case "/tier10k/rss":
			atomic.AddInt32(&xHits, 1)
			w.Header().Set("Content-Type", "application/rss+xml")
			_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><item>
<title>Bitcoin ETF flows just accelerated</title>
<link>https://nitter.poast.org/tier10k/status/12345#m</link>
<pubDate>` + now + `</pubDate>
<source>@tier10k</source>
</item></channel></rss>`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: rewriteTransport{baseURL: server.URL},
	}

	svc := NewMarketDataService(nil, nil, nil, client, MarketNewsOptions{
		XNewsMirrorBase: "https://nitter.poast.org",
		XNewsAccounts:   []string{"https://x.com/tier10k"},
	})
	svc.refreshDirectNews(context.Background())

	items, err := svc.getNewsForCoin(context.Background(), "BTC")
	if err != nil {
		t.Fatalf("expected no fetch error, got %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected merged google + x items, got %d", len(items))
	}
	if got := atomic.LoadInt32(&googleHits); got != 1 {
		t.Fatalf("expected one google fetch, got %d", got)
	}
	if got := atomic.LoadInt32(&xHits); got != 1 {
		t.Fatalf("expected one x feed fetch, got %d", got)
	}
	foundX := false
	for _, item := range items {
		if item.Provider == "x-rss" {
			foundX = true
			if item.URL != "https://x.com/tier10k/status/12345" {
				t.Fatalf("expected canonical x url, got %q", item.URL)
			}
		}
	}
	if !foundX {
		t.Fatalf("expected at least one x-rss item in merged results")
	}
}

func TestBuildNewsQueryMapsXyzEquitiesToFullNames(t *testing.T) {
	cases := []struct {
		coin       string
		wantSearch string
		wantAlias  string
	}{
		{"xyz:SKHX", "SK Hynix", "sk hynix"},
		{"xyz:SMSN", "Samsung", "samsung"},
		{"xyz:TSM", "Taiwan Semiconductor", "taiwan semiconductor"},
		{"xyz:CRWV", "CoreWeave", "coreweave"},
		{"XYZ:HOOD", "Robinhood", "robinhood"},
	}
	for _, tc := range cases {
		q := buildNewsQuery(tc.coin)
		if !strings.Contains(q.search, tc.wantSearch) {
			t.Errorf("buildNewsQuery(%q) search = %q, want it to contain %q", tc.coin, q.search, tc.wantSearch)
		}
		if !containsAlias(q.aliases, tc.wantAlias) {
			t.Errorf("buildNewsQuery(%q) aliases = %v, want %q", tc.coin, q.aliases, tc.wantAlias)
		}
		if !isRelevantGoogleNewsHeadline(strings.ToUpper(tc.wantSearch)+" reports strong demand", q) {
			t.Errorf("buildNewsQuery(%q) should match a headline containing %q", tc.coin, tc.wantSearch)
		}
	}
}

func TestBuildNewsQueryDisambiguatesCommonWordTokens(t *testing.T) {
	pump := buildNewsQuery("PUMP")
	if containsAlias(pump.aliases, "pump") {
		t.Fatalf("PUMP profile must not carry the bare 'pump' alias, got %v", pump.aliases)
	}
	relevant := []string{
		"Pump.fun token volume soars to record high",
		"Pumpfun launches new revenue share program",
	}
	for _, h := range relevant {
		if !isRelevantGoogleNewsHeadline(h, pump) {
			t.Errorf("expected PUMP to match %q", h)
		}
	}
	noise := []string{
		"Gas station pump prices rise across the US",
		"Bitcoin could pump to 100k says analyst",
		"Stocks pump after Fed signals rate cuts",
	}
	for _, h := range noise {
		if isRelevantGoogleNewsHeadline(h, pump) {
			t.Errorf("expected PUMP to reject noise headline %q", h)
		}
	}
}

func TestBuildNewsQueryNormalizesKPrefixedPerps(t *testing.T) {
	q := buildNewsQuery("kPEPE")
	if !strings.Contains(strings.ToLower(q.search), "pepe") {
		t.Fatalf("kPEPE should resolve to the PEPE profile, got search %q", q.search)
	}
	shib := buildNewsQuery("kSHIB")
	if !strings.Contains(shib.search, "Shiba Inu") {
		t.Fatalf("kSHIB should resolve to the SHIB profile, got search %q", shib.search)
	}
}

func TestBuildNewsQueryDefaultsAreContextQualified(t *testing.T) {
	crypto := buildNewsQuery("ZZZ")
	if !strings.Contains(crypto.search, "crypto") {
		t.Errorf("unknown crypto default should be crypto-qualified, got %q", crypto.search)
	}
	equity := buildNewsQuery("xyz:ZZZ")
	if !strings.Contains(equity.search, "stock") {
		t.Errorf("unknown xyz default should be stock-qualified, got %q", equity.search)
	}
}

func TestAliasMatchesWordBoundary(t *testing.T) {
	if !aliasMatches("btc rallies on etf flows", "btc") {
		t.Errorf("expected short ticker to match as a standalone word")
	}
	if aliasMatches("the movement protocol launched", "move") {
		t.Errorf("expected short alias 'move' not to match inside 'movement'")
	}
	if !aliasMatches("sk hynix posts record profit", "sk hynix") {
		t.Errorf("expected multi-word alias to substring match")
	}
}

func TestParseSyndicationFeedSupportsAtom(t *testing.T) {
	body := []byte(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Desk</title><entry><title>Bitcoin ETF approved</title><link rel="alternate" href="https://example.com/story"/><published>2026-07-13T12:00:00Z</published><summary>Fresh report</summary></entry></feed>`)
	items, err := parseSyndicationFeed(body, "Desk")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Headline != "Bitcoin ETF approved" || items[0].URL != "https://example.com/story" {
		t.Fatalf("unexpected atom items: %+v", items)
	}
}

func TestClassifyFeedItemsSeparatesCoinAndGlobalNews(t *testing.T) {
	svc := NewMarketDataService(nil, nil, nil, nil, MarketNewsOptions{})
	now := time.Now().UTC().Format(time.RFC3339)
	items := svc.classifyFeedItems([]normalizedFeedItem{
		{Headline: "Bitcoin ETF approval moves crypto market", Source: "Regulator", URL: "https://example.com/btc", PublishedAt: now},
		{Headline: "Federal Reserve interest rate decision", Source: "Federal Reserve", URL: "https://example.com/macro", PublishedAt: now},
	}, "official", "rss")
	if len(items) != 2 {
		t.Fatalf("classified %d items, want 2", len(items))
	}
	if items[0].ID == "" || items[1].ID == "" {
		t.Fatal("stable ids were not assigned")
	}
	var sawBTC, sawGlobal, sawBullishBTC bool
	for _, item := range items {
		if item.Scope == "global" {
			sawGlobal = true
		}
		for _, coin := range item.Coins {
			if coin == "BTC" {
				sawBTC = true
				if item.Sentiment > 0 {
					sawBullishBTC = true
				}
			}
		}
	}
	if !sawBTC || !sawGlobal || !sawBullishBTC {
		t.Fatalf("coin/global classification missing: %+v", items)
	}
}

func TestClassifyFeedItemsMapsNonCryptoMarketCatalysts(t *testing.T) {
	svc := NewMarketDataService(nil, nil, nil, nil, MarketNewsOptions{})
	now := time.Now().UTC().Format(time.RFC3339)
	items := svc.classifyFeedItems([]normalizedFeedItem{
		{Headline: "Nvidia shares jump after raising guidance", Source: "Bloomberg Markets", URL: "https://example.com/nvda", PublishedAt: now},
		{Headline: "Oil rises as crude inventories drop", Source: "Bloomberg Markets", URL: "https://example.com/oil", PublishedAt: now},
		{Headline: "Monetary policy decision holds interest rates", Source: "European Central Bank", URL: "https://example.com/ecb", PublishedAt: now},
		{Headline: "Tesla CEO attends industry conference", Source: "Bloomberg Markets", URL: "https://example.com/fluff", PublishedAt: now},
	}, "official", "rss")

	found := map[string]bool{}
	for _, item := range items {
		for _, coin := range item.Coins {
			found[coin] = true
		}
		if strings.Contains(item.Headline, "industry conference") {
			t.Fatal("low-impact company mention was not curated")
		}
	}
	for _, coin := range []string{"xyz:NVDA", "xyz:CL", "xyz:EUR"} {
		if !found[coin] {
			t.Errorf("expected non-crypto catalyst for %s, got %+v", coin, items)
		}
	}
}

func TestBuildDirectNewsFeedsRejectsNonHTTPSAndDeduplicates(t *testing.T) {
	feeds := buildDirectNewsFeeds([]string{"http://localhost/feed", "https://example.com/rss", "https://example.com/rss"})
	count := 0
	foundDefaults := map[string]bool{
		"CoinDesk": false, "Decrypt": false, "Cointelegraph": false, "CryptoSlate": false,
		"Bloomberg Markets": false, "U.S. EIA": false, "U.S. EIA Press": false,
		"European Central Bank": false,
	}
	for _, feed := range feeds {
		if feed.URL == "https://example.com/rss" {
			count++
		}
		if _, ok := foundDefaults[feed.Name]; ok {
			foundDefaults[feed.Name] = true
		}
	}
	if count != 1 {
		t.Fatalf("extra feed count=%d, want 1", count)
	}
	for name, found := range foundDefaults {
		if !found {
			t.Fatalf("default %s publisher feed is missing", name)
		}
	}
	for _, feed := range feeds {
		if strings.HasPrefix(feed.URL, "http://") {
			t.Fatalf("accepted insecure feed %q", feed.URL)
		}
	}
}

func containsAlias(aliases []string, want string) bool {
	for _, a := range aliases {
		if strings.EqualFold(strings.TrimSpace(a), want) {
			return true
		}
	}
	return false
}
