---
date: 2026-07-02
question: "nForma strategic product direction — pick ONE primary next investment; need full consensus. SITUATION: nf-solve (formal-verification consistency solver that DIAGNOSES gaps across requirements/formal/tests/code/docs layers) scores ~30 percent (70/230) on its benchmark, but that low score is PROVEN dominated by MEASUREMENT/CORPUS DEFECTS not product capability: 54 challenges (23pct) expect NON-EXISTENT layers (unwinnable by construction), many expect a real-but-WRONG layer, ~30 file-modify challenges cannot create the orphan the reverse-layers detect, and 109 benchmark fixtures were AUTOCOMMITTED into nForma bin (pollution making file-create challenges no-ops). Detection provably WORKS when measured correctly (+5 verified challenge fixes in PR 8, zero regression). Headless nf-solve is DIAGNOSTIC-ONLY (does NOT auto-repair code/reverse-flow). Autocommit/idempotency bugs already PARTLY fixed in PR 295. OPTIONS: A FIX THE MEASUREMENT (merge PR8, redesign the 54+ broken challenges to correct expected layers, clean the 109 stray files) — cheap, high-certainty, unblocks a trustworthy north-star metric you cannot steer on while it is 23pct+ broken. B INVEST IN CAPABILITY (build real auto-REPAIR into nf-solve: code-fixer + reverse-flow/r_to_f auto-repair) — higher ceiling and risk; the product moat is autonomous FIXING not just detection. C FIX THE AUTOCOMMIT-POLLUTION ROOT CAUSE (the systemic auto-commit/artifact-regeneration behavior that recurred all session, polluted the repo with 109 files, caused idempotency bugs, contaminated the benchmark) — fix the cause once vs its symptoms repeatedly. Which ONE is the correct PRIMARY direction and WHY? Consider sequencing (does one unblock the others), ROI, and risk. Answer with your chosen option letter and reasoning."
slot: claude-1
round: 1
mode: "A"
verdict: **A — Fix the Measurement.**

Sequencing makes this the only rational first move: you cannot validate capability investments (B) or confirm autocommit fixes (C) are complete without a trustworthy north-star metric. The repo's own history proves this — the quorum unanimously approved a reverse-flow fix (add `src/` to scanDirs + invalidate cache), but empirical benchmarking DISPROVED it; all 4 tested challenges still failed because the real issue was the harness not restoring mutation targets (`pr
matched_requirement_ids: [SENS-01, DIAG-01, DIAG-02, ROOT-01, ENFC-03, ROOT-02, ROOT-03, SENS-03, ANNOT-04, PRED-02, TRACE-02, TRACE-05, ANNOT-05, TRACE-01, BTF-03, CONF-01, CONF-09, CONV-02, DECOMP-01, DIAG-03]
artifact_path: ""
---

# Debate Trace: claude-1 on round 1

## Reasoning
**A — Fix the Measurement.**

Sequencing makes this the only rational first move: you cannot validate capability investments (B) or confirm autocommit fixes (C) are complete without a trustworthy north-star metric. The repo's own history proves this — the quorum unanimously approved a reverse-flow fix (add `src/` to scanDirs + invalidate cache), but empirical benchmarking DISPROVED it; all 4 teste

## Citations
(none)
