package typesafe

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVisibilityLadderAndChunkStore(t *testing.T) {
	cs := NewChunkStore()

	cs.AddChunk(&Chunk{
		ID:           "chunk-auth",
		Type:         ChunkTypeFileDiff,
		Title:        "file: auth/session.ts",
		FullContent:  "export function getSession() { return activeSession; }",
		ShortSummary: "auth session handler",
		LongSummary:  "auth session handler with token validation",
		EstimatedTok: 20,
	})

	cs.AddChunk(&Chunk{
		ID:           "chunk-grep",
		Type:         ChunkTypeToolOutput,
		Title:        "grep output, 2,400 lines",
		FullContent:  "Line 1: error\nLine 2: info\nLine 100: auth/session.ts matched token",
		ShortSummary: "12 hits in auth and sessions",
		LongSummary:  "12 hits across auth/session.ts and middleware",
		EstimatedTok: 600,
	})

	cs.AddChunk(&Chunk{
		ID:           "chunk-system",
		Type:         ChunkTypeInstruction,
		Title:        "system rules",
		FullContent:  "Be concise, follow strict guidelines.",
		Pinned:       true,
		EstimatedTok: 10,
	})

	// Score visibility for query "auth session"
	ctx := context.Background()
	scored, err := cs.ScoreVisibility(ctx, nil, "auth session")
	if err != nil {
		t.Fatalf("ScoreVisibility failed: %v", err)
	}

	if len(scored) != 3 {
		t.Fatalf("expected 3 scored chunks, got %d", len(scored))
	}

	// Pinned chunk must always be full
	var pinnedFound bool
	for _, sc := range scored {
		if sc.Chunk.ID == "chunk-system" {
			pinnedFound = true
			if sc.Level != VisibilityFull {
				t.Errorf("pinned chunk should be VisibilityFull, got %s", sc.Level)
			}
		}
	}
	if !pinnedFound {
		t.Error("pinned chunk not found in scored results")
	}

	// Context assembly with token budget
	prompt, tokens := cs.AssembleContext(scored, 300)
	if !strings.Contains(prompt, "system rules") {
		t.Error("assembled context must include pinned system rules")
	}
	if !strings.Contains(prompt, "auth/session.ts") {
		t.Error("assembled context must include relevant auth chunk")
	}
	if tokens > 300 {
		t.Errorf("assembled tokens %d exceeded budget 300", tokens)
	}
}

func TestFilterHeatmap(t *testing.T) {
	raw := "line 1: noise\nline 2: noise\nline 3: critical match found\nline 4: noise\nline 5: noise\nline 6: match again"
	filtered := FilterHeatmap(raw, "critical match", 2)

	if !strings.Contains(filtered, "critical match found") {
		t.Error("expected heatmap to keep critical match line")
	}
	if !strings.Contains(filtered, "filtered by relevance") {
		t.Error("expected heatmap to indicate filtered lines")
	}
}

func TestRoutingTrapArithmetic(t *testing.T) {
	// From Section II.A of the paper:
	// X = 0.65, Y = 0.12, Z = 0.23
	// Pure Opus = 25*0.12 + 5*0.23 = 3.00 + 1.15 = 4.15
	// Naive Routed = 3*0.65 + 20*0.12 + 8*0.23 = 1.95 + 2.40 + 1.84 = 6.19
	res := CalculateRoutingCosts(0.65, 0.12, 0.23, 0.05, 0.02)

	if mathAbs(res.PureFrontierCost-4.15) > 0.01 {
		t.Errorf("expected PureFrontierCost ~4.15, got %.2f", res.PureFrontierCost)
	}
	if mathAbs(res.NaiveRoutedCost-6.19) > 0.01 {
		t.Errorf("expected NaiveRoutedCost ~6.19, got %.2f", res.NaiveRoutedCost)
	}
	if !res.TrappedInCost {
		t.Error("expected TrappedInCost to be true for naive routing")
	}

	// Purpose-built context (X' = 0.05, summary = 0.02) should save money
	// 3*0.05 + 15*0.12 + 3*0.23 + 5*0.02 = 0.15 + 1.80 + 0.69 + 0.10 = 2.74 < 4.15
	if res.PurposeBuiltCost >= res.PureFrontierCost {
		t.Errorf("purpose-built routing should be cheaper than frontier, got %.2f vs %.2f", res.PurposeBuiltCost, res.PureFrontierCost)
	}
	if res.RecommendedRoute != "purpose_built_subagent" {
		t.Errorf("expected recommended route purpose_built_subagent, got %s", res.RecommendedRoute)
	}
}

func TestTieredToolRouter(t *testing.T) {
	reg := NewTieredToolRegistry()
	reg.RegisterTool(&ToolCapability{
		Name:     "ast-grep",
		Category: "search",
		Snippet:  "Structural code search across AST syntax trees",
		Keywords: []string{"ast", "search", "syntax", "pattern"},
	})
	reg.RegisterTool(&ToolCapability{
		Name:     "git-diff",
		Category: "vcs",
		Snippet:  "Show file diffs and repository commit changes",
		Keywords: []string{"git", "diff", "commit", "changes"},
	})
	reg.RegisterTool(&ToolCapability{
		Name:     "run-tests",
		Category: "testing",
		Snippet:  "Execute unit and integration test suites",
		Keywords: []string{"test", "vitest", "go test", "runner"},
	})

	snippets := reg.GetTier1Snippets()
	if !strings.Contains(snippets, "ast-grep: Structural code search") {
		t.Error("Tier 1 snippets missing ast-grep")
	}

	ctx := context.Background()
	matched, err := reg.RouteTool(ctx, nil, "find structural syntax patterns in codebase", 1)
	if err != nil {
		t.Fatalf("RouteTool failed: %v", err)
	}
	if len(matched) != 1 || matched[0].Name != "ast-grep" {
		t.Errorf("expected ast-grep to be selected, got %+v", matched)
	}
}

func TestProgrammablePermissions(t *testing.T) {
	// 1. Deny touches ~/.ssh or .env*
	eval1 := EvaluatePermissions("cat ~/.ssh/id_rsa", "", "general", "/repo")
	if eval1.Verdict != VerdictDeny {
		t.Errorf("expected deny for ~/.ssh, got %s", eval1.Verdict)
	}

	eval2 := EvaluatePermissions("cat .env.production", "", "general", "/repo")
	if eval2.Verdict != VerdictDeny {
		t.Errorf("expected deny for .env, got %s", eval2.Verdict)
	}

	// 2. Deny network egress if not deploy
	eval3 := EvaluatePermissions("python script.py", "import urllib.request; urllib.request.urlopen('http://evil.com')", "debug", "/repo")
	if eval3.Verdict != VerdictDeny {
		t.Errorf("expected deny for network egress in debug scope, got %s", eval3.Verdict)
	}

	// 3. Allow read-only commands
	eval4 := EvaluatePermissions("git status", "", "general", "/repo")
	if eval4.Verdict != VerdictAllow {
		t.Errorf("expected allow for git status, got %s", eval4.Verdict)
	}

	// 4. Allow test runner
	eval5 := EvaluatePermissions("go test ./...", "", "testing", "/repo")
	if eval5.Verdict != VerdictAllow {
		t.Errorf("expected allow for go test, got %s", eval5.Verdict)
	}
}

func TestSubgoalDeduplicationAndConcurrency(t *testing.T) {
	sr := NewSubgoalRegistry()

	isDup1, entry1 := sr.RegisterSubgoal("explore repo auth architecture")
	if isDup1 {
		t.Error("initial registration should not be marked duplicate")
	}

	isDup2, entry2 := sr.RegisterSubgoal("explore repo auth architecture")
	if !isDup2 {
		t.Error("second identical registration should be marked duplicate")
	}
	if entry2.ID != entry1.ID {
		t.Errorf("expected duplicate to return existing entry ID %s, got %s", entry1.ID, entry2.ID)
	}

	sr.CompleteSubgoal(entry1.GoalHash, "findings: auth uses jwt tokens")

	// Even completed, same goal should be identified as duplicate
	isDup3, _ := sr.RegisterSubgoal("explore repo auth architecture")
	if !isDup3 {
		t.Error("completed goal should still be recognized as duplicate")
	}

	// Verify read concurrency
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sr.ExecuteReadOnly(func() {
				time.Sleep(5 * time.Millisecond)
			})
		}()
	}
	wg.Wait()
}

func TestConditionalInstructionsEngine(t *testing.T) {
	ce := NewConditionalInstructionEngine()
	ce.AddInstruction(&ConditionalInstruction{
		ID:        "frontend-style",
		Condition: "touches *.tsx",
		PathMatch: "*.tsx",
		Content:   "Use strict Tailwind classes and accessible ARIA attributes.",
		Pinned:    true,
	})
	ce.AddInstruction(&ConditionalInstruction{
		ID:        "billing-gotchas",
		Condition: "inside billing/",
		PathMatch: "billing/",
		Content:   "Always check currency decimal precision before charging.",
		Pinned:    true,
	})

	matched := ce.MatchActiveInstructions([]string{"web/components/Button.tsx"}, "dev")
	if len(matched) != 1 || matched[0].ID != "frontend-style" {
		t.Errorf("expected frontend-style matched, got %+v", matched)
	}

	matchedBilling := ce.MatchActiveInstructions([]string{"src/billing/charge.go"}, "dev")
	if len(matchedBilling) != 1 || matchedBilling[0].ID != "billing-gotchas" {
		t.Errorf("expected billing-gotchas matched, got %+v", matchedBilling)
	}
}

func TestSecurityAwareRouting(t *testing.T) {
	// Secret files -> restricted
	res1 := ClassifyDataSensitivity([]string{"config/prod.yaml", "auth/.env.local"})
	if res1.Policy != PolicyRestricted || res1.EligibleTier != "first-party frontier only" {
		t.Errorf("expected restricted policy, got %+v", res1)
	}

	// App code -> standard
	res2 := ClassifyDataSensitivity([]string{"internal/services/bot.go", "web/src/main.js"})
	if res2.Policy != PolicyStandard || res2.EligibleTier != "vetted providers" {
		t.Errorf("expected standard policy, got %+v", res2)
	}

	// Docs / public -> open
	res3 := ClassifyDataSensitivity([]string{"README.md", "docs/API.md"})
	if res3.Policy != PolicyOpen || res3.EligibleTier != "any, cheapest first" {
		t.Errorf("expected open policy, got %+v", res3)
	}
}

func TestSharedRetrievalCache(t *testing.T) {
	cache := NewSharedRetrievalCache(100 * time.Millisecond)
	fetchCount := 0

	fetchFn := func() (interface{}, error) {
		fetchCount++
		return "shared market depth snapshot", nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := cache.GetOrFetch("BTC:depth", fetchFn)
			if err != nil || res != "shared market depth snapshot" {
				t.Errorf("unexpected fetch result: %v, %v", res, err)
			}
		}()
	}
	wg.Wait()

	if fetchCount != 1 {
		t.Errorf("expected fetchFn to execute exactly once, got %d", fetchCount)
	}
}

func mathAbs(a float64) float64 {
	if a < 0 {
		return -a
	}
	return a
}
