# Workflow: forensics

Post-mortem for a stuck/failed nForma workflow. Read-only evidence gathering → anomaly detection → ranked diagnostic report. Ported from open-gsd/gsd-core, fused with nForma-specific failure-mode probes.

<step name="gather_evidence">
Collect the evidence — all read-only. Never commit, reset, or mutate anything.

```bash
git log --oneline -20 2>/dev/null
git log -20 --format='%ci %s' 2>/dev/null   # timestamps → detect long gaps / interrupted runs
git status --short 2>/dev/null
git diff --stat 2>/dev/null
```

Read `.planning/STATE.md` (current position, session history), the active phase's PLAN/SUMMARY/VERIFICATION, and note anything half-written.

Continue to detect_anomalies.
</step>

<step name="detect_anomalies">
**Generic anomalies (≥4 classes):**
- Interrupted commit — staged/uncommitted work with no matching commit; a phase marked in-progress with no recent commits.
- State ↔ roadmap disagreement — STATE.md says phase N, roadmap/disk says otherwise.
- Orphaned artifacts — a PLAN with no SUMMARY, a SUMMARY with no verification, a VALIDATION.md with open gaps on a "complete" phase.
- Time gap — a long stall between the last two commits (possible crash/abandon).
- Uncommitted work on a "complete" phase.

**nForma-specific probes (the fusion):**
- **Quorum degraded/stuck** — check the last quorum run for an all-UNAVAIL roster or below-`min_live_voters` consensus; a planning command that never produced a decision. (`node bin/memory-store.cjs query-quorum` and any quorum scoreboard/cache under `.planning/.quorum-cache/`.)
- **Formal failure / staleness** — `node bin/check-model-staleness.cjs` for models drifted from source; `bin/extract-fv-fails.cjs` for outstanding formal-verify FAILs in `check-results.ndjson`.
- **Autocommit pollution** — formal artifacts (`.planning/formal/`) committed onto a feature branch by the spec-regen/stop hooks (a known nForma failure mode); flag if the current branch has such commits.
- **Circuit-breaker trip** — `.claude/circuit-breaker-state.json` present/tripped (a false-positive breaker can silently stall a TDD loop).

Continue to report.
</step>

<step name="report">
Write a **redacted** report (strip secrets/tokens/absolute home paths) to `.planning/forensics/{timestamp}-forensics.md` and present inline:

```markdown
# Forensics — {symptom or "auto-detected"}

## Most likely root cause
{one-line diagnosis}

## Findings (severity-ranked)
| Severity | Finding | Evidence |
|----------|---------|----------|
| HIGH | {…} | {git ref / file:line / state} |

## Recovery options
1. {concrete action}  2. {…}  3. {…}
```

Rank by severity, lead with the single most likely root cause, and give concrete recovery actions (e.g. "reset the circuit breaker: `rm .claude/circuit-breaker-state.json`", "clean+push the polluted formal artifacts atomically", "re-run quorum with `--force-quorum` after providers recover"). Read-only — recommend actions, never take destructive ones. Optionally offer to open an issue.
</step>
