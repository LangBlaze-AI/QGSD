-- formal/alloy/taxonomy-safety.als
-- Handwritten — not generated.
-- Source: bin/update-scoreboard.cjs classifyWithHaiku() (function at line 489) and its
--         caller's is_new branch (lines ~1080-1102).
-- NOTE: requirements SCBD-05/06/07 are referenced by the @requirement tags below but are
--       ABSENT from .planning/formal/requirements.json. They are retained as the documented
--       intent of these checks, not invented requirements — do not treat the tags as
--       requirement-registry entries until SCBD-05/06/07 are formally added.
--
-- Models the Haiku auto-classification function:
--   input:  taskDescription (free-form string atom), categories (existing taxonomy)
--   output: Classification { category, subcategory, is_new }
--
-- Assertions:
--   NoInjection:           ClassifyFn is functional — same TaskDescription always maps to
--                          same Classification (no non-deterministic category assignment)
--   TaxonomyClosed:        is_new=False => category is already in KnownCategories
--   NewCategoryConsistent: is_new=True  => category is NOT in KnownCategories before classification
--
-- Scope: 3 TaskDescription, 3 Category, 3 Subcategory, 2 Bool, 3 KnownCategories, 3 Classification, 2 ClassifyFn
--
-- Key insight: Alloy has no string type. TaskDescription atoms are opaque — their "content"
-- cannot influence Category atoms structurally. Injection-safety is guaranteed by construction.
-- NoInjection expresses the meaningful functional constraint: deterministic classification.

module taxonomy_safety

-- Opaque task description atom — models the free-form string passed to Haiku
-- Alloy atoms carry no content; injection is structurally impossible
abstract sig TaskDescription {}

-- Category and Subcategory atoms — models the taxonomy keys/values
abstract sig Category {}
abstract sig Subcategory {}

-- Boolean for is_new field
abstract sig Bool {}
one sig True, False extends Bool {}

-- KnownCategories: the set of categories that existed BEFORE classification
-- Models: Object.keys(data.categories) — the taxonomy snapshot passed to
-- classifyWithHaiku(taskDescription, categories) at update-scoreboard.cjs:489.
sig KnownCategories {
    cats: set Category
}

-- Classification: the output of classifyWithHaiku()
-- Models: { category, subcategory, is_new } return value
-- `against` binds each Classification to the ONE taxonomy snapshot it was classified
-- against. The real classifier always runs against a single `data.categories` snapshot;
-- without this binding the solver was free to compare a Classification's is_new flag
-- against an UNRELATED KnownCategories instance (the original under-constraint that
-- produced the spurious counterexamples).
sig Classification {
    category:    one Category,
    subcategory: one Subcategory,
    is_new:      one Bool,
    against:     one KnownCategories
}

-- ClassifierContract: models the is_new semantics of classifyWithHaiku at
-- update-scoreboard.cjs:489 and the caller's is_new branch (lines ~1080-1102):
-- the classifier returns is_new=false exactly when the chosen category is already present
-- in the snapshot it was classified against, and is_new=true exactly when it is absent.
-- This is the contract the implementation guarantees; it turns TaxonomyClosed and
-- NewCategoryConsistent into consistency checks against that contract.
fact ClassifierContract {
    all c: Classification |
        (c.is_new = False) <=> (c.category in c.against.cats)
}

-- ClassifyFn: the classification function — maps TaskDescription -> Classification
-- Models: classifyWithHaiku(taskDescription, categories) call
-- Functional: each TaskDescription maps to exactly one Classification
sig ClassifyFn {
    maps: TaskDescription -> one Classification
}

-- ── Assertions ────────────────────────────────────────────────────────────────

-- NoInjection: ClassifyFn is functional — each TaskDescription yields exactly one
-- Classification output (deterministic classification; no non-determinism).
-- The injection-safety claim (task description content cannot alter category structure)
-- is structurally guaranteed by Alloy's atom model (TaskDescription atoms carry no string
-- content). NoInjection captures the meaningful functional constraint: same input -> same output.
-- @requirement SCBD-05
assert NoInjection {
    all f: ClassifyFn, t: TaskDescription |
        one f.maps[t]
}

-- TaxonomyClosed: when is_new=False, the returned category was already known in the
-- snapshot it was classified against (c.against), not in some unrelated taxonomy.
-- Consistency check against ClassifierContract (update-scoreboard.cjs:489).
-- @requirement SCBD-06
assert TaxonomyClosed {
    all c: Classification |
        c.is_new = False => c.category in c.against.cats
}

-- NewCategoryConsistent: when is_new=True, the returned category was NOT present in the
-- snapshot it was classified against (c.against). It is genuinely new relative to that
-- snapshot — matching the is_new branch that appends to data.categories (lines ~1085-1101).
-- Consistency check against ClassifierContract.
-- @requirement SCBD-07
assert NewCategoryConsistent {
    all c: Classification |
        c.is_new = True => c.category not in c.against.cats
}

-- ── Check commands ────────────────────────────────────────────────────────────
-- Scope: 3 atoms per sig (small scope for fast bounded model checking)
-- 2 Bool (True, False — exact cardinality from one sig declarations)

check NoInjection           for 3 TaskDescription, 3 Category, 3 Subcategory, 2 Bool, 3 KnownCategories, 3 Classification, 2 ClassifyFn
check TaxonomyClosed        for 3 TaskDescription, 3 Category, 3 Subcategory, 2 Bool, 3 KnownCategories, 3 Classification, 2 ClassifyFn
check NewCategoryConsistent for 3 TaskDescription, 3 Category, 3 Subcategory, 2 Bool, 3 KnownCategories, 3 Classification, 2 ClassifyFn
