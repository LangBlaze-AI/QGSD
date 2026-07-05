# Workflow: verify-docs

Orchestrate parallel `nf-doc-verifier` agents to fact-check documentation against the live codebase and formal artifacts. Adversarial by design — the goal is to surface drifted docs, not to confirm them.

<step name="discover_docs">
Build the doc list to verify.

- If `$ARGUMENTS` is a path or glob, expand it (Glob) and use those files.
- Otherwise discover the default set (each is optional — skip if absent):
  ```bash
  { ls README.md CONTRIBUTING.md CHANGELOG.md 2>/dev/null; \
    find docs -name '*.md' 2>/dev/null; \
    find .planning -maxdepth 2 -name '*.md' 2>/dev/null | grep -viE '/tmp/|/formal/'; } | sort -u
  ```
- Cap at 20 docs (log the count if more are found and truncated — do NOT silently drop). If zero docs found, report "no documentation to verify" and stop.

Continue to spawn_verifiers.
</step>

<step name="spawn_verifiers">
Spawn one `nf-doc-verifier` agent per doc, up to 6 concurrent (batch if more).

Use the Task tool with `subagent_type="nf-doc-verifier"` and `run_in_background=true` for parallel execution. Each Task prompt contains a `<verify_assignment>` block:

```
<verify_assignment>
  doc_path: <relative path>
  project_root: <absolute project root>
</verify_assignment>
```

Each agent writes `.planning/tmp/verify-<doc_filename>.json` and returns a one-line confirmation. The orchestrator collects only the confirmations (keeps context small).

Continue to aggregate.
</step>

<step name="aggregate">
Read each `.planning/tmp/verify-<doc>.json`. Build a summary table:

```
## Doc Verification — <N> docs

| Doc | Claims | Passed | BLOCKERs | WARNINGs |
|-----|--------|--------|----------|----------|
| README.md | 12 | 10 | 2 | 0 |
| ...

### BLOCKERs (demonstrably false claims)
- README.md:34 — `src/cli/index.ts` → file not found
- ...
```

A `failure` with a concrete `expected`/`actual` mismatch is a BLOCKER; an UNVERIFIABLE claim (behavior/runtime, or a formal invariant that is *defined* but not *proven* by grep) is a WARNING.

Continue to escalate.
</step>

<step name="escalate">
If any BLOCKERs were found, offer the nForma fusion:

> Found **N BLOCKER(s)** across M doc(s). Options:
> 1. **Escalate to `/nf:quorum`** — have the multi-LLM quorum adversarially confirm each BLOCKER is a real drift (not a verifier false positive) before you act.
> 2. **Fix the docs** — I'll correct the false claims to match the code.
> 3. **Review manually** — show me the full findings.

If zero BLOCKERs, report the clean summary and stop. Never auto-edit docs without confirmation.
</step>
