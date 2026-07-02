---
date: 2026-07-02
question: "Plan the lowest-risk, surgical, testable fix for nf-solve reverse-flow DETECTION blindness. Benchmark injects an orphan file (new src/*.js or bin/*.cjs with NO linked requirement) and expects the c_to_r / t_to_r / d_to_r layer residual to INCREASE, but nf-solve residual does not move so the injected gap is undetected (~20 failing detection_only challenges). sweepCtoR scans bin/ and hooks/ live for source files but classifies coverage via a cached code-trace-index.json (loadCodeTraceIndex, module-level codeTraceIndexCache; a rebuildCodeTraceIndex exists). computeResidual skips rebuildCodeTraceIndex in --fast mode. C→R does not scan src/. A new orphan file is not in requirements text nor in a fresh index. QUESTION: best lowest-risk approach to make detection reliable (residual rises when an uncovered src/bin/test/doc file is added) WITHOUT false positives on legitimately-traced files or regressing existing c_to_r/t_to_r/d_to_r scores. Should we rebuild/invalidate the index at sweep time even under --fast, extend the scan to src/, change coverage classification, or something else? Give a concrete surgical plan and a test."
slot: antigravity-1
round: 1
mode: "A"
verdict: (no output)

matched_requirement_ids: [DIAG-02, TRACE-01, DECOMP-01, SYNC-04, DETECT-03, TRACE-02, ANNOT-04, DETECT-02, DIAG-01, DISP-04, ORES-01, BTF-03, DECOMP-03, DECOMP-05, DRIFT-01, REDACT-01, SENS-01, UNIF-03, ACT-01, ORES-02]
artifact_path: ""
---

# Debate Trace: antigravity-1 on round 1

## Reasoning
(no output)


## Citations
(none)
