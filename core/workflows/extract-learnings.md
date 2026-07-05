# Workflow: extract-learnings

Mine a completed phase's artifacts into a structured LEARNINGS.md, and feed the durable decisions into nForma's memory. Ported from open-gsd/gsd-core, fused with the formal + quorum + memory layers.

<step name="resolve_phase">
Resolve the target phase.

```bash
PHASE="${ARGUMENTS}"
PINFO=$(node ~/.claude/nf/bin/nf-tools.cjs find-phase "${PHASE:-}" 2>/dev/null || true)
```

- If `$ARGUMENTS` is empty, pick the most recently completed phase (highest-numbered phase whose `disk_status` is `complete` from `roadmap analyze`).
- Establish `${PHASE_DIR}` and `${PADDED_PHASE}`. If the phase has no directory, report "phase not found / not yet run" and stop.

Continue to read_artifacts.
</step>

<step name="read_artifacts">
Read the phase's artifacts — **fail-open** on any that are missing (note "not found", never block):
- `${PHASE_DIR}/*-PLAN.md` — what we intended, the task breakdown, must-haves.
- `${PHASE_DIR}/*-SUMMARY.md` — what was actually built, deviations.
- `${PHASE_DIR}/*-VERIFICATION.md` — what verification found (gaps, fixes).
- `${PHASE_DIR}/*-UAT.md` — user-acceptance results.
- `.planning/STATE.md` — session history, blockers hit.

**Fusion sources:**
- `.planning/formal/` — invariants/models added or changed for this phase; `check-results.ndjson` for what formal-verify caught (`bin/extract-fv-fails.cjs`).
- Quorum record — notable consensus or BLOCK decisions during the phase (`node bin/memory-store.cjs query-quorum` and any quorum scoreboard).

Continue to synthesize.
</step>

<step name="synthesize">
Write `${PHASE_DIR}/${PADDED_PHASE}-LEARNINGS.md` with these sections — each item cited to its source artifact, no invention:

```markdown
# Phase ${PHASE} — Learnings

## Decisions
- {decision} — **why:** {rationale} (source: {artifact})

## Lessons
- {what we'd do differently next time}

## Patterns
- {what recurred — reusable approach or repeated pitfall}

## Surprises
- {what we didn't expect — assumption that proved wrong}

## Formal
- {invariant/model added or changed; what formal-verify caught or proved}

## Quorum
- {notable consensus / BLOCK and its resolution}
```

Be honest about uncertainty — a learning with no artifact backing is an opinion; mark it as such or omit it.

Continue to persist_memory.
</step>

<step name="persist_memory">
Feed the durable, reusable learnings into nForma's decision memory so they surface in future sessions (not just sit in a file):

```bash
node ~/.claude/nf/bin/nf-tools.cjs current-timestamp >/dev/null 2>&1 || true
```

For each **Decision** worth remembering, append it via `bin/memory-store.cjs append-decision` (and `append-quorum` for a notable quorum outcome). Skip ephemeral/phase-specific items — memory is for what changes how we work next time. Report the LEARNINGS.md path and how many decisions were persisted. Never overwrite an existing LEARNINGS.md without noting it.
</step>
