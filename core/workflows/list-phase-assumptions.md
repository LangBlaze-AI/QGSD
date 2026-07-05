<purpose>
Surface Claude's assumptions about a phase before planning, enabling users to correct misconceptions early.

Key difference from discuss-phase: This is ANALYSIS of what Claude thinks, not INTAKE of what user knows. No file output - purely conversational to prompt discussion.

Assumptions are grounded in formal artifacts (requirements, specs, traceability, test coverage, formal models) before analysis — each assumption is tagged as **grounded** (backed by artifact evidence) or **inferred** (Claude's judgment).
</purpose>

<process>

<step name="validate_phase" priority="first">
Phase number: $ARGUMENTS (required)

**If argument missing:**

```
Error: Phase number required.

Usage: /nf:list-phase-assumptions [phase-number]
Example: /nf:list-phase-assumptions 3
```

Exit workflow.

**If argument provided:**
Validate phase exists in roadmap:

```bash
cat .planning/ROADMAP.md | grep -i "Phase ${PHASE}"
```

**If phase not found:**

```
Error: Phase ${PHASE} not found in roadmap.

Available phases:
[list phases from roadmap]
```

Exit workflow.

**If phase found:**
Parse phase details from roadmap:

- Phase number
- Phase name
- Phase description/goal
- Any scope details mentioned
- **Requirement IDs** from the `Requirements:` line (e.g., `SHARD-01, ADAPT-01, ADR-01`)

Continue to ground_in_artifacts.
</step>

<step name="ground_in_artifacts">
Read formal artifacts to ground the assumption analysis in evidence. All reads use fail-open: if an artifact is missing or unreadable, note "not found" and continue — never block the workflow.

**0. Handle missing requirement IDs:**
If the phase has no `Requirements:` line in the roadmap (or the line is empty), set the requirement ID list to empty. Log "No requirement IDs found for this phase — grounding will use domain keywords only." All Tier 1-3 reads that depend on requirement IDs are skipped, but domain-keyword-based reads (spec directory scan, test coverage, model registry) still execute. The workflow must never block on a missing Requirements line.

**1. Tier 1 — Requirements text and specs (always read):**

- Read `.planning/REQUIREMENTS.md` and extract the **exact requirement text** for each phase requirement ID. Present verbatim — do not paraphrase.
- List `.planning/formal/spec/` directory contents. Flag any spec directories that overlap with the phase's domain by matching keywords from the phase name, description, or requirement text against directory names.

**2. Tier 2 — Traceability and test coverage (read if available):**

- Read `.planning/formal/traceability-matrix.json`. For each phase requirement ID, check whether it has traces (code refs, test refs). Note which requirements have traces and which have **gaps** (no traces).
- Read `.planning/formal/unit-test-coverage.json`. Extract test coverage data for files or modules that fall within the phase's domain (match by keyword from phase name/description/requirements).

**3. Tier 3 — Formal requirements envelope and models (reference by ID):**

- Parse `.planning/formal/requirements.json` using **JSON-aware lookup** (e.g., `node -e` with `JSON.parse` or `jq`). Do NOT use literal grep on JSON — it produces partial/malformed matches. For each phase requirement ID, extract: category, status, any linked invariants or background text.
- Read `.planning/formal/model-registry.json`. Check if any Alloy, TLA+, or PRISM models reference the phase's requirement IDs or domain keywords.

**4. Collect grounding data:**
Assemble all results into a grounding summary to flow into analyze_phase:
- Requirement texts (verbatim)
- Matching spec directories
- Traceability status per requirement (traced / gap)
- Test coverage for domain modules
- Formal models touching this domain
- Any artifacts that were "not found"

**5. Scope-drift scan (deterministic — assumption-delta):**
Pipe the phase description and any scope prose into the deterministic drift scanner. It catches abstraction drift — a phase that now describes something **plural / optional / chosen** that a formal model likely treats as **singular / required / derived** — and pairs each signal with a suggested formal invariant. Fail-open: a missing binary or non-zero exit with no JSON means "no signals" — never block.

```bash
REQ="${HOME}/.claude/nf-bin/detect-assumption-delta.cjs"; [ -f "$REQ" ] || REQ="./bin/detect-assumption-delta.cjs"
printf '%s\n' "<phase description + scope prose>" | node "$REQ" --json 2>/dev/null || true
```

Parse the JSON `signals[]` — each is `{ kind, term, snippet, suggestion: { layer, invariant_sketch } }`. If `detected` is true, carry the signals into present_assumptions for the Scope-Drift subsection; otherwise omit that subsection entirely.

Continue to analyze_phase.
</step>

<step name="analyze_phase">
Using **both** the grounding data from ground_in_artifacts **and** the roadmap description/project context, identify assumptions across five areas.

Each assumption must be tagged:
- **Grounded** — backed by artifact evidence. Cite the artifact (e.g., "grounded: REQUIREMENTS.md states X", "grounded: traceability-matrix shows no traces for Y").
- **Inferred** — Claude's judgment without direct artifact support. Explain reasoning (e.g., "inferred: based on similar patterns in hooks/config-loader.js").

**1. Technical Approach:**
What libraries, frameworks, patterns, or tools would Claude use?
- "I'd use X library because..." [grounded/inferred]
- "I'd follow Y pattern because..." [grounded/inferred]
- "I'd structure this as Z because..." [grounded/inferred]

**2. Implementation Order:**
What would Claude build first, second, third?
- "I'd start with X because it's foundational" [grounded/inferred]
- "Then Y because it depends on X" [grounded/inferred]
- "Finally Z because..." [grounded/inferred]

**3. Scope Boundaries:**
What's included vs excluded in Claude's interpretation?
- "This phase includes: A, B, C" [grounded/inferred]
- "This phase does NOT include: D, E, F" [grounded/inferred]
- "Boundary ambiguities: G could go either way" [grounded/inferred]

**4. Risk Areas:**
Where does Claude expect complexity or challenges?
- "The tricky part is X because..." [grounded/inferred]
- "Potential issues: Y, Z" [grounded/inferred]
- "I'd watch out for..." [grounded/inferred]

**5. Dependencies:**
What does Claude assume exists or needs to be in place?
- "This assumes X from previous phases" [grounded/inferred]
- "External dependencies: Y, Z" [grounded/inferred]
- "This will be consumed by..." [grounded/inferred]

Be honest about uncertainty. Mark assumptions with confidence levels:
- "Fairly confident: ..." (clear from roadmap or artifacts)
- "Assuming: ..." (reasonable inference)
- "Unclear: ..." (could go multiple ways)
</step>

<step name="present_assumptions">
Present assumptions in a clear, scannable format:

```
## My Assumptions for Phase ${PHASE}: ${PHASE_NAME}

### Formal Grounding

**Requirements:**
[For each phase requirement ID, show verbatim text from REQUIREMENTS.md]
[If no requirement IDs found: "No requirement IDs specified for this phase — analysis below is inference-only."]

**Existing Specs:**
[List spec/ directories that overlap with this phase's domain, or "None found"]

**Traceability:**
[For each requirement: traced (with refs) or gap (no traces)]
[If no requirement IDs: "N/A — no requirement IDs to trace"]

**Test Coverage:**
[Coverage data for relevant modules, or "No matching modules found"]

**Formal Models:**
[Any Alloy/TLA+/PRISM models touching this domain, or "None found"]

**Artifacts Not Found:**
[List any artifacts that were missing/unreadable, or "All artifacts read successfully"]

---

### Technical Approach
[List assumptions about how to implement — each tagged grounded/inferred]

### Implementation Order
[List assumptions about sequencing — each tagged grounded/inferred]

### Scope Boundaries
**In scope:** [what's included]
**Out of scope:** [what's excluded]
**Ambiguous:** [what could go either way]

<!-- Only render this subsection if the step-5 scan returned detected:true. Omit it entirely otherwise. -->
### Scope-Drift Signals → Formal Invariants
The deterministic scan flagged abstraction drift in this phase's scope. Each signal is a candidate identity-model change that a formal model may not yet reflect:

[For each signal: **[kind]** "term" — _snippet_ → **formal({layer}):** {invariant_sketch}]

**Route to formal:** if any of these represent a real abstraction change, run `/nf:close-formal-gaps ${PHASE}` to land the suggested invariant(s) as TLA+/Alloy, or note explicitly that the drift is intentional and no invariant is needed.

### Risk Areas
[List anticipated challenges — each tagged grounded/inferred]

### Dependencies
**From prior phases:** [what's needed]
**External:** [third-party needs]
**Feeds into:** [what future phases need from this]

---

**What do you think?**

Are these assumptions accurate? Let me know:
- What I got right
- What I got wrong
- What I'm missing
```

Wait for user response.
</step>

<step name="gather_feedback">
**If user provides corrections:**

Acknowledge the corrections:

```
Key corrections:
- [correction 1]
- [correction 2]

This changes my understanding significantly. [Summarize new understanding]
```

**If user confirms assumptions:**

```
Assumptions validated.
```

Continue to offer_next.
</step>

<step name="offer_next">
Present next steps:

```
What's next?
1. Discuss context (/nf:discuss-phase ${PHASE}) - Let me ask you questions to build comprehensive context
2. Plan this phase (/nf:plan-phase ${PHASE}) - Create detailed execution plans
3. Re-examine assumptions - I'll analyze again with your corrections
4. Done for now
```

Wait for user selection.

If "Discuss context": Note that CONTEXT.md will incorporate any corrections discussed here
If "Plan this phase": Proceed knowing assumptions are understood
If "Re-examine": Return to analyze_phase with updated understanding
</step>

</process>

<success_criteria>
- Phase number validated against roadmap
- Requirement IDs extracted from roadmap (or gracefully noted as empty)
- All phase requirement IDs resolved to their full text from REQUIREMENTS.md
- Existing specs in the domain identified from .planning/formal/spec/
- Traceability gaps surfaced from traceability-matrix.json
- Test coverage for domain modules extracted from unit-test-coverage.json
- Formal models checked via model-registry.json
- Tier 3 requirements.json parsed with JSON-aware lookup (not literal grep)
- Phases with no Requirements: line degrade gracefully (inference-only analysis proceeds)
- Formal Grounding section presented before the 5 assumption areas
- Assumptions surfaced across five areas: technical approach, implementation order, scope, risks, dependencies
- Each assumption tagged as grounded (with artifact citation) or inferred (with reasoning)
- Confidence levels marked where appropriate
- "What do you think?" prompt presented
- User feedback acknowledged
- Clear next steps offered
</success_criteria>
