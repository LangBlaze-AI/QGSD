#!/usr/bin/env node
'use strict';

/**
 * bin/smart-entry.cjs — state-aware front-door detector.
 *
 * Ported from open-gsd/gsd-core's smart-entry. Detects the current project SITUATION from
 * the roadmap + STATE + phase artifacts and returns a situation-appropriate menu of the
 * right next nForma actions. Pure launcher data — /nf:next renders the menu and dispatches;
 * this file never does the work.
 *
 * nForma fusion: the action list is nForma-native — a verify-failed phase routes to
 * /nf:harden or /nf:solve, open formal gaps surface /nf:close-formal-gaps, and every
 * in-project situation offers /nf:autonomous (the quorum+formal-gated phase loop).
 *
 * Fail-open: on any read error the situation degrades to a best-effort guess with
 * /nf:progress always present, so the user is never stranded.
 *
 * Exports: detectSituation, ACTIONS_BY_SITUATION
 * CLI: node bin/smart-entry.cjs [--json]  (reads .planning via nf-tools)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALWAYS = [{ id: 'progress', label: 'Show project status', command: '/nf:progress' }];

function act(id, label, command, recommended) { return { id, label, command, recommended: !!recommended }; }

/**
 * @param {object} ctx
 *   phases: [{number, disk_status, plan_count, summary_count, has_context, roadmap_complete}]
 *   stateText: STATE.md content (may be '')
 *   activeArtifacts: {hasVerification, verifyFailed} for the active phase (best-effort)
 *   formalGaps: number of open formal gaps (fusion; default 0)
 *   roadmapExists: boolean
 * @returns {{situation, summary, actions}}
 */
function detectSituation(ctx) {
  const phases = Array.isArray(ctx.phases) ? ctx.phases : [];
  const state = String(ctx.stateText || '');
  const art = ctx.activeArtifacts || {};
  const formalGaps = ctx.formalGaps || 0;

  const formalAction = formalGaps > 0
    ? [act('close-formal-gaps', 'Close ' + formalGaps + ' open formal gap(s)', '/nf:close-formal-gaps', false)]
    : [];
  const wrap = (situation, summary, actions) => ({
    situation, summary,
    actions: [...actions, ...formalAction, ...ALWAYS],
  });

  if (!ctx.roadmapExists && phases.length === 0) {
    return wrap('no-project', 'No roadmap found — start a project.', [
      act('new-project', 'Start a new project', '/nf:new-project', true),
    ]);
  }
  // paused / blocked take precedence — read from STATE
  if (/\bpaused\b/i.test(state)) {
    return wrap('paused', 'Work is paused — resume when ready.', [
      act('progress', 'Review where you left off', '/nf:progress', true),
      act('autonomous', 'Resume the phase loop', '/nf:autonomous', false),
    ]);
  }
  if (/\bblocked\b/i.test(state)) {
    return wrap('blocked', 'A blocker is recorded — diagnose it.', [
      act('forensics', 'Post-mortem the blocker', '/nf:forensics', true),
      act('progress', 'Show the blocker', '/nf:progress', false),
    ]);
  }

  const incomplete = phases.filter((p) => p.disk_status !== 'complete' && !p.roadmap_complete)
    .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

  if (phases.length === 0) {
    return wrap('needs-first-phase', 'Roadmap exists but no phases yet — plan the first.', [
      act('plan', 'Plan the first phase', '/nf:plan-phase 1', true),
      act('new-milestone', 'Define a milestone', '/nf:new-milestone', false),
    ]);
  }
  if (incomplete.length === 0) {
    // everything on disk is complete
    if (/milestone complete/i.test(state)) {
      return wrap('complete', 'Milestone complete — start the next.', [
        act('new-milestone', 'Start the next milestone', '/nf:new-milestone', true),
      ]);
    }
    return wrap('idle-stranded', 'All phases complete but the milestone is not closed.', [
      act('complete-milestone', 'Close the milestone', '/nf:complete-milestone', true),
      act('audit', 'Audit the milestone first', '/nf:audit-milestone', false),
    ]);
  }

  const p = incomplete[0];
  const N = p.number;
  if ((p.plan_count || 0) === 0) {
    return wrap('planning', 'Phase ' + N + ' needs a plan.', [
      act('plan', 'Plan phase ' + N, '/nf:plan-phase ' + N, true),
      act('spec', 'Spec it first (falsifiable what)', '/nf:spec-phase ' + N, false),
      act('autonomous', 'Autonomously run the rest', '/nf:autonomous --from ' + N, false),
    ]);
  }
  if ((p.summary_count || 0) === 0) {
    return wrap('executing', 'Phase ' + N + ' is planned — execute it.', [
      act('execute', 'Execute phase ' + N, '/nf:execute-phase ' + N, true),
      act('autonomous', 'Autonomously run the rest', '/nf:autonomous --from ' + N, false),
    ]);
  }
  if (art.verifyFailed) {
    return wrap('verify-failed', 'Phase ' + N + ' verification found gaps.', [
      act('harden', 'Harden the failing edges', '/nf:harden ' + N, true),
      act('solve', 'Detect + fix residuals', '/nf:solve', false),
      act('validate', 'Fill validation gaps', '/nf:validate-phase ' + N, false),
    ]);
  }
  if (!art.hasVerification) {
    return wrap('verify-pending', 'Phase ' + N + ' is built — verify it.', [
      act('verify', 'Verify phase ' + N, '/nf:verify-work ' + N, true),
      act('validate', 'Adversarial coverage audit', '/nf:validate-phase ' + N, false),
    ]);
  }
  return wrap('unknown', 'Phase ' + N + ' in progress.', [
    act('progress', 'Show status', '/nf:progress', true),
    act('autonomous', 'Continue autonomously', '/nf:autonomous --from ' + N, false),
  ]);
}

// ─── evidence gathering (CLI only) ───────────────────────────────────────────
function nfTools(args) {
  try {
    const bin = path.join(process.env.HOME || '', '.claude', 'nf', 'bin', 'nf-tools.cjs');
    const target = fs.existsSync(bin) ? bin : path.join(__dirname, '..', 'core', 'bin', 'nf-tools.cjs');
    const r = spawnSync(process.execPath, [target, ...args], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? r.stdout : '';
  } catch (_) { return ''; }
}

function gatherContext(root) {
  const planning = path.join(root, '.planning');
  const roadmapExists = fs.existsSync(path.join(planning, 'ROADMAP.md'));
  let stateText = '';
  try { stateText = fs.readFileSync(path.join(planning, 'STATE.md'), 'utf8'); } catch (_) {}
  let phases = [];
  try {
    const raw = nfTools(['roadmap', 'analyze']);
    if (raw) phases = (JSON.parse(raw).phases || []);
  } catch (_) {}
  // formal gaps (fusion, best-effort)
  let formalGaps = 0;
  try {
    const fvx = path.join(process.env.HOME || '', '.claude', 'nf-bin', 'extract-fv-fails.cjs');
    const target = fs.existsSync(fvx) ? fvx : path.join(__dirname, 'extract-fv-fails.cjs');
    const r = spawnSync(process.execPath, [target, '--json'], { encoding: 'utf8', timeout: 8000, env: { ...process.env } });
    if (r.status === 0 && r.stdout) formalGaps = (JSON.parse(r.stdout) || []).length;
  } catch (_) {}
  return { roadmapExists, stateText, phases, activeArtifacts: {}, formalGaps };
}

if (require.main === module) {
  const ctx = gatherContext(process.cwd());
  const result = detectSituation(ctx);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('Situation: ' + result.situation + ' — ' + result.summary + '\n\n');
    for (const a of result.actions) process.stdout.write('  ' + (a.recommended ? '→ ' : '  ') + a.label + '  (' + a.command + ')\n');
  }
  process.exit(0);
}

module.exports = { detectSituation };
