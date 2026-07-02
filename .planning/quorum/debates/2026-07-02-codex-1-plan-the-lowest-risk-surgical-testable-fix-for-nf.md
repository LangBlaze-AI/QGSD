---
date: 2026-07-02
question: "Plan the lowest-risk, surgical, testable fix for nf-solve reverse-flow DETECTION blindness. Benchmark injects an orphan file (new src/*.js or bin/*.cjs with NO linked requirement) and expects the c_to_r / t_to_r / d_to_r layer residual to INCREASE, but nf-solve residual does not move so the injected gap is undetected (~20 failing detection_only challenges). sweepCtoR scans bin/ and hooks/ live for source files but classifies coverage via a cached code-trace-index.json (loadCodeTraceIndex, module-level codeTraceIndexCache; a rebuildCodeTraceIndex exists). A new orphan file is not in requirements text nor in a fresh index. Benchmark runs nf-solve with --fast. QUESTION: best lowest-risk approach to make detection reliable (residual rises when an uncovered src/bin/test/doc file is added) WITHOUT false positives on legitimately-traced files or regressing existing c_to_r/t_to_r/d_to_r scores. Should we rebuild/invalidate the index at sweep time, change coverage classification, or something else? Give a concrete surgical plan and a test."
slot: codex-1
round: 1
mode: "A"
verdict: Best surgical fix: make reverse sweeps refresh their positive trace evidence even in `--fast`, then expand C→R’s live candidate scan to include `src/` alongside `bin/` and `hooks/`. The current benchmark always runs `--fast`, and `computeResidual()` skips `rebuildCodeTraceIndex()` in fast mode, so `sweepCtoR()` can read stale `code-trace-index.json` even though `rebuildCodeTraceIndex()` already clears `codeTraceIndexCache`; rebuilding here is low risk because the builder only derives `traced_fil
matched_requirement_ids: [DIAG-02, DECOMP-01, SYNC-04, TRACE-01, DETECT-02, TRACE-02, DETECT-03, DIAG-01, DRIFT-01, REDACT-01, ANNOT-04, BTF-03, DISP-04, DRIFT-02, PLAN-01, REDACT-02, SIG-01, UNIF-03, ACT-01, ACT-03]
artifact_path: ""
---

# Debate Trace: codex-1 on round 1

## Reasoning
Best surgical fix: make reverse sweeps refresh their positive trace evidence even in `--fast`, then expand C→R’s live candidate scan to include `src/` alongside `bin/` and `hooks/`. The current benchmark always runs `--fast`, and `computeResidual()` skips `rebuildCodeTraceIndex()` in fast mode, so `sweepCtoR()` can read stale `code-trace-index.json` even though `rebuildCodeTraceIndex()` already cl

## Citations
(none)
