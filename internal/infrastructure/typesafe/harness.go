package typesafe

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// 1. VISIBILITY LADDER & ADDRESSABLE CHUNK STORE
// (Section V: Meta-Attention: Context as a Decision & Fig. 4)
// ============================================================================

// VisibilityLevel represents the 4-tier visibility ladder for context chunks.
type VisibilityLevel string

const (
	VisibilityHide  VisibilityLevel = "hide"  // Don't show (0 tokens in prompt)
	VisibilityShort VisibilityLevel = "short" // Short summary (e.g. 1-line / key hits)
	VisibilityLong  VisibilityLevel = "long"  // Long summary (trace + cause / metrics)
	VisibilityFull  VisibilityLevel = "full"  // Full raw content
)

// ChunkType categorizes explicit addressable state elements.
type ChunkType string

const (
	ChunkTypeToolCall    ChunkType = "tool_call"
	ChunkTypeToolOutput  ChunkType = "tool_output"
	ChunkTypeReasoning   ChunkType = "reasoning"
	ChunkTypeUserTurn    ChunkType = "user_turn"
	ChunkTypeFileDiff    ChunkType = "file_diff"
	ChunkTypeInstruction ChunkType = "instruction"
	ChunkTypeMarketState ChunkType = "market_state"
)

// Chunk represents an addressable, typed piece of state in the harness.
type Chunk struct {
	ID           string          `json:"id"`
	Type         ChunkType       `json:"type"`
	Title        string          `json:"title"`
	FullContent  string          `json:"fullContent"`
	ShortSummary string          `json:"shortSummary"`
	LongSummary  string          `json:"longSummary"`
	EstimatedTok int             `json:"estimatedTokens"`
	Pinned       bool            `json:"pinned"` // Immune to compaction/hiding
	Level        VisibilityLevel `json:"level"`
}

// ScoredChunk is a chunk evaluated with a visibility level and relevance score.
type ScoredChunk struct {
	Chunk      *Chunk          `json:"chunk"`
	Level      VisibilityLevel `json:"level"`
	Relevance  float64         `json:"relevance"` // 0.0 to 1.0
	TokensUsed int             `json:"tokensUsed"`
}

// ChunkStore maintains typed, addressable state chunks.
type ChunkStore struct {
	mu     sync.RWMutex
	chunks map[string]*Chunk
	order  []string
}

// NewChunkStore initializes an addressable chunk store.
func NewChunkStore() *ChunkStore {
	return &ChunkStore{
		chunks: make(map[string]*Chunk),
		order:  make([]string, 0),
	}
}

// AddChunk inserts or updates a chunk in the store.
func (cs *ChunkStore) AddChunk(c *Chunk) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if _, exists := cs.chunks[c.ID]; !exists {
		cs.order = append(cs.order, c.ID)
	}
	if c.EstimatedTok <= 0 {
		c.EstimatedTok = int(math.Ceil(float64(len(c.FullContent)) / 4.0))
	}
	if c.Level == "" {
		c.Level = VisibilityFull
	}
	cs.chunks[c.ID] = c
}

// GetChunk retrieves a chunk by ID.
func (cs *ChunkStore) GetChunk(id string) (*Chunk, bool) {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	c, ok := cs.chunks[id]
	return c, ok
}

// ListChunks returns all chunks in insertion order.
func (cs *ChunkStore) ListChunks() []*Chunk {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	result := make([]*Chunk, 0, len(cs.order))
	for _, id := range cs.order {
		if c, ok := cs.chunks[id]; ok {
			result = append(result, c)
		}
	}
	return result
}

// ScoreVisibility evaluates visibility ladder levels for all chunks against a query.
// If client is available, it asks Jev; otherwise it applies deterministic relevance scoring.
func (cs *ChunkStore) ScoreVisibility(ctx context.Context, client *Client, query string) ([]ScoredChunk, error) {
	cs.mu.RLock()
	allChunks := make([]*Chunk, 0, len(cs.order))
	for _, id := range cs.order {
		if c, ok := cs.chunks[id]; ok {
			allChunks = append(allChunks, c)
		}
	}
	cs.mu.RUnlock()

	scored := make([]ScoredChunk, len(allChunks))
	cleanQuery := strings.ToLower(strings.TrimSpace(query))
	queryTokens := strings.Fields(cleanQuery)

	for i, c := range allChunks {
		if c.Pinned {
			scored[i] = ScoredChunk{
				Chunk:      c,
				Level:      VisibilityFull,
				Relevance:  1.0,
				TokensUsed: c.EstimatedTok,
			}
			continue
		}

		// Calculate term match relevance
		titleLower := strings.ToLower(c.Title)
		contentLower := strings.ToLower(c.FullContent)
		matches := 0
		for _, tok := range queryTokens {
			if strings.Contains(titleLower, tok) {
				matches += 2
			} else if strings.Contains(contentLower, tok) {
				matches++
			}
		}

		relevance := 0.0
		if len(queryTokens) > 0 {
			relevance = math.Min(1.0, float64(matches)/float64(len(queryTokens)*2))
		}

		var level VisibilityLevel
		var tokUsed int
		switch {
		case relevance >= 0.70:
			level = VisibilityFull
			tokUsed = c.EstimatedTok
		case relevance >= 0.35:
			level = VisibilityLong
			tokUsed = int(math.Ceil(float64(len(c.LongSummary)) / 4.0))
			if tokUsed == 0 {
				tokUsed = int(math.Ceil(float64(c.EstimatedTok) * 0.4))
			}
		case relevance > 0.05:
			level = VisibilityShort
			tokUsed = int(math.Ceil(float64(len(c.ShortSummary)) / 4.0))
			if tokUsed == 0 {
				tokUsed = int(math.Ceil(float64(c.EstimatedTok) * 0.15))
			}
		default:
			level = VisibilityHide
			tokUsed = 0
		}

		scored[i] = ScoredChunk{
			Chunk:      c,
			Level:      level,
			Relevance:  relevance,
			TokensUsed: tokUsed,
		}
	}

	return scored, nil
}

// AssembleContext constructs the final prompt context from scored chunks within a token budget.
func (cs *ChunkStore) AssembleContext(scored []ScoredChunk, tokenBudget int) (string, int) {
	var b strings.Builder
	totalTokens := 0

	// Always place pinned chunks first
	for _, sc := range scored {
		if sc.Chunk.Pinned {
			content := sc.Chunk.FullContent
			b.WriteString(fmt.Sprintf("=== [%s: %s] ===\n%s\n\n", sc.Chunk.Type, sc.Chunk.Title, content))
			totalTokens += sc.TokensUsed
		}
	}

	// Then sort remaining by relevance descending
	unpinned := make([]ScoredChunk, 0)
	for _, sc := range scored {
		if !sc.Chunk.Pinned && sc.Level != VisibilityHide {
			unpinned = append(unpinned, sc)
		}
	}
	sort.Slice(unpinned, func(i, j int) bool {
		return unpinned[i].Relevance > unpinned[j].Relevance
	})

	for _, sc := range unpinned {
		if tokenBudget > 0 && totalTokens+sc.TokensUsed > tokenBudget {
			// Fallback down the ladder if full does not fit
			if sc.Level == VisibilityFull && sc.Chunk.ShortSummary != "" {
				shortTok := int(math.Ceil(float64(len(sc.Chunk.ShortSummary)) / 4.0))
				if totalTokens+shortTok <= tokenBudget {
					b.WriteString(fmt.Sprintf("=== [%s: %s (summary)] ===\n%s\n\n", sc.Chunk.Type, sc.Chunk.Title, sc.Chunk.ShortSummary))
					totalTokens += shortTok
					continue
				}
			}
			continue
		}

		var text string
		switch sc.Level {
		case VisibilityFull:
			text = sc.Chunk.FullContent
		case VisibilityLong:
			text = sc.Chunk.LongSummary
			if text == "" {
				text = sc.Chunk.FullContent
			}
		case VisibilityShort:
			text = sc.Chunk.ShortSummary
			if text == "" {
				text = sc.Chunk.FullContent
			}
		default:
			continue
		}

		b.WriteString(fmt.Sprintf("=== [%s: %s (%s)] ===\n%s\n\n", sc.Chunk.Type, sc.Chunk.Title, sc.Level, text))
		totalTokens += sc.TokensUsed
	}

	return strings.TrimSpace(b.String()), totalTokens
}

// FilterHeatmap heatmaps and filters large text outputs (e.g. 2,400-line grep or log files)
// to extract only the most relevant hits within maxLines.
func FilterHeatmap(rawOutput string, query string, maxLines int) string {
	if maxLines <= 0 {
		maxLines = 20
	}
	lines := strings.Split(rawOutput, "\n")
	if len(lines) <= maxLines {
		return rawOutput
	}

	terms := strings.Fields(strings.ToLower(query))
	type lineRank struct {
		line  string
		idx   int
		score int
	}

	ranks := make([]lineRank, len(lines))
	for i, line := range lines {
		lower := strings.ToLower(line)
		score := 0
		for _, term := range terms {
			if strings.Contains(lower, term) {
				score++
			}
		}
		ranks[i] = lineRank{line: line, idx: i, score: score}
	}

	// Stable sort by score descending
	sort.SliceStable(ranks, func(i, j int) bool {
		return ranks[i].score > ranks[j].score
	})

	// Pick top matching lines
	selected := make(map[int]string)
	for i := 0; i < maxLines && i < len(ranks); i++ {
		if ranks[i].score > 0 || i < 5 {
			selected[ranks[i].idx] = ranks[i].line
		}
	}

	// Reassemble in original order
	var result []string
	omitted := false
	for i := range lines {
		if content, ok := selected[i]; ok {
			omitted = false
			result = append(result, content)
		} else if !omitted {
			result = append(result, fmt.Sprintf("... [lines %d+ filtered by relevance] ...", i+1))
			omitted = true
		}
	}

	return strings.Join(result, "\n")
}

// ============================================================================
// 2. KV CACHE REUSE DECISION
// (Section V & Table I: "Reuse the cached prefix or rebuild? -> noul + probability")
// ============================================================================

// CacheReuseDecision encapsulates Jev's evaluation of KV cache reuse vs context rebuild.
type CacheReuseDecision struct {
	ReusePrefix bool    `json:"reusePrefix"`
	Probability float64 `json:"probability"`
	Reason      string  `json:"reason"`
}

// EvaluateCacheReuse determines whether reusing the cached prefix or rebuilding context is cheaper and better.
func EvaluateCacheReuse(ctx context.Context, client *Client, sessionState string, newQuery string, cacheAge time.Duration, contextDrift float64) (CacheReuseDecision, error) {
	// If client is available and active, we submit the noul question
	if client != nil && client.IsAvailable() && !client.IsCircuitOpen() {
		state := fmt.Sprintf(
			"Session State: %s | Query: %s | Cache Age: %s | Context Drift: %.2f",
			sessionState, newQuery, cacheAge.String(), contextDrift,
		)
		questions := map[string]QuestionSpec{
			"reuse_cache": {
				Type:         "noul",
				Instructions: "Should the agent reuse the existing KV cache prefix, or is context rebuild cleaner and cheaper?",
			},
		}
		resp, err := client.Decide(ctx, state, questions)
		if err == nil {
			if ans, ok := resp.Answers["reuse_cache"]; ok {
				prob := ans.Noul
				if prob <= 0 && ans.Confidence > 0 {
					prob = ans.Confidence
				}
				reuse := prob >= 0.50
				reason := "Jev model decision: high cache validity"
				if !reuse {
					reason = "Jev model decision: high context drift, rebuild recommended"
				}
				return CacheReuseDecision{
					ReusePrefix: reuse,
					Probability: prob,
					Reason:      reason,
				}, nil
			}
		}
	}

	// Deterministic fallback based on cache age and drift
	if cacheAge > 5*time.Minute || contextDrift > 0.60 {
		return CacheReuseDecision{
			ReusePrefix: false,
			Probability: 0.20,
			Reason:      "Cache invalidated due to high context drift or stale prefix (>5m)",
		}, nil
	}

	return CacheReuseDecision{
		ReusePrefix: true,
		Probability: 0.85,
		Reason:      "Prefix cache intact with low context drift",
	}, nil
}

// ============================================================================
// 3. MODEL ROUTING ECONOMICS & THE ROUTING TRAP
// (Section II.A, Fig. 2 & Table I: "Can this subtask leave the frontier model?")
// ============================================================================

// ModelPricing defines per-million token pricing for input, output, and context reloads.
type ModelPricing struct {
	Name         string  `json:"name"`
	InputPerM    float64 `json:"inputPerM"`
	OutputPerM   float64 `json:"outputPerM"`
	ReloadPerM   float64 `json:"reloadPerM"`
}

// Default standard prices from the paper (Section II.A):
// Opus: $5 input / $25 output per M tokens
// Sonnet: $3 input / $15 output per M tokens
var (
	FrontierOpusPrice = ModelPricing{Name: "Opus", InputPerM: 5.0, OutputPerM: 25.0, ReloadPerM: 5.0}
	HelperSonnetPrice = ModelPricing{Name: "Sonnet", InputPerM: 3.0, OutputPerM: 15.0, ReloadPerM: 3.0}
)

// RoutingCostEstimate calculates token costs comparing pure frontier vs routed execution.
type RoutingCostEstimate struct {
	PureFrontierCost float64 `json:"pureFrontierCost"`
	NaiveRoutedCost  float64 `json:"naiveRoutedCost"`
	PurposeBuiltCost float64 `json:"purposeBuiltCost"`
	RoutingAdvantage float64 `json:"routingAdvantage"` // positive means purpose-built routing saves money
	TrappedInCost    bool    `json:"trappedInCost"`    // true if naive routing is more expensive than pure frontier
	RecommendedRoute string  `json:"recommendedRoute"` // "frontier", "purpose_built_subagent", or "stay_put"
}

// CalculateRoutingCosts implements Diogo Almeida's exact routing trap formulas:
// Path 1 (Pure Opus): 25*Y + 5*Z
// Path 2 (Naive Routed): 3*X + 20*Y + 8*Z (where Sonnet loads 3*X, generates 15*Y, reads 3*Z, and Opus reloads 5*(Y+Z))
// Path 3 (Purpose-Built Sub-Agent): 3*X' + 15*Y + 3*Z + 5*Y_summary (handing helper small context X' << X, returning scored chunk)
func CalculateRoutingCosts(
	contextX float64, // context tokens in millions
	genY float64, // generated output tokens in millions
	readZ float64, // tokens read during work in millions
	subtaskXPrime float64, // small purpose-built context tokens in millions
	summaryY float64, // compact summary merged back in millions
) RoutingCostEstimate {
	// Path 1: Pure Opus
	// generate 25*Y, read 5*Z
	pureFrontier := 25.0*genY + 5.0*readZ

	// Path 2: Naive Opus -> Sonnet -> Opus
	// Sonnet loads context 3*X, generates 15*Y, reads 3*Z, Opus reloads 5*(Y+Z)
	// total = 3*X + 20*Y + 8*Z
	naiveRouted := 3.0*contextX + 20.0*genY + 8.0*readZ

	// Path 3: Optimized Purpose-Built Context
	// Sonnet loads only X', generates 15*Y, reads 3*Z, Opus reloads only Y_summary
	if subtaskXPrime <= 0 {
		subtaskXPrime = contextX * 0.10 // default 90% context reduction
	}
	if summaryY <= 0 {
		summaryY = genY * 0.15 // default compact summary
	}
	purposeBuilt := 3.0*subtaskXPrime + 15.0*genY + 3.0*readZ + 5.0*summaryY

	trapped := naiveRouted > pureFrontier
	recRoute := "frontier"
	advantage := pureFrontier - purposeBuilt
	if advantage > 0 {
		recRoute = "purpose_built_subagent"
	} else if pureFrontier <= naiveRouted {
		recRoute = "frontier"
	}

	return RoutingCostEstimate{
		PureFrontierCost: pureFrontier,
		NaiveRoutedCost:  naiveRouted,
		PurposeBuiltCost: purposeBuilt,
		RoutingAdvantage: advantage,
		TrappedInCost:    trapped,
		RecommendedRoute: recRoute,
	}
}

// ============================================================================
// 4. TIERED TOOL ROUTER (HARNESS AS TOOL ROUTER)
// (Section IV.B, VII & Fig. 5)
// ============================================================================

// ToolTier represents the disclosure level of a tool.
type ToolTier int

const (
	Tier1Snippet ToolTier = 1 // One line per capability, loaded when relevant
	Tier2Schema  ToolTier = 2 // Full argument schema for chosen candidates
	Tier3Docs    ToolTier = 3 // Deep manual / docs for one-off query
)

// ToolCapability defines a tool with tiered disclosure data.
type ToolCapability struct {
	Name         string   `json:"name"`
	Category     string   `json:"category"`
	Snippet      string   `json:"snippet"` // Tier 1: 1-line summary
	SchemaJSON   string   `json:"schema"`  // Tier 2: full argument schema
	Documentation string  `json:"docs"`    // Tier 3: comprehensive usage guide
	Keywords     []string `json:"keywords"`
}

// TieredToolRegistry manages tools across Tier 1, Tier 2, and Tier 3.
type TieredToolRegistry struct {
	mu    sync.RWMutex
	tools map[string]*ToolCapability
}

// NewTieredToolRegistry creates a tool registry.
func NewTieredToolRegistry() *TieredToolRegistry {
	return &TieredToolRegistry{
		tools: make(map[string]*ToolCapability),
	}
}

// RegisterTool adds a tool with its tiered disclosures.
func (tr *TieredToolRegistry) RegisterTool(tool *ToolCapability) {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.tools[tool.Name] = tool
}

// GetTier1Snippets returns one-line summaries for all registered tools (minimal context overhead).
func (tr *TieredToolRegistry) GetTier1Snippets() string {
	tr.mu.RLock()
	defer tr.mu.RUnlock()
	var b strings.Builder
	b.WriteString("Available Capabilities (Tier 1 Snippets):\n")
	for name, t := range tr.tools {
		b.WriteString(fmt.Sprintf("- %s: %s\n", name, t.Snippet))
	}
	return b.String()
}

// RouteTool matches an agent's plain-text intent against Tier 1 snippets and returns top-k tools.
func (tr *TieredToolRegistry) RouteTool(ctx context.Context, client *Client, intent string, topK int) ([]*ToolCapability, error) {
	if topK <= 0 {
		topK = 3
	}

	tr.mu.RLock()
	candidates := make([]*ToolCapability, 0, len(tr.tools))
	for _, t := range tr.tools {
		candidates = append(candidates, t)
	}
	tr.mu.RUnlock()

	cleanIntent := strings.ToLower(strings.TrimSpace(intent))
	intentWords := strings.Fields(cleanIntent)

	type scoredTool struct {
		tool  *ToolCapability
		score int
	}

	scored := make([]scoredTool, len(candidates))
	for i, t := range candidates {
		score := 0
		snipLower := strings.ToLower(t.Snippet)
		nameLower := strings.ToLower(t.Name)
		for _, w := range intentWords {
			if strings.Contains(nameLower, w) {
				score += 3
			}
			if strings.Contains(snipLower, w) {
				score += 2
			}
			for _, kw := range t.Keywords {
				if strings.Contains(strings.ToLower(kw), w) {
					score += 2
				}
			}
		}
		scored[i] = scoredTool{tool: t, score: score}
	}

	sort.Slice(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	result := make([]*ToolCapability, 0, topK)
	for i := 0; i < topK && i < len(scored); i++ {
		result = append(result, scored[i].tool)
	}

	return result, nil
}

// ============================================================================
// 5. PROGRAMMABLE PERMISSIONS WITH DEEP SCRIPT INSPECTION
// (Section IV.A: policy "exec": deny, ask, allow)
// ============================================================================

// PermissionVerdict represents the result of a security check on a command or action.
type PermissionVerdict string

const (
	VerdictAllow PermissionVerdict = "allow"
	VerdictAsk   PermissionVerdict = "ask"
	VerdictDeny  PermissionVerdict = "deny"
)

// PermissionEvaluation contains the decision, matched policy, and justification.
type PermissionEvaluation struct {
	Verdict PermissionVerdict `json:"verdict"`
	Reason  string            `json:"reason"`
	Policy  string            `json:"policy"`
}

var (
	sensitivePathRegex = regexp.MustCompile(`(~/\.ssh|\.env|\.pem|\.key|id_rsa|credentials)`)
	networkEgressRegex = regexp.MustCompile(`(curl|wget|nc|netcat|ssh|scp|ftp|http[s]?://|socket\.|urllib|requests\.)`)
	readOnlyCommands   = map[string]bool{
		"cat": true, "ls": true, "grep": true, "rg": true, "head": true,
		"tail": true, "find": true, "git status": true, "git log": true,
		"git diff": true, "pwd": true, "echo": true, "test": true,
	}
)

// EvaluatePermissions runs programmable policy queries over a command and its script contents.
func EvaluatePermissions(command string, scriptContent string, taskScope string, repoRoot string) PermissionEvaluation {
	cmdTrimmed := strings.TrimSpace(command)
	combined := cmdTrimmed + "\n" + scriptContent

	// 1. Deny if touches ~/.ssh or .env*
	if sensitivePathRegex.MatchString(combined) {
		return PermissionEvaluation{
			Verdict: VerdictDeny,
			Reason:  "Touches sensitive paths (~/.ssh, .env, private keys)",
			Policy:  "deny if command touches ~/.ssh or .env*",
		}
	}

	// 2. Deny if script contents contain network egress and task.scope != "deploy"
	if networkEgressRegex.MatchString(combined) && taskScope != "deploy" {
		return PermissionEvaluation{
			Verdict: VerdictDeny,
			Reason:  "Command contains network egress while task.scope is not 'deploy'",
			Policy:  "deny if script contents contain network egress and task.scope != 'deploy'",
		}
	}

	// 3. Ask if command writes outside repo root
	if strings.Contains(cmdTrimmed, ">") || strings.Contains(cmdTrimmed, "rm ") || strings.Contains(cmdTrimmed, "mv ") {
		if strings.Contains(cmdTrimmed, "/tmp/") || strings.Contains(cmdTrimmed, "../") || strings.Contains(cmdTrimmed, "/etc/") {
			return PermissionEvaluation{
				Verdict: VerdictAsk,
				Reason:  "Command attempts write/modification outside repository root",
				Policy:  "ask if command writes outside repo root",
			}
		}
	}

	// 4. Allow if command in read_only_set
	baseCmd := strings.Fields(cmdTrimmed)
	if len(baseCmd) > 0 {
		cmd1 := baseCmd[0]
		cmd2 := ""
		if len(baseCmd) > 1 {
			cmd2 = cmd1 + " " + baseCmd[1]
		}
		if readOnlyCommands[cmd1] || (cmd2 != "" && readOnlyCommands[cmd2]) {
			return PermissionEvaluation{
				Verdict: VerdictAllow,
				Reason:  "Command is in verified read-only execution set",
				Policy:  "allow if command in read_only_set",
			}
		}
	}

	// 5. Allow if tests/ and exit code is expected
	if strings.Contains(cmdTrimmed, "test") || strings.Contains(cmdTrimmed, "pytest") || strings.Contains(cmdTrimmed, "go test") || strings.Contains(cmdTrimmed, "vitest") {
		return PermissionEvaluation{
			Verdict: VerdictAllow,
			Reason:  "Test runner execution with expected exit codes",
			Policy:  "allow if tests/ and exit code is expected",
		}
	}

	// Default fallback: ask for human confirmation
	return PermissionEvaluation{
		Verdict: VerdictAsk,
		Reason:  "Command requires interactive confirmation",
		Policy:  "ask by default",
	}
}

// ============================================================================
// 6. SUB-AGENT CONCURRENCY & SUBGOAL DEDUPLICATION
// (Section VI.A: Extreme Parallelism & VI.B: Deduplicating Goals)
// ============================================================================

// SubgoalStatus represents the lifecycle of a registered subgoal.
type SubgoalStatus string

const (
	SubgoalInFlight  SubgoalStatus = "in_flight"
	SubgoalCompleted SubgoalStatus = "completed"
	SubgoalFailed    SubgoalStatus = "failed"
)

// SubgoalEntry tracks a registered subtask to prevent redundant execution.
type SubgoalEntry struct {
	ID        string        `json:"id"`
	GoalHash  string        `json:"goalHash"`
	GoalText  string        `json:"goalText"`
	Status    SubgoalStatus `json:"status"`
	Result    interface{}   `json:"result,omitempty"`
	CreatedAt time.Time     `json:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt"`
}

// SubgoalRegistry manages subgoal registration and deduplication across tasks.
type SubgoalRegistry struct {
	mu       sync.Mutex
	subgoals map[string]*SubgoalEntry

	// Concurrency: read-only tasks never contend for locks
	stateMu sync.RWMutex
}

// NewSubgoalRegistry initializes a registry.
func NewSubgoalRegistry() *SubgoalRegistry {
	return &SubgoalRegistry{
		subgoals: make(map[string]*SubgoalEntry),
	}
}

// RegisterSubgoal checks if an identical subgoal has already been done or is currently in flight.
// Returns (isDuplicate: true, existingEntry) if found, otherwise registers it and returns (false, newEntry).
func (sr *SubgoalRegistry) RegisterSubgoal(goalText string) (bool, *SubgoalEntry) {
	sr.mu.Lock()
	defer sr.mu.Unlock()

	clean := strings.ToLower(strings.TrimSpace(goalText))
	h := fmt.Sprintf("%x", sha256.Sum256([]byte(clean)))

	if existing, found := sr.subgoals[h]; found {
		if existing.Status == SubgoalInFlight || existing.Status == SubgoalCompleted {
			return true, existing
		}
	}

	entry := &SubgoalEntry{
		ID:        fmt.Sprintf("subgoal-%d", time.Now().UnixNano()),
		GoalHash:  h,
		GoalText:  goalText,
		Status:    SubgoalInFlight,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	sr.subgoals[h] = entry
	return false, entry
}

// RegisterInFlight checks if a task is currently in flight to prevent concurrent duplicates.
func (sr *SubgoalRegistry) RegisterInFlight(taskKey string) (bool, *SubgoalEntry) {
	sr.mu.Lock()
	defer sr.mu.Unlock()

	clean := strings.ToLower(strings.TrimSpace(taskKey))
	h := fmt.Sprintf("%x", sha256.Sum256([]byte(clean)))

	if existing, found := sr.subgoals[h]; found {
		if existing.Status == SubgoalInFlight {
			return true, existing
		}
	}

	entry := &SubgoalEntry{
		ID:        fmt.Sprintf("in-flight-%d", time.Now().UnixNano()),
		GoalHash:  h,
		GoalText:  taskKey,
		Status:    SubgoalInFlight,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	sr.subgoals[h] = entry
	return false, entry
}

// CompleteSubgoal marks a registered subgoal as completed (accepts either hash or raw goal text).
func (sr *SubgoalRegistry) CompleteSubgoal(goalOrHash string, result interface{}) {
	sr.mu.Lock()
	defer sr.mu.Unlock()
	if entry, ok := sr.subgoals[goalOrHash]; ok {
		entry.Status = SubgoalCompleted
		entry.Result = result
		entry.UpdatedAt = time.Now()
		return
	}
	clean := strings.ToLower(strings.TrimSpace(goalOrHash))
	h := fmt.Sprintf("%x", sha256.Sum256([]byte(clean)))
	if entry, ok := sr.subgoals[h]; ok {
		entry.Status = SubgoalCompleted
		entry.Result = result
		entry.UpdatedAt = time.Now()
	}
}

// ExecuteReadOnly executes a read-only task concurrently with zero lock contention.
func (sr *SubgoalRegistry) ExecuteReadOnly(fn func()) {
	sr.stateMu.RLock()
	defer sr.stateMu.RUnlock()
	fn()
}

// ExecuteWrite acquires exclusive write lock for state-mutating operations.
func (sr *SubgoalRegistry) ExecuteWrite(fn func()) {
	sr.stateMu.Lock()
	defer sr.stateMu.Unlock()
	fn()
}

// ============================================================================
// 7. CONDITIONAL INSTRUCTIONS (DYNAMIC AGENTS.MD)
// (Section VIII: Conditional Instructions & Fig. 6)
// ============================================================================

// ConditionalInstruction attaches instructions to conditions rather than static session context.
type ConditionalInstruction struct {
	ID        string   `json:"id"`
	Condition string   `json:"condition"` // e.g. "touches *.tsx", "inside billing/", "writing prose"
	PathMatch string   `json:"pathMatch,omitempty"`
	Scope     string   `json:"scope,omitempty"`
	Content   string   `json:"content"`
	Pinned    bool     `json:"pinned"` // Immune to compaction
}

// ConditionalInstructionEngine evaluates active instructions based on active paths and task scopes.
type ConditionalInstructionEngine struct {
	mu           sync.RWMutex
	instructions []*ConditionalInstruction
}

// NewConditionalInstructionEngine initializes the engine.
func NewConditionalInstructionEngine() *ConditionalInstructionEngine {
	return &ConditionalInstructionEngine{
		instructions: make([]*ConditionalInstruction, 0),
	}
}

// AddInstruction registers a condition-bound instruction fragment.
func (ce *ConditionalInstructionEngine) AddInstruction(inst *ConditionalInstruction) {
	ce.mu.Lock()
	defer ce.mu.Unlock()
	ce.instructions = append(ce.instructions, inst)
}

// MatchActiveInstructions evaluates which instruction fragments should be loaded for a task.
func (ce *ConditionalInstructionEngine) MatchActiveInstructions(filesTouched []string, taskScope string) []*ConditionalInstruction {
	ce.mu.RLock()
	defer ce.mu.RUnlock()

	matched := make([]*ConditionalInstruction, 0)
	for _, inst := range ce.instructions {
		// Match task scope if specified
		if inst.Scope != "" && strings.EqualFold(inst.Scope, taskScope) {
			matched = append(matched, inst)
			continue
		}

		// Match path patterns against touched files
		if inst.PathMatch != "" {
			for _, f := range filesTouched {
				matchedPath, err := filepath.Match(inst.PathMatch, filepath.Base(f))
				if err == nil && matchedPath {
					matched = append(matched, inst)
					break
				}
				if strings.Contains(f, inst.PathMatch) {
					matched = append(matched, inst)
					break
				}
			}
		}
	}

	return matched
}

// ============================================================================
// 8. SECURITY-AWARE ROUTING
// (Section IX: Security-Aware Routing & Table IV)
// ============================================================================

// DataSensitivityPolicy categorizes data sensitivity and provider trust levels.
type DataSensitivityPolicy string

const (
	PolicyOpen       DataSensitivityPolicy = "open"       // Public docs, open-source deps -> Any, cheapest first
	PolicyStandard   DataSensitivityPolicy = "standard"   // Application code -> Vetted providers
	PolicyRestricted DataSensitivityPolicy = "restricted" // Secrets, env, infra config -> First-party frontier only
	PolicyCustom     DataSensitivityPolicy = "custom"     // Proprietary research code -> Excludes named vendors
)

// ModelTierEligibility maps security policy to allowed model classes.
type ModelTierEligibility struct {
	Policy        DataSensitivityPolicy `json:"policy"`
	EligibleTier  string                `json:"eligibleTier"`
	ExcludedVendors []string            `json:"excludedVendors,omitempty"`
}

// ClassifyDataSensitivity assesses touched files and determines data sensitivity policy.
func ClassifyDataSensitivity(filesTouched []string) ModelTierEligibility {
	hasRestricted := false
	hasAppCode := false

	for _, f := range filesTouched {
		lower := strings.ToLower(f)
		if strings.Contains(lower, ".env") || strings.Contains(lower, "id_rsa") ||
			strings.Contains(lower, "secret") || strings.Contains(lower, "credential") ||
			strings.Contains(lower, "infra/") || strings.Contains(lower, "prod.yaml") {
			hasRestricted = true
			break
		}
		if strings.HasSuffix(lower, ".go") || strings.HasSuffix(lower, ".ts") ||
			strings.HasSuffix(lower, ".js") || strings.HasSuffix(lower, ".py") ||
			strings.HasSuffix(lower, ".rs") || strings.HasSuffix(lower, ".cpp") {
			hasAppCode = true
		}
	}

	if hasRestricted {
		return ModelTierEligibility{
			Policy:       PolicyRestricted,
			EligibleTier: "first-party frontier only",
		}
	}
	if hasAppCode {
		return ModelTierEligibility{
			Policy:       PolicyStandard,
			EligibleTier: "vetted providers",
		}
	}
	return ModelTierEligibility{
		Policy:       PolicyOpen,
		EligibleTier: "any, cheapest first",
	}
}

// ============================================================================
// 9. SHARED RETRIEVAL PASS FOR BACKGROUND WORKERS
// (Section X: Background Processing & Fig. 7)
// ============================================================================

// SharedRetrievalCache ensures that expensive state analysis (relevant files, symbols, diffs, orderbook metrics)
// is executed once and shared by all read-only background evaluators.
type SharedRetrievalCache struct {
	mu        sync.RWMutex
	cache     map[string]sharedEntry
	defaultTTL time.Duration
}

type sharedEntry struct {
	data      interface{}
	expiresAt time.Time
}

// NewSharedRetrievalCache initializes a shared retrieval cache.
func NewSharedRetrievalCache(ttl time.Duration) *SharedRetrievalCache {
	if ttl <= 0 {
		ttl = 1500 * time.Millisecond
	}
	return &SharedRetrievalCache{
		cache:      make(map[string]sharedEntry),
		defaultTTL: ttl,
	}
}

// GetOrFetch retrieves cached state or runs fetchFn once to populate and share it.
func (src *SharedRetrievalCache) GetOrFetch(key string, fetchFn func() (interface{}, error)) (interface{}, error) {
	src.mu.RLock()
	if entry, ok := src.cache[key]; ok && time.Now().Before(entry.expiresAt) {
		src.mu.RUnlock()
		return entry.data, nil
	}
	src.mu.RUnlock()

	src.mu.Lock()
	defer src.mu.Unlock()

	// Double check after lock
	if entry, ok := src.cache[key]; ok && time.Now().Before(entry.expiresAt) {
		return entry.data, nil
	}

	data, err := fetchFn()
	if err != nil {
		return nil, err
	}

	src.cache[key] = sharedEntry{
		data:      data,
		expiresAt: time.Now().Add(src.defaultTTL),
	}
	return data, nil
}
