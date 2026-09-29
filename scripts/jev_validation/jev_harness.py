"""
TypeSafe Jev Engineering Blueprint Reference Implementation.
Implements the architectural principles from Diogo Almeida's design notes:
- Meta-Attention: Context as a Decision & The Visibility Ladder (hide, short, long, full)
- KV Cache Reuse vs Rebuild evaluation (noul decision + probability)
- Model Routing Cost Arithmetic & The Routing Trap (Pure Opus vs Naive Routed vs Purpose-Built)
- Tiered Tool Router: Tier 1 Snippets -> Tier 2 Schema on Demand -> Tier 3 Docs
- Programmable Permissions with Deep Script Inspection (allow, ask, deny)
- Sub-Agent Concurrency (Read-only tasks never contend) & Subgoal Deduplication
- Conditional Instructions (Dynamic AGENTS.md bound to conditions)
- Security-Aware Routing by Data Sensitivity (open, standard, restricted, custom)
- Shared Retrieval Engine for Read-Only Background Workers

Zero external dependencies. Standard library Python 3.9+ only.
"""

import hashlib
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple


# ============================================================================
# 1. VISIBILITY LADDER & ADDRESSABLE CHUNK STORE
# (Section V: Meta-Attention & Fig. 4)
# ============================================================================

class VisibilityLevel(str, Enum):
    HIDE = "hide"    # 0 tokens in prompt context
    SHORT = "short"  # 1-line summary / key hits
    LONG = "long"    # Trace + cause / detailed metrics
    FULL = "full"    # Full raw content


class ChunkType(str, Enum):
    TOOL_CALL = "tool_call"
    TOOL_OUTPUT = "tool_output"
    REASONING = "reasoning"
    USER_TURN = "user_turn"
    FILE_DIFF = "file_diff"
    INSTRUCTION = "instruction"
    MARKET_STATE = "market_state"


@dataclass
class Chunk:
    id: str
    chunk_type: ChunkType
    title: str
    full_content: str
    short_summary: str = ""
    long_summary: str = ""
    estimated_tokens: int = 0
    pinned: bool = False  # Immune to compaction / hiding
    level: VisibilityLevel = VisibilityLevel.FULL

    def __post_init__(self):
        if self.estimated_tokens <= 0:
            self.estimated_tokens = max(1, int(math.ceil(len(self.full_content) / 4.0)))


@dataclass
class ScoredChunk:
    chunk: Chunk
    level: VisibilityLevel
    relevance: float
    tokens_used: int


class ChunkStore:
    """Maintains explicit addressable state chunks scored per query."""

    def __init__(self):
        self._chunks: Dict[str, Chunk] = {}
        self._order: List[str] = []
        self._lock = threading.RLock()

    def add_chunk(self, chunk: Chunk) -> None:
        with self._lock:
            if chunk.id not in self._chunks:
                self._order.append(chunk.id)
            self._chunks[chunk.id] = chunk

    def get_chunk(self, chunk_id: str) -> Optional[Chunk]:
        with self._lock:
            return self._chunks.get(chunk_id)

    def list_chunks(self) -> List[Chunk]:
        with self._lock:
            return [self._chunks[cid] for cid in self._order if cid in self._chunks]

    def score_visibility(self, query: str) -> List[ScoredChunk]:
        """Evaluates visibility ladder levels per chunk for the current query."""
        with self._lock:
            chunks = self.list_chunks()

        clean_query = query.lower().strip()
        query_tokens = clean_query.split()

        scored: List[ScoredChunk] = []
        for c in chunks:
            if c.pinned:
                scored.append(ScoredChunk(
                    chunk=c,
                    level=VisibilityLevel.FULL,
                    relevance=1.0,
                    tokens_used=c.estimated_tokens
                ))
                continue

            title_lower = c.title.lower()
            content_lower = c.full_content.lower()
            matches = 0
            for t in query_tokens:
                if t in title_lower:
                    matches += 2
                elif t in content_lower:
                    matches += 1

            relevance = 0.0
            if query_tokens:
                relevance = min(1.0, matches / float(len(query_tokens) * 2))

            if relevance >= 0.70:
                lvl = VisibilityLevel.FULL
                tok = c.estimated_tokens
            elif relevance >= 0.35:
                lvl = VisibilityLevel.LONG
                tok = max(1, int(math.ceil(len(c.long_summary) / 4.0))) if c.long_summary else int(math.ceil(c.estimated_tokens * 0.4))
            elif relevance > 0.05:
                lvl = VisibilityLevel.SHORT
                tok = max(1, int(math.ceil(len(c.short_summary) / 4.0))) if c.short_summary else int(math.ceil(c.estimated_tokens * 0.15))
            else:
                lvl = VisibilityLevel.HIDE
                tok = 0

            scored.append(ScoredChunk(
                chunk=c,
                level=lvl,
                relevance=relevance,
                tokens_used=tok
            ))

        return scored

    def assemble_context(self, scored: List[ScoredChunk], token_budget: int = 4000) -> Tuple[str, int]:
        """Assembles prompt context from scored chunks adhering to token budget."""
        sections: List[str] = []
        total_tokens = 0

        # Pinned chunks always first
        for sc in scored:
            if sc.chunk.pinned:
                sections.append(f"=== [{sc.chunk.chunk_type.value}: {sc.chunk.title}] ===\n{sc.chunk.full_content}")
                total_tokens += sc.tokens_used

        # Sort remaining by relevance descending
        unpinned = [sc for sc in scored if not sc.chunk.pinned and sc.level != VisibilityLevel.HIDE]
        unpinned.sort(key=lambda s: s.relevance, reverse=True)

        for sc in unpinned:
            if token_budget > 0 and total_tokens + sc.tokens_used > token_budget:
                # Down-ladder fallback
                if sc.level == VisibilityLevel.FULL and sc.chunk.short_summary:
                    short_tok = max(1, int(math.ceil(len(sc.chunk.short_summary) / 4.0)))
                    if total_tokens + short_tok <= token_budget:
                        sections.append(f"=== [{sc.chunk.chunk_type.value}: {sc.chunk.title} (summary)] ===\n{sc.chunk.short_summary}")
                        total_tokens += short_tok
                continue

            if sc.level == VisibilityLevel.FULL:
                text = sc.chunk.full_content
            elif sc.level == VisibilityLevel.LONG:
                text = sc.chunk.long_summary or sc.chunk.full_content
            elif sc.level == VisibilityLevel.SHORT:
                text = sc.chunk.short_summary or sc.chunk.full_content
            else:
                continue

            sections.append(f"=== [{sc.chunk.chunk_type.value}: {sc.chunk.title} ({sc.level.value})] ===\n{text}")
            total_tokens += sc.tokens_used

        return "\n\n".join(sections).strip(), total_tokens

    @staticmethod
    def filter_heatmap(raw_output: str, query: str, max_lines: int = 20) -> str:
        """Filters large outputs (e.g. 2,400-line grep results) to relevant lines."""
        lines = raw_output.splitlines()
        if len(lines) <= max_lines:
            return raw_output

        terms = query.lower().split()
        scored_lines = []
        for i, line in enumerate(lines):
            lower = line.lower()
            score = sum(1 for term in terms if term in lower)
            scored_lines.append((score, i, line))

        scored_lines.sort(key=lambda x: x[0], reverse=True)
        selected_indices = set()
        for score, idx, _ in scored_lines[:max_lines]:
            if score > 0 or len(selected_indices) < 5:
                selected_indices.add(idx)

        result: List[str] = []
        omitted = False
        for i, line in enumerate(lines):
            if i in selected_indices:
                omitted = False
                result.append(line)
            elif not omitted:
                result.append(f"... [lines {i+1}+ filtered by relevance] ...")
                omitted = True

        return "\n".join(result)


# ============================================================================
# 2. KV CACHE REUSE DECISION
# (Section V & Table I: "Reuse the cached prefix or rebuild? -> noul + probability")
# ============================================================================

@dataclass
class CacheReuseDecision:
    reuse_prefix: bool
    probability: float
    reason: str


class KVCacheReuseEvaluator:
    """Evaluates whether reusing cached prefix or rebuilding context is cheaper and cleaner."""

    @staticmethod
    def evaluate(
        session_state: str,
        query: str,
        cache_age_seconds: float,
        context_drift: float
    ) -> CacheReuseDecision:
        if cache_age_seconds > 300.0 or context_drift > 0.60:
            return CacheReuseDecision(
                reuse_prefix=False,
                probability=0.18,
                reason="High context drift or stale cached prefix (>5 min), rebuild context"
            )
        return CacheReuseDecision(
            reuse_prefix=True,
            probability=0.88,
            reason="Prefix cache intact with low context drift, reuse prefix"
        )


# ============================================================================
# 3. MODEL ROUTING ARITHMETIC & THE ROUTING TRAP
# (Section II.A & Fig. 2)
# ============================================================================

@dataclass
class RoutingCostEstimate:
    pure_frontier_cost: float
    naive_routed_cost: float
    purpose_built_cost: float
    routing_advantage: float
    trapped_in_cost: bool
    recommended_route: str


class RoutingCostEngine:
    """
    Implements Diogo Almeida's exact routing trap pricing formulas:
    - Pure Opus: 25*Y + 5*Z
    - Naive Routed: 3*X + 20*Y + 8*Z (where Sonnet loads 3*X, generates 15*Y, reads 3*Z, Opus reloads 5*(Y+Z))
    - Purpose-Built Subtask: 3*X' + 15*Y + 3*Z + 5*Y_summary
    """

    @staticmethod
    def calculate(
        context_x: float,        # context tokens in millions
        gen_y: float,            # generated output tokens in millions
        read_z: float,           # tokens read during work in millions
        subtask_x_prime: float = 0.0,  # small purpose-built context tokens
        summary_y: float = 0.0         # compact summary merged back
    ) -> RoutingCostEstimate:
        # Path 1: Pure Opus: 25*Y + 5*Z
        pure_frontier = 25.0 * gen_y + 5.0 * read_z

        # Path 2: Naive Opus -> Sonnet -> Opus: 3*X + 20*Y + 8*Z
        naive_routed = 3.0 * context_x + 20.0 * gen_y + 8.0 * read_z

        # Path 3: Purpose-Built Context
        x_prime = subtask_x_prime if subtask_x_prime > 0 else context_x * 0.10
        y_sum = summary_y if summary_y > 0 else gen_y * 0.15
        purpose_built = 3.0 * x_prime + 15.0 * gen_y + 3.0 * read_z + 5.0 * y_sum

        trapped = naive_routed > pure_frontier
        advantage = pure_frontier - purpose_built
        rec_route = "purpose_built_subagent" if advantage > 0 else "frontier"

        return RoutingCostEstimate(
            pure_frontier_cost=round(pure_frontier, 4),
            naive_routed_cost=round(naive_routed, 4),
            purpose_built_cost=round(purpose_built, 4),
            routing_advantage=round(advantage, 4),
            trapped_in_cost=trapped,
            recommended_route=rec_route
        )


# ============================================================================
# 4. TIERED TOOL ROUTER (HARNESS AS TOOL ROUTER)
# (Section IV.B, VII & Fig. 5)
# ============================================================================

@dataclass
class ToolCapability:
    name: str
    category: str
    snippet: str        # Tier 1: 1-line summary
    schema_json: str    # Tier 2: full argument schema
    docs: str           # Tier 3: deep documentation
    keywords: List[str] = field(default_factory=list)


class TieredToolRouter:
    """Manages tiered disclosure of tools: Snippets -> Schema on Demand -> Docs."""

    def __init__(self):
        self._tools: Dict[str, ToolCapability] = {}
        self._lock = threading.RLock()

    def register_tool(self, tool: ToolCapability) -> None:
        with self._lock:
            self._tools[tool.name] = tool

    def get_tier1_snippets(self) -> str:
        """Returns one-line summaries for all tools with minimal context footprint."""
        with self._lock:
            lines = ["Available Capabilities (Tier 1 Snippets):"]
            for name, t in self._tools.items():
                lines.append(f"- {name}: {t.snippet}")
            return "\n".join(lines)

    def route_tool(self, intent: str, top_k: int = 3) -> List[ToolCapability]:
        """Matches plain-text intent against Tier 1 snippets and returns top-k tools."""
        with self._lock:
            tools = list(self._tools.values())

        intent_words = intent.lower().strip().split()
        scored = []
        for t in tools:
            score = 0
            name_lower = t.name.lower()
            snip_lower = t.snippet.lower()
            for w in intent_words:
                if w in name_lower:
                    score += 3
                if w in snip_lower:
                    score += 2
                for kw in t.keywords:
                    if w in kw.lower():
                        score += 2
            scored.append((score, t))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [t for _, t in scored[:top_k]]


# ============================================================================
# 5. PROGRAMMABLE PERMISSIONS WITH DEEP SCRIPT INSPECTION
# (Section IV.A)
# ============================================================================

class PermissionVerdict(str, Enum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


@dataclass
class PermissionEvaluation:
    verdict: PermissionVerdict
    reason: str
    policy: str


class ProgrammablePermissions:
    """Inspects command lines and full script contents against programmable policies."""

    SENSITIVE_REGEX = re.compile(r"(~/\.ssh|\.env|\.pem|\.key|id_rsa|credentials)", re.IGNORECASE)
    EGRESS_REGEX = re.compile(r"(curl|wget|nc|netcat|ssh|scp|ftp|http[s]?://|socket\.|urllib|requests\.)", re.IGNORECASE)
    READ_ONLY_COMMANDS = {
        "cat", "ls", "grep", "rg", "head", "tail", "find", "git status",
        "git log", "git diff", "pwd", "echo", "test"
    }

    @classmethod
    def evaluate(
        cls,
        command: str,
        script_content: str = "",
        task_scope: str = "general",
        repo_root: str = "/repo"
    ) -> PermissionEvaluation:
        combined = (command + "\n" + script_content).strip()

        # 1. Deny if touches ~/.ssh or .env*
        if cls.SENSITIVE_REGEX.search(combined):
            return PermissionEvaluation(
                verdict=PermissionVerdict.DENY,
                reason="Touches sensitive credentials (~/.ssh, .env, private keys)",
                policy="deny if command touches ~/.ssh or .env*"
            )

        # 2. Deny if script contents contain network egress and task.scope != "deploy"
        if cls.EGRESS_REGEX.search(combined) and task_scope != "deploy":
            return PermissionEvaluation(
                verdict=PermissionVerdict.DENY,
                reason="Command contains network egress while task.scope is not 'deploy'",
                policy="deny if script contents contain network egress and task.scope != 'deploy'"
            )

        # 3. Ask if command writes outside repo root
        if any(w in command for w in (">", "rm ", "mv ")):
            if any(p in command for p in ("/tmp/", "../", "/etc/")):
                return PermissionEvaluation(
                    verdict=PermissionVerdict.ASK,
                    reason="Command attempts write/modification outside repository root",
                    policy="ask if command writes outside repo root"
                )

        # 4. Allow if command in read_only_set
        parts = command.strip().split()
        if parts:
            cmd1 = parts[0]
            cmd2 = f"{parts[0]} {parts[1]}" if len(parts) > 1 else ""
            if cmd1 in cls.READ_ONLY_COMMANDS or cmd2 in cls.READ_ONLY_COMMANDS:
                return PermissionEvaluation(
                    verdict=PermissionVerdict.ALLOW,
                    reason="Command is in verified read-only execution set",
                    policy="allow if command in read_only_set"
                )

        # 5. Allow if tests/ and exit code is expected
        if any(t in command for t in ("test", "pytest", "go test", "vitest")):
            return PermissionEvaluation(
                verdict=PermissionVerdict.ALLOW,
                reason="Test runner execution with expected exit codes",
                policy="allow if tests/ and exit code is expected"
            )

        return PermissionEvaluation(
            verdict=PermissionVerdict.ASK,
            reason="Command requires interactive confirmation",
            policy="ask by default"
        )


# ============================================================================
# 6. SUBGOAL DEDUPLICATION & CONCURRENCY
# (Section VI.A & VI.B)
# ============================================================================

class SubgoalStatus(str, Enum):
    IN_FLIGHT = "in_flight"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class SubgoalEntry:
    id: str
    goal_hash: str
    goal_text: str
    status: SubgoalStatus
    result: Any = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class SubgoalDeduplicator:
    """Prevents duplicate work from launching twice and manages read/write concurrency."""

    def __init__(self):
        self._subgoals: Dict[str, SubgoalEntry] = {}
        self._lock = threading.Lock()
        self._state_lock = threading.RLock()

    def register_subgoal(self, goal_text: str) -> Tuple[bool, SubgoalEntry]:
        clean = goal_text.lower().strip()
        h = hashlib.sha256(clean.encode("utf-8")).hexdigest()

        with self._lock:
            if h in self._subgoals:
                existing = self._subgoals[h]
                if existing.status in (SubgoalStatus.IN_FLIGHT, SubgoalStatus.COMPLETED):
                    return True, existing

            entry = SubgoalEntry(
                id=f"subgoal-{time.time_ns()}",
                goal_hash=h,
                goal_text=goal_text,
                status=SubgoalStatus.IN_FLIGHT
            )
            self._subgoals[h] = entry
            return False, entry

    def complete_subgoal(self, goal_or_hash: str, result: Any) -> None:
        clean = goal_or_hash.lower().strip()
        h = hashlib.sha256(clean.encode("utf-8")).hexdigest()
        with self._lock:
            if goal_or_hash in self._subgoals:
                entry = self._subgoals[goal_or_hash]
                entry.status = SubgoalStatus.COMPLETED
                entry.result = result
                entry.updated_at = time.time()
                return
            if h in self._subgoals:
                entry = self._subgoals[h]
                entry.status = SubgoalStatus.COMPLETED
                entry.result = result
                entry.updated_at = time.time()

    def execute_read_only(self, fn: Callable[[], Any]) -> Any:
        """Executes read-only operations concurrently with zero lock contention."""
        # Read-only operations never contend for state write locks
        return fn()

    def execute_write(self, fn: Callable[[], Any]) -> Any:
        """Serializes state-mutating operations under an exclusive write lock."""
        with self._state_lock:
            return fn()


# ============================================================================
# 7. CONDITIONAL INSTRUCTIONS (DYNAMIC AGENTS.MD)
# (Section VIII & Fig. 6)
# ============================================================================

@dataclass
class ConditionalInstruction:
    id: str
    condition: str
    path_match: str = ""
    scope: str = ""
    content: str = ""
    pinned: bool = True


class ConditionalInstructions:
    """Dynamically attaches instruction fragments to conditions rather than static session context."""

    def __init__(self):
        self._instructions: List[ConditionalInstruction] = []
        self._lock = threading.RLock()

    def add_instruction(self, inst: ConditionalInstruction) -> None:
        with self._lock:
            self._instructions.append(inst)

    def match_active(self, files_touched: List[str], task_scope: str = "") -> List[ConditionalInstruction]:
        with self._lock:
            instructions = list(self._instructions)

        matched: List[ConditionalInstruction] = []
        for inst in instructions:
            if inst.scope and inst.scope.lower() == task_scope.lower():
                matched.append(inst)
                continue

            if inst.path_match:
                for f in files_touched:
                    if inst.path_match in f or os.path.basename(f).endswith(inst.path_match.replace("*", "")):
                        matched.append(inst)
                        break

        return matched


# ============================================================================
# 8. SECURITY-AWARE ROUTING
# (Section IX & Table IV)
# ============================================================================

class DataSensitivityPolicy(str, Enum):
    OPEN = "open"              # Public docs -> Any, cheapest first
    STANDARD = "standard"      # Application code -> Vetted providers
    RESTRICTED = "restricted"  # Secrets, env, infra -> First-party frontier only
    CUSTOM = "custom"          # Proprietary research -> Excludes named vendors


@dataclass
class SecurityRouteResult:
    policy: DataSensitivityPolicy
    eligible_tier: str


class SecurityAwareRouter:
    """Routes tasks to model tiers based on data sensitivity of files touched."""

    @staticmethod
    def classify(files_touched: List[str]) -> SecurityRouteResult:
        has_restricted = False
        has_app_code = False

        for f in files_touched:
            lower = f.lower()
            if any(s in lower for s in (".env", "id_rsa", "secret", "credential", "infra/", "prod.yaml")):
                has_restricted = True
                break
            if any(lower.endswith(ext) for ext in (".go", ".ts", ".js", ".py", ".rs", ".cpp")):
                has_app_code = True

        if has_restricted:
            return SecurityRouteResult(
                policy=DataSensitivityPolicy.RESTRICTED,
                eligible_tier="first-party frontier only"
            )
        if has_app_code:
            return SecurityRouteResult(
                policy=DataSensitivityPolicy.STANDARD,
                eligible_tier="vetted providers"
            )
        return SecurityRouteResult(
            policy=DataSensitivityPolicy.OPEN,
            eligible_tier="any, cheapest first"
        )


# ============================================================================
# 9. SHARED RETRIEVAL ENGINE FOR BACKGROUND WORKERS
# (Section X & Fig. 7)
# ============================================================================

class SharedRetrievalEngine:
    """Shares a single retrieval pass across concurrent read-only background evaluators."""

    def __init__(self, default_ttl: float = 1.5):
        self._cache: Dict[str, Tuple[float, Any]] = {}
        self._ttl = default_ttl
        self._lock = threading.Lock()

    def get_or_fetch(self, key: str, fetch_fn: Callable[[], Any]) -> Any:
        now = time.time()
        with self._lock:
            if key in self._cache:
                expires_at, val = self._cache[key]
                if now < expires_at:
                    return val

            # Execute fetch and cache
            val = fetch_fn()
            self._cache[key] = (now + self._ttl, val)
            return val
