#!/usr/bin/env node
'use strict';

/**
 * bin/gap-analysis.cjs — post-planning requirement-coverage report (plan:post).
 *
 * Ported from open-gsd/gsd-core's gap-analysis gate and fused with nForma's formal layer:
 * after a phase's PLAN.md files are generated, cross-reference every requirement ID the
 * phase owns against the plan bodies and emit a coverage table. A requirement that is
 * MISSING from every plan is a coverage gap; a MISSING requirement that also has a formal
 * model (`formal_models` non-empty in requirements.json) is a HIGH-priority gap — the
 * spec is formally pinned but nothing plans to satisfy it.
 *
 * Non-blocking / advisory — exit 0 always (fail-open: missing inputs → empty report).
 *
 * Exports: gapAnalysis, extractPlanRefs, REQ_ID_RE
 * CLI: node bin/gap-analysis.cjs --phase <N> [--plans-dir <dir>] [--req-json <path>] [--json]
 */

const fs = require('fs');
const path = require('path');

const REQ_ID_RE = /\b[A-Z][A-Z0-9]{1,10}-[0-9]+\b/g;

/** Extract every requirement-ID referenced by the PLAN.md files under a dir. */
function extractPlanRefs(plansDir) {
  const refs = new Set();
  let planCount = 0;
  let files = [];
  try { files = fs.readdirSync(plansDir); } catch (_) { return { refs, planCount }; }
  for (const f of files) {
    if (!/PLAN.*\.md$/i.test(f) && f.toLowerCase() !== 'plan.md') {
      // also descend one level (phase dir → plan subdirs)
      const sub = path.join(plansDir, f);
      try { if (fs.statSync(sub).isDirectory()) { for (const g of fs.readdirSync(sub)) if (/PLAN.*\.md$/i.test(g)) tryFile(path.join(sub, g)); } } catch (_) {}
      continue;
    }
    tryFile(path.join(plansDir, f));
  }
  function tryFile(p) {
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { return; }
    planCount++;
    for (const m of txt.matchAll(REQ_ID_RE)) refs.add(m[0]);
  }
  return { refs, planCount };
}

/**
 * Compute coverage rows.
 * @param {Array<{id,formal_models?}>} requirements  the phase's requirements
 * @param {Set<string>} planRefs  requirement IDs referenced by any plan
 * @returns {{ rows, covered, missing, missing_formal }}
 */
function gapAnalysis(requirements, planRefs) {
  const rows = [];
  for (const r of requirements) {
    const covered = planRefs.has(r.id);
    const hasFormal = Array.isArray(r.formal_models) && r.formal_models.length > 0;
    rows.push({
      id: r.id,
      status: covered ? 'COVERED' : 'MISSING',
      formal: hasFormal,
      priority: (!covered && hasFormal) ? 'HIGH' : (!covered ? 'normal' : '—'),
    });
  }
  const missing = rows.filter((x) => x.status === 'MISSING');
  return {
    rows,
    covered: rows.length - missing.length,
    total: rows.length,
    missing: missing.map((x) => x.id),
    missing_formal: missing.filter((x) => x.formal).map((x) => x.id),
  };
}

function loadPhaseRequirements(reqJsonPath, phase) {
  let data;
  try { data = JSON.parse(fs.readFileSync(reqJsonPath, 'utf8')); } catch (_) { return []; }
  const all = Array.isArray(data.requirements) ? data.requirements : [];
  if (phase == null) return all;
  const want = String(phase);
  // `phase` in requirements.json may be "3", "v0.20-03", etc. — match by suffix/equality.
  return all.filter((r) => r.phase != null && (String(r.phase) === want || String(r.phase).endsWith('-' + want.padStart(2, '0')) || String(r.phase).endsWith(want)));
}

// ─── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };
  const phase = get('--phase');
  const reqJson = get('--req-json') || path.join('.planning', 'formal', 'requirements.json');
  const plansDir = get('--plans-dir') || (phase ? path.join('.planning', 'phases') : '.planning');
  const wantJson = argv.includes('--json');

  const requirements = loadPhaseRequirements(reqJson, phase);
  const { refs, planCount } = extractPlanRefs(plansDir);
  const result = gapAnalysis(requirements, refs);

  if (wantJson) {
    process.stdout.write(JSON.stringify({ ...result, plan_count: planCount, phase: phase || null }, null, 2) + '\n');
    process.exit(0);
  }
  if (requirements.length === 0) {
    process.stdout.write('Gap analysis: no requirements found for phase ' + (phase || '(all)') + ' — nothing to check.\n');
    process.exit(0);
  }
  process.stdout.write('## Requirement Coverage — phase ' + (phase || '(all)') + ' (' + result.covered + '/' + result.total + ' covered, ' + planCount + ' plans)\n\n');
  process.stdout.write('| Requirement | Status | Formal | Priority |\n|---|---|---|---|\n');
  for (const r of result.rows) {
    process.stdout.write('| ' + r.id + ' | ' + r.status + ' | ' + (r.formal ? 'yes' : '—') + ' | ' + r.priority + ' |\n');
  }
  if (result.missing_formal.length) {
    process.stdout.write('\n**⚠ HIGH-priority gaps (formally modeled but unplanned):** ' + result.missing_formal.join(', ') +
      '\n→ these requirements have a formal model but no plan satisfies them — plan them, or reconcile via /nf:close-formal-gaps.\n');
  }
  process.stdout.write('\n_Advisory / non-blocking._\n');
  process.exit(0);
}

module.exports = { gapAnalysis, extractPlanRefs, loadPhaseRequirements, REQ_ID_RE };
