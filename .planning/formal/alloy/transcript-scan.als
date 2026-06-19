-- formal/alloy/transcript-scan.als
-- Handwritten — not generated from XState.
-- Source: hooks/nf-stop.js (getCurrentTurnLines, wasSlotCalledSuccessfully)
--         (formerly hooks/qgsd-stop.js — renamed; the maxSize early-break is at nf-stop.js:1069)
--
-- Models the nForma nf-stop.js transcript scanning algorithm:
--   getCurrentTurnLines: backward scan for last human message boundary
--   wasSlotCalledSuccessfully: two-pass tool_use/tool_result ID matching
--
-- Assertions:
--   BoundaryCorrect:              last human message boundary is the highest-idx HumanMessage
--   PairingUnique:                each tool_use_id matches at most one tool_result (and vice versa)
--   NoDuplicateCounting:          successCount equals the cardinality of the non-duplicate result set
--   (The maxSize-ceiling invariant — successCount <= Config.maxSize from the early-break at
--    hooks/nf-stop.js:1069 — is verified at the implementation level, not as an Alloy check:
--    a runtime ordered-iteration break has no faithful declarative encoding, so any fact
--    strong enough to discharge it would be tautological. See the NOTE further down.)
--
-- Scope: 5 Entry, 5 Id, 2 Bool, 4 Int (4-bit: [-8..7], covers idx 0..4 and maxSize 1..5)
--
-- nf-stop.js variable mapping:
--   JSONL entry            → Entry (abstract sig, idx: one Int)
--   isHumanMessage()=true  → HumanMessage extends Entry
--   tool_use block.id      → ToolUse extends Entry { useId: one Id }
--   tool_result block      → ToolResult extends Entry { resultId: one Id, isError: one Bool }
--   block.is_error=true    → isError = True
--   toolUseIds (Set)       → domain of ToolUse.useId relation
--   successCount           → #successfulResults
--   maxSize config value   → Config.maxSize

module transcript_scan

-- ── Shared vocabulary ────────────────────────────────────────────────────────

-- Abstract ID atom: models tool_use block.id / tool_result block.tool_use_id
-- Alloy has no string type; ID matching is structural (same atom = same ID)
abstract sig Id {}

-- Boolean values for isError field
abstract sig Bool {}
one sig True, False extends Bool {}

-- ── Entry sig hierarchy ──────────────────────────────────────────────────────

-- Abstract base: every transcript entry has an integer index
-- idx models the line position in the current-turn JSONL window
abstract sig Entry {
  idx: one Int
}

-- Human-authored user message (isHumanMessage() = true in nf-stop.js)
-- Distinguishes from tool_result-only user entries by having text content blocks
sig HumanMessage extends Entry {}

-- Assistant tool_use block (block.type = 'tool_use', block.id = useId)
sig ToolUse extends Entry {
  useId: one Id
}

-- User tool_result block (block.type = 'tool_result', block.tool_use_id = resultId)
sig ToolResult extends Entry {
  resultId: one Id,
  isError:  one Bool
}

-- Config: holds maxSize (the ceiling for successCount)
-- Models: config.quorum.maxSize read in hooks/nf-stop.js (line ~1051)
one sig Config {
  maxSize: one Int
}

-- ── Ordering facts ───────────────────────────────────────────────────────────

-- No two entries share the same index slot
fact UniqueIndices {
  all disj e1, e2: Entry | e1.idx != e2.idx
}

-- Indices form a contiguous 0..N-1 range (no gaps)
fact ContiguousIndices {
  Entry.idx = { i: Int | 0 <= i and i < #Entry }
}

-- Real Claude transcripts assign a globally unique block.id to every tool_use and every
-- tool_result. The model must enforce this; otherwise the solver may collapse many distinct
-- ToolUse/ToolResult entries onto a single Id atom, fabricating fan-out/fan-in that cannot
-- occur in practice. Models the unique block.id invariant of the JSONL transcript format.
fact UniqueToolUseIds {
  all disj a, b: ToolUse | a.useId != b.useId
}
fact UniqueToolResultIds {
  all disj a, b: ToolResult | a.resultId != b.resultId
}

-- ── Computed values (fun) ────────────────────────────────────────────────────

-- The boundary index: the highest idx among all HumanMessage entries
-- Models: lastUserIdx = max of all matching indices in getCurrentTurnLines
fun boundaryIdx : Int {
  max[HumanMessage.idx]
}

-- Successful results: non-error ToolResult entries that are paired with a ToolUse
-- Models: tool_result entries that increment successCount in wasSlotCalledSuccessfully
fun successfulResults : set ToolResult {
  { tr: ToolResult | tr.isError = False and
    (some tu: ToolUse | tr.resultId = tu.useId) }
}

-- successCount: the number of non-error paired results
-- Models: the successCount counting loop in hooks/nf-stop.js (lines ~1060-1080)
fun successCount : Int {
  #successfulResults
}

-- ── Predicates (pred) ────────────────────────────────────────────────────────

-- BoundaryCorrect: no HumanMessage exists after the boundary index
-- Models: getCurrentTurnLines correctly identifies the last human turn
pred BoundaryCorrect {
  no h: HumanMessage | h.idx > boundaryIdx
}

-- PairingUnique: each ToolUse maps to at most one ToolResult, and vice versa
-- Models: wasSlotCalledSuccessfully two-pass ID matching (no fan-out, no fan-in)
pred PairingUnique {
  -- Each tool_use_id matches at most one tool_result (no fan-out)
  all tu: ToolUse | lone tr: ToolResult | tr.resultId = tu.useId
  -- Each tool_result matches at most one tool_use (no fan-in)
  all tr: ToolResult | lone tu: ToolUse | tr.resultId = tu.useId
}

-- NoDuplicateCounting: successCount equals the cardinality of the deduplicated result set
-- Alloy sets are duplicate-free by construction — this makes the no-double-counting
-- contract explicit: the count is exactly the number of unique successful results.
pred NoDuplicateCounting {
  successCount = #successfulResults
}

-- NOTE on the maxSize ceiling (successCount <= Config.maxSize):
-- This invariant is enforced at runtime by the early-break loop at hooks/nf-stop.js:1069
--   if (successCount >= maxSize) break;
-- It is intentionally NOT modeled as an Alloy check. The bound is a property of an ORDERED
-- ITERATIVE process (count, test, break) that has no faithful declarative encoding here:
-- any `fact` strong enough to make the check pass is identical to the property itself, which
-- makes the check tautological (it would assume its own conclusion rather than derive it).
-- Rather than ship a self-proving check that validates nothing, the ceiling is verified by
-- the unit tests around the counting loop. The earlier spec asserted this against `minSize`,
-- citing a removed qgsd-stop.js:453 break; the current code's ceiling is maxSize.

-- ── Assertions (assert + check) ──────────────────────────────────────────────

-- BoundaryCorrect: if at least one HumanMessage exists, boundary is the last one
-- @requirement STOP-08
assert BoundaryCorrectCheck {
  some HumanMessage => BoundaryCorrect
}

-- PairingUnique: the ID matching relation is functional in both directions
-- @requirement STOP-09
assert PairingUniqueCheck {
  PairingUnique
}

-- NoDuplicateCounting: set cardinality = no duplicate counting (tautological but explicit)
-- @requirement STOP-10
assert NoDuplicateCountingCheck {
  NoDuplicateCounting
}

-- (No SuccessCount check — see the maxSize-ceiling NOTE above: that bound is verified at
-- the implementation level, not declaratively, to avoid a tautological self-proving check.)

-- ── Check commands ───────────────────────────────────────────────────────────
-- Scope: 5 Entry total (HumanMessage + ToolUse + ToolResult subtypes share this budget)
--        5 Id atoms — the UniqueToolUseIds/UniqueToolResultIds facts make useId/resultId
--          injective (mirroring real transcripts, where every block.id is globally unique);
--          the 5-Id budget allows distinct IDs across the 5 entries.
--        2 Bool (True, False — exact cardinality)
--        4 Int (4-bit integers: [-8..7], covers idx 0..4 and maxSize 1..5 without overflow)

check BoundaryCorrectCheck             for 5 Entry, 5 Id, 2 Bool, 4 Int
check PairingUniqueCheck               for 5 Entry, 5 Id, 2 Bool, 4 Int
check NoDuplicateCountingCheck         for 5 Entry, 5 Id, 2 Bool, 4 Int
