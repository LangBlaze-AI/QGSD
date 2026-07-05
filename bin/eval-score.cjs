#!/usr/bin/env node
'use strict';

/**
 * bin/eval-score.cjs — deterministic AI-feature evaluation score + verdict.
 *
 * Ported from open-gsd/gsd-core's `eval.score` query (their agents call it so scores are
 * computed deterministically, never by hand). Given a dimension-coverage count and the
 * status of 5 eval-infra components, returns coverage/infra/overall scores and a verdict.
 *
 * nForma fusion: a verdict within BORDERLINE_MARGIN of a threshold is flagged
 * `quorum_recommended` — a multi-LLM fork should quorum-confirm whether an AI feature is
 * truly production-ready rather than trust one judge on a borderline call.
 *
 * Weights: overall = 70% coverage + 30% infra. Infra: ok=1, partial=0.5, missing=0.
 * Verdicts: ≥85 PRODUCTION READY · ≥60 NEEDS WORK · ≥30 SIGNIFICANT GAPS · else NOT IMPLEMENTED.
 *
 * Exports: scoreEval, INFRA_KEYS
 * CLI: node bin/eval-score.cjs --covered N --total D --infra ok,partial,missing,ok,partial [--json]
 */

const INFRA_KEYS = ['tooling', 'dataset', 'cicd', 'guardrails', 'tracing'];
const INFRA_VALUE = { ok: 1, partial: 0.5, missing: 0 };
const THRESHOLDS = [
  { min: 85, verdict: 'PRODUCTION READY' },
  { min: 60, verdict: 'NEEDS WORK' },
  { min: 30, verdict: 'SIGNIFICANT GAPS' },
  { min: 0, verdict: 'NOT IMPLEMENTED' },
];
const BORDERLINE_MARGIN = 5; // points within a threshold boundary → quorum-confirm

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/**
 * @param {number} covered  dimensions COVERED (PARTIAL counted as 0.5 by the caller's count)
 * @param {number} total    total rubric dimensions
 * @param {string[]} infra   5 statuses (ok|partial|missing), order = INFRA_KEYS
 * @returns {{coverage_score,infra_score,overall_score,verdict,quorum_recommended}}
 */
function scoreEval(covered, total, infra) {
  const cov = total > 0 ? clamp01(covered / total) : 0;
  const infraList = Array.isArray(infra) ? infra : [];
  const infraVals = INFRA_KEYS.map((_, i) => {
    const v = String(infraList[i] || 'missing').toLowerCase();
    return INFRA_VALUE[v] !== undefined ? INFRA_VALUE[v] : 0;
  });
  const infraScore = infraVals.reduce((a, b) => a + b, 0) / INFRA_KEYS.length;
  const overall = Math.round((0.7 * cov + 0.3 * infraScore) * 100);
  const verdict = (THRESHOLDS.find((t) => overall >= t.min) || THRESHOLDS[THRESHOLDS.length - 1]).verdict;
  // borderline: within margin of ANY internal boundary (85/60/30)
  const boundaries = [85, 60, 30];
  const quorumRecommended = boundaries.some((b) => Math.abs(overall - b) <= BORDERLINE_MARGIN);
  return {
    coverage_score: Math.round(cov * 100),
    infra_score: Math.round(infraScore * 100),
    overall_score: overall,
    verdict,
    quorum_recommended: quorumRecommended,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };
  const covered = parseFloat(get('--covered'));
  const total = parseFloat(get('--total'));
  const infra = (get('--infra') || '').split(',').map((s) => s.trim());
  if (!Number.isFinite(covered) || !Number.isFinite(total)) {
    process.stderr.write('usage: eval-score --covered N --total D --infra tooling,dataset,cicd,guardrails,tracing [--json]\n');
    process.exit(1);
  }
  const r = scoreEval(covered, total, infra);
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(r) + '\n');
  } else {
    process.stdout.write('Overall: ' + r.overall_score + '/100 (coverage ' + r.coverage_score + ', infra ' + r.infra_score + ')\n');
    process.stdout.write('Verdict: ' + r.verdict + (r.quorum_recommended ? '  — BORDERLINE: quorum-confirm recommended (/nf:quorum)' : '') + '\n');
  }
  process.exit(0);
}

module.exports = { scoreEval, INFRA_KEYS };
