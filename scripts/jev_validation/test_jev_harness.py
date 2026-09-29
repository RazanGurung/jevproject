"""
Unit Test Suite for TypeSafe Jev Engineering Blueprint Harness (Python Implementation).
Validates all 9 core subsystems from Diogo Almeida's design notes.
"""

import unittest
from scripts.jev_validation.jev_harness import (
    ChunkStore, Chunk, ChunkType, VisibilityLevel,
    KVCacheReuseEvaluator, RoutingCostEngine, TieredToolRouter, ToolCapability,
    ProgrammablePermissions, PermissionVerdict, SubgoalDeduplicator, SubgoalStatus,
    ConditionalInstructions, ConditionalInstruction, SecurityAwareRouter, DataSensitivityPolicy,
    SharedRetrievalEngine
)


class TestJevHarnessSubsystems(unittest.TestCase):

    def test_visibility_ladder_and_chunk_store(self):
        store = ChunkStore()
        store.add_chunk(Chunk(
            id="c1",
            chunk_type=ChunkType.FILE_DIFF,
            title="auth/session.py",
            full_content="def get_session(): return current_user_token",
            short_summary="auth token helper",
            long_summary="auth token helper with session validation"
        ))
        store.add_chunk(Chunk(
            id="c2",
            chunk_type=ChunkType.TOOL_OUTPUT,
            title="grep 2400 lines",
            full_content="line 1\nline 2\nline 500: session invalid",
            short_summary="12 hits in session",
            long_summary="12 hits across session and auth"
        ))
        store.add_chunk(Chunk(
            id="c3",
            chunk_type=ChunkType.INSTRUCTION,
            title="system guidelines",
            full_content="Be rigorous, no untested code.",
            pinned=True
        ))

        scored = store.score_visibility("auth session token")
        self.assertEqual(len(scored), 3)

        # Pinned chunk must be full
        pinned_chunk = next(sc for sc in scored if sc.chunk.id == "c3")
        self.assertEqual(pinned_chunk.level, VisibilityLevel.FULL)

        # Assemble context within budget
        prompt, tokens = store.assemble_context(scored, token_budget=500)
        self.assertIn("system guidelines", prompt)
        self.assertIn("auth/session.py", prompt)
        self.assertLessEqual(tokens, 500)

    def test_filter_heatmap(self):
        raw = "error 1\ninfo 2\nCRITICAL KERNEL PANIC OCCURRED\ninfo 3\ninfo 4"
        filtered = ChunkStore.filter_heatmap(raw, "KERNEL PANIC", max_lines=2)
        self.assertIn("CRITICAL KERNEL PANIC OCCURRED", filtered)
        self.assertIn("filtered by relevance", filtered)

    def test_cache_reuse_evaluator(self):
        # Stale cache -> rebuild
        d1 = KVCacheReuseEvaluator.evaluate("state", "new query", cache_age_seconds=400, context_drift=0.8)
        self.assertFalse(d1.reuse_prefix)
        self.assertLess(d1.probability, 0.5)

        # Fresh cache -> reuse
        d2 = KVCacheReuseEvaluator.evaluate("state", "new query", cache_age_seconds=10, context_drift=0.1)
        self.assertTrue(d2.reuse_prefix)
        self.assertGreaterEqual(d2.probability, 0.7)

    def test_routing_trap_arithmetic(self):
        # Section II.A session shape: X = 0.65, Y = 0.12, Z = 0.23
        # Pure Opus = 25*0.12 + 5*0.23 = 4.15
        # Naive Routed = 3*0.65 + 20*0.12 + 8*0.23 = 6.19
        estimate = RoutingCostEngine.calculate(0.65, 0.12, 0.23, subtask_x_prime=0.05, summary_y=0.02)
        self.assertAlmostEqual(estimate.pure_frontier_cost, 4.15, places=2)
        self.assertAlmostEqual(estimate.naive_routed_cost, 6.19, places=2)
        self.assertTrue(estimate.trapped_in_cost)

        # Purpose-built route (small X') should be cheaper than pure frontier
        self.assertLess(estimate.purpose_built_cost, estimate.pure_frontier_cost)
        self.assertEqual(estimate.recommended_route, "purpose_built_subagent")

    def test_tiered_tool_router(self):
        router = TieredToolRouter()
        router.register_tool(ToolCapability(
            name="ast-grep",
            category="search",
            snippet="Structural syntax search across code trees",
            schema_json='{"query": "pattern"}',
            docs="Detailed usage...",
            keywords=["ast", "pattern", "syntax"]
        ))
        router.register_tool(ToolCapability(
            name="git-diff",
            category="vcs",
            snippet="Show git diff changes between commits",
            schema_json='{}',
            docs="",
            keywords=["git", "diff", "commits"]
        ))

        snippets = router.get_tier1_snippets()
        self.assertIn("ast-grep: Structural syntax search", snippets)

        matched = router.route_tool("find syntax tree patterns", top_k=1)
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0].name, "ast-grep")

    def test_programmable_permissions(self):
        # 1. Deny touches .ssh or .env
        ev1 = ProgrammablePermissions.evaluate("cat ~/.ssh/id_rsa")
        self.assertEqual(ev1.verdict, PermissionVerdict.DENY)

        ev2 = ProgrammablePermissions.evaluate("cat .env")
        self.assertEqual(ev2.verdict, PermissionVerdict.DENY)

        # 2. Deny network egress if not deploy
        ev3 = ProgrammablePermissions.evaluate("python run.py", script_content="import requests; requests.get('http://x')")
        self.assertEqual(ev3.verdict, PermissionVerdict.DENY)

        # 3. Allow read-only
        ev4 = ProgrammablePermissions.evaluate("git status")
        self.assertEqual(ev4.verdict, PermissionVerdict.ALLOW)

        # 4. Allow tests
        ev5 = ProgrammablePermissions.evaluate("pytest tests/")
        self.assertEqual(ev5.verdict, PermissionVerdict.ALLOW)

    def test_subgoal_deduplication(self):
        dedup = SubgoalDeduplicator()

        is_dup, entry1 = dedup.register_subgoal("audit memory leaks")
        self.assertFalse(is_dup)
        self.assertEqual(entry1.status, SubgoalStatus.IN_FLIGHT)

        # Duplicate in-flight goal detected
        is_dup2, entry2 = dedup.register_subgoal("audit memory leaks")
        self.assertTrue(is_dup2)
        self.assertEqual(entry2.id, entry1.id)

        # Complete goal
        dedup.complete_subgoal(entry1.goal_hash, "leak found in cache")
        is_dup3, entry3 = dedup.register_subgoal("audit memory leaks")
        self.assertTrue(is_dup3)
        self.assertEqual(entry3.status, SubgoalStatus.COMPLETED)

    def test_conditional_instructions(self):
        engine = ConditionalInstructions()
        engine.add_instruction(ConditionalInstruction(
            id="tsx-style",
            condition="touches *.tsx",
            path_match="*.tsx",
            content="Use React hooks cleanly."
        ))
        engine.add_instruction(ConditionalInstruction(
            id="billing-rules",
            condition="inside billing/",
            path_match="billing/",
            content="Never drop currency precision."
        ))

        matched = engine.match_active(["web/src/App.tsx"])
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0].id, "tsx-style")

        matched_billing = engine.match_active(["src/billing/invoice.py"])
        self.assertEqual(len(matched_billing), 1)
        self.assertEqual(matched_billing[0].id, "billing-rules")

    def test_security_aware_routing(self):
        # Restricted
        s1 = SecurityAwareRouter.classify(["infra/prod.yaml", "auth/keys.pem"])
        self.assertEqual(s1.policy, DataSensitivityPolicy.RESTRICTED)
        self.assertEqual(s1.eligible_tier, "first-party frontier only")

        # Standard
        s2 = SecurityAwareRouter.classify(["src/app.py", "web/index.js"])
        self.assertEqual(s2.policy, DataSensitivityPolicy.STANDARD)
        self.assertEqual(s2.eligible_tier, "vetted providers")

        # Open
        s3 = SecurityAwareRouter.classify(["README.md", "docs/architecture.md"])
        self.assertEqual(s3.policy, DataSensitivityPolicy.OPEN)
        self.assertEqual(s3.eligible_tier, "any, cheapest first")

    def test_shared_retrieval_engine(self):
        shared = SharedRetrievalEngine(default_ttl=0.2)
        call_count = 0

        def fetch():
            nonlocal call_count
            call_count += 1
            return {"metrics": "parsed"}

        res1 = shared.get_or_fetch("state_key", fetch)
        res2 = shared.get_or_fetch("state_key", fetch)

        self.assertEqual(res1, res2)
        self.assertEqual(call_count, 1)  # Only fetched once!


if __name__ == "__main__":
    unittest.main()
