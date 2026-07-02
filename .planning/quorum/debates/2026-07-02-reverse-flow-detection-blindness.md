# Quorum Debate
Question: Lowest-risk surgical fix for nf-solve reverse-flow DETECTION blindness (~20 failing detection_only challenges)
Date: 2026-07-02
Consensus: APPROVE
Rounds: 1

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY) | Cached index masks new files; treat on-disk-present/index-absent files as orphans, extend scan, freshness-check index; test with orphan | nf-solve.cjs sweepCtoR |
| codex-1 | Rebuild trace index even under --fast + extend C→R scan to src/; don't loosen classification; test stale-index+orphan → residual rises + negative control | nf-solve.cjs:1077,1103,2500,2544,4670; runner.cjs:87; build-code-trace.cjs:30 |
| claude-1 | Two bugs: src/ not scanned (2501) + stale index in --fast (4670). Fix: add 'src' to scanDirs + invalidate codeTraceIndexCache before reverse sweeps (cheaper than rebuild); classification already safe; test src/orphan → residual>0 | nf-solve.cjs:2501,4670,1083-1097,2545-2555; build-code-trace.cjs:30-44 |
| opencode-1 | UNAVAIL (CLI dispatch timeout) | — |
| copilot-1 | UNAVAIL (CLI dispatch stalled) | — |
| antigravity-1 | UNAVAIL (no output) | — |

## Outcome
CONSENSUS (2 live external voters, unanimous APPROVE). Two root causes in sweepCtoR:
1. scanDirs = ['bin','hooks'] omits 'src/' → orphan src/*.js files invisible (majority of failing challenges target src/).
2. code-trace-index staleness: computeResidual skips rebuildCodeTraceIndex under --fast; module-level codeTraceIndexCache can serve stale data.

Agreed fix (surgical, ~3 lines): add 'src' to scanDirs; invalidate/refresh the code-trace index before reverse sweeps even under --fast (claude-1's cache-invalidate is cheaper than codex-1's full rebuild and sufficient, since an orphan file is never in the on-disk index). Do NOT loosen coverage classification (no false-positive risk — traced files still match via index/reqtext/header). Add a test creating an orphan src/ file and asserting the c_to_r residual strictly increases + untraced_modules contains it, with a negative control (valid @requirement header → not flagged).
