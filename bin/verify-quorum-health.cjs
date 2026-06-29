#!/usr/bin/env node
'use strict';
// bin/verify-quorum-health.cjs
// Verifies that the XState machine's maxDeliberation is calibrated for the
// actual empirical reliability of the quorum agents.
//
// The formal PRISM model uses conservative priors (tp=0.85, unavail=0.15).
// This tool substitutes real scoreboard rates and recomputes:
//   - P(majority per round)  — joint probability across all agents
//   - Expected rounds         — average rounds to decide
//   - P(within MaxDeliberation rounds) — actual confidence for the current setting
//   - Recommended MaxDeliberation for target confidence
//
// Exits 1 if actual P(within MaxDeliberation) < TARGET_CONFIDENCE.
// This makes it a CI gate: if agents degrade, the build breaks and flags it.
//
// Usage:
//   node bin/verify-quorum-health.cjs              # target: 95%
//   node bin/verify-quorum-health.cjs --target=0.99
//   node bin/verify-quorum-health.cjs --auto-apply # auto-applies maxDeliberation if below target

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Pure Functions ────────────────────────────────────────────────────────────

// suggestMaxDeliberation(pPerRound, targetConfidence)
// Computes the recommended maxDeliberation value using the geometric distribution formula:
//   k = ceil(log(1 - targetConfidence) / log(1 - pPerRound))
function suggestMaxDeliberation(pPerRound, targetConfidence) {
  if (pPerRound <= 0) return Infinity;
  if (pPerRound >= 1) return 1;
  return Math.ceil(Math.log(1 - targetConfidence) / Math.log(1 - pPerRound));
}

// computeRates(slot, rounds)
// Computes per-agent rates from a list of rounds.
function computeRates(slot, rounds) {
  const SLOTS = ['gemini', 'opencode', 'copilot', 'codex'];
  const MIN_ROUNDS = 30;
  const TP_PRIOR = 0.85;
  const UNAVAIL_PRIOR = 0.15;

  // Exclude Mode A rounds (empty-string result) and UNAVAILABLE typo variant —
  // neither carries a valid binary signal for rate calculation.
  const list = Array.isArray(rounds) ? rounds : [];
  const relevant = list.filter(r => {
    const v = r && r.votes ? r.votes[slot] : undefined;
    return v !== undefined && v !== '' && v !== 'UNAVAILABLE';
  });
  const n = relevant.length;
  if (n < MIN_ROUNDS) {
    return { n, tpRate: TP_PRIOR, unavailRate: UNAVAIL_PRIOR, usedPrior: true };
  }
  const approvals = relevant.filter(r => r.votes[slot] === 'TP' || r.votes[slot] === 'TP+').length;
  const unavails  = relevant.filter(r => r.votes[slot] === 'UNAVAIL').length;
  return {
    n,
    tpRate:      approvals / n,
    unavailRate: unavails  / n,
    usedPrior:   false,
  };
}

// pMajorityExternal(agents)
// Computes P(at least 2 of the 4 external agents approve) using inclusion-exclusion.
function pMajorityExternal(agents) {
  const names = Object.keys(agents);
  const n = names.length;
  let pAtLeast2 = 0;

  for (let mask = 0; mask < (1 << n); mask++) {
    const selected = names.filter((_, i) => mask & (1 << i));
    if (selected.length < 2) continue;
    const prob = names.reduce((acc, name, i) =>
      acc * ((mask & (1 << i)) ? agents[name].pApprove : (1 - agents[name].pApprove))
    , 1);
    pAtLeast2 += prob;
  }
  return pAtLeast2;
}

// applyMaxDeliberationUpdate(newValue, options)
// Atomically updates maxDeliberation in the XState machine and config.json,
// then regenerates formal specs. Returns { success, newValue, machineUpdated, configUpdated, specsRegenerated, error, rolledBack }
function applyMaxDeliberationUpdate(newValue, options = {}) {
  const machineFile = options.machineFile || path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts');
  const configFile = options.configFile || path.join(ROOT, '.planning', 'config.json');
  const skipSpecGen = options.skipSpecGen || false; // For testing without generate-formal-specs.cjs

  // Backup originals for rollback
  const backups = {};
  const results = { machineUpdated: false, configUpdated: false, specsRegenerated: false };

  try {
    // 1. Update machine.ts
    const machineSrc = fs.readFileSync(machineFile, 'utf8');
    backups.machine = { path: machineFile, content: machineSrc };
    const updated = machineSrc.replace(/maxDeliberation:\s*\d+/, 'maxDeliberation:    ' + newValue);
    fs.writeFileSync(machineFile, updated, 'utf8');
    results.machineUpdated = true;

    // 2. Update config.json if it exists
    if (fs.existsSync(configFile)) {
      const configSrc = fs.readFileSync(configFile, 'utf8');
      backups.config = { path: configFile, content: configSrc };
      const config = JSON.parse(configSrc);
      if (!config.workflow) config.workflow = {};
      config.workflow.maxDeliberation = newValue;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
      results.configUpdated = true;
    }

    // 3. Regenerate formal specs (unless skipped for testing)
    if (!skipSpecGen) {
      const { spawnSync } = require('child_process');
      const genResult = spawnSync('node', ['bin/generate-formal-specs.cjs'], { cwd: ROOT, timeout: 30000 });
      if (genResult.error || genResult.status !== 0) throw new Error('Formal spec generation failed');
      results.specsRegenerated = true;

      // 4. Verify spec sync
      const syncResult = spawnSync('node', ['bin/check-spec-sync.cjs'], { cwd: ROOT, timeout: 10000 });
      if (syncResult.error || syncResult.status !== 0) throw new Error('Spec sync verification failed');
    }

    return { success: true, newValue, ...results };

  } catch (err) {
    // Rollback all backups
    for (const backup of Object.values(backups)) {
      try { fs.writeFileSync(backup.path, backup.content, 'utf8'); } catch (_) {}
    }
    return { success: false, error: err.message, rolledBack: true };
  }
}

// computePassAtKRates(conformanceEventsPath)
// Reads a JSONL conformance events file and computes pass@k consensus efficiency
// rates from quorum_complete APPROVE events that have a pass_at_k field.
// Excludes cache-hit events (pass_at_k === 0) and pre-PASSK events (no pass_at_k field).
// Returns { total, pass_at_1, pass_at_3, avg_k } — rates as floats 0.0-1.0.
function computePassAtKRates(conformanceEventsPath) {
  const result = { total: 0, pass_at_1: 0, pass_at_3: 0, avg_k: 0 };
  if (!fs.existsSync(conformanceEventsPath)) return result;

  let raw;
  try {
    raw = fs.readFileSync(conformanceEventsPath, 'utf8');
  } catch {
    return result;
  }
  const lines = raw
    .split('\n')
    .filter(l => l.trim().length > 0);

  const qualifying = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.action !== 'quorum_complete') continue;
      if (evt.outcome !== 'APPROVE') continue;
      if (typeof evt.pass_at_k !== 'number') continue; // skip pre-PASSK events
      if (evt.pass_at_k === 0) continue; // skip cache hits
      qualifying.push(evt.pass_at_k);
    } catch { /* skip malformed lines */ }
  }

  if (qualifying.length === 0) return result;

  result.total = qualifying.length;
  result.pass_at_1 = qualifying.filter(k => k === 1).length / qualifying.length;
  result.pass_at_3 = qualifying.filter(k => k <= 3).length / qualifying.length;
  result.avg_k = qualifying.reduce((sum, k) => sum + k, 0) / qualifying.length;
  return result;
}

// ── CLI Handler ───────────────────────────────────────────────────────────────

function main() {
  // ── Config ────────────────────────────────────────────────────────────────────
  const DEFAULT_TARGET = 0.95;
  const targetArg = process.argv.find(a => a.startsWith('--target='));
  const TARGET_CONFIDENCE = targetArg ? parseFloat(targetArg.split('=')[1]) : DEFAULT_TARGET;

  // ── Load XState machine (source of truth for MaxDeliberation) ─────────────────
  const machineSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts'), 'utf8'
  );
  const maxDelibMatch = machineSrc.match(/maxDeliberation:\s*(\d+)/);
  const maxDelib = maxDelibMatch ? parseInt(maxDelibMatch[1], 10) : null;
  if (!maxDelib) {
    process.stderr.write('[verify-quorum-health] Cannot read maxDeliberation from XState machine.\n');
    process.exit(1);
  }

  // ── Load scoreboard ────────────────────────────────────────────────────────────
  let scoreboardPath;
  try {
    const pp = require('./planning-paths.cjs');
    scoreboardPath = pp.resolveWithFallback(ROOT, 'quorum-scoreboard');
  } catch (_) {
    scoreboardPath = path.join(ROOT, '.planning', 'quorum-scoreboard.json');
  }
  if (!fs.existsSync(scoreboardPath)) {
    process.stderr.write('[verify-quorum-health] No scoreboard found — cannot compute empirical rates.\n');
    process.stderr.write('[verify-quorum-health] Run some quorum rounds first.\n');
    process.exit(1);
  }
  const scoreboard = JSON.parse(fs.readFileSync(scoreboardPath, 'utf8'));
  const rounds = scoreboard.rounds || [];

  // ── Compute per-agent rates ───────────────────────────────────────────────────
  const SLOTS = ['gemini', 'opencode', 'copilot', 'codex'];

  const agentRates = {};
  for (const slot of SLOTS) {
    const r = computeRates(slot, rounds);
    agentRates[slot] = {
      ...r,
      pApprove: r.tpRate * (1 - r.unavailRate),  // P(agent votes APPROVE in one round)
    };
  }

  const pPerRound  = pMajorityExternal(agentRates);
  const expected   = 1 / pPerRound;
  const pWithinK   = k => 1 - Math.pow(1 - pPerRound, k);
  const kForTarget = suggestMaxDeliberation(pPerRound, TARGET_CONFIDENCE);
  const pActual    = pWithinK(maxDelib);

  // ── Conservative-prior comparison ────────────────────────────────────────────
  const P_PRIOR_PER_ROUND = 0.85 * (1 - 0.15);  // 0.7225 — what quorum.props assumed
  const pPriorWithinK = k => 1 - Math.pow(1 - P_PRIOR_PER_ROUND, k);

  // ── Report ────────────────────────────────────────────────────────────────────
  process.stdout.write('\n[verify-quorum-health] nForma Quorum Reliability Report\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

  process.stdout.write('Per-agent effective approval probability (tp_rate × availability):\n');
  for (const [slot, r] of Object.entries(agentRates)) {
    const flag = r.usedPrior ? ' [prior]' : ' [empirical, n=' + r.n + ']';
    process.stdout.write(
      '  ' + slot.padEnd(10) + 'tp=' + r.tpRate.toFixed(4) +
      '  unavail=' + r.unavailRate.toFixed(4) +
      '  p_approve=' + r.pApprove.toFixed(4) + flag + '\n'
    );
  }

  process.stdout.write('\nJoint majority probability (P(≥2 of 4 external approve | Claude always approves)):\n');
  process.stdout.write('  Conservative priors: p_round = ' + P_PRIOR_PER_ROUND.toFixed(4) + '\n');
  process.stdout.write('  Empirical rates:     p_round = ' + pPerRound.toFixed(4) + '\n');

  process.stdout.write('\nConvergence analysis with maxDeliberation=' + maxDelib + ' (from XState machine):\n');
  process.stdout.write('  Expected rounds (empirical): ' + expected.toFixed(2) + '\n');
  process.stdout.write('  P(decide within ' + maxDelib + ' rounds):\n');
  process.stdout.write('    Prior assumption:    ' + (pPriorWithinK(maxDelib) * 100).toFixed(1) + '% (spec was designed for this)\n');
  process.stdout.write('    Empirical reality:   ' + (pActual * 100).toFixed(1) + '%  ← actual system\n');

  const gap = pPriorWithinK(maxDelib) - pActual;
  if (gap > 0.01) {
    process.stdout.write('    Gap: -' + (gap * 100).toFixed(1) + ' percentage points from designed confidence\n');
  }

  process.stdout.write('\nRecommended maxDeliberation for target confidence levels:\n');
  for (const [label, t] of [['90%', 0.90], ['95%', 0.95], ['99%', 0.99]]) {
    const k = suggestMaxDeliberation(pPerRound, t);
    const mark = t === TARGET_CONFIDENCE ? ' ← target' : '';
    process.stdout.write('  ' + label + ' confidence: maxDeliberation = ' + k + mark + '\n');
  }

  process.stdout.write('\n');

  // ── Gate ──────────────────────────────────────────────────────────────────────
  const pass = pActual >= TARGET_CONFIDENCE;

  // ── Pass@k Consensus Efficiency ──────────────────────────────────────────
  try {
    let conformancePath;
    try {
      const pp = require('./planning-paths.cjs');
      conformancePath = pp.resolve(ROOT, 'conformance-events');
    } catch (_) {
      // Fallback: try both canonical and legacy paths directly
      const canonical = path.join(ROOT, '.planning', 'telemetry', 'conformance-events.jsonl');
      const legacy = path.join(ROOT, '.planning', 'conformance-events.jsonl');
      conformancePath = fs.existsSync(canonical) ? canonical : legacy;
    }
    const passAtK = computePassAtKRates(conformancePath);
    process.stdout.write('## Pass@k Consensus Efficiency\n');
    if (passAtK.total > 0) {
      process.stdout.write('  pass@1:              ' + (passAtK.pass_at_1 * 100).toFixed(1) + '%\n');
      process.stdout.write('  pass@3:              ' + (passAtK.pass_at_3 * 100).toFixed(1) + '%\n');
      process.stdout.write('  avg rounds:          ' + passAtK.avg_k.toFixed(1) + '\n');
      process.stdout.write('  total quorum events: ' + passAtK.total + '\n');
    } else {
      process.stdout.write('  No pass@k data available yet (requires quorum runs after v0.28-02).\n');
    }
    process.stdout.write('\n');
  } catch (_) {
    // Fail-open: pass@k reporting is informational, never blocks the gate
  }

  if (pass) {
    process.stdout.write('✓ PASS  P(within ' + maxDelib + ' rounds) = ' + (pActual * 100).toFixed(1) + '% ≥ ' + (TARGET_CONFIDENCE * 100).toFixed(0) + '% target\n\n');
  } else {
    process.stderr.write(
      '✗ FAIL  P(within ' + maxDelib + ' rounds) = ' + (pActual * 100).toFixed(1) + '% < ' + (TARGET_CONFIDENCE * 100).toFixed(0) + '% target\n' +
      '        Recommended: update maxDeliberation to ' + kForTarget + '\n'
    );

    // ── Handle --auto-apply flag ───────────────────────────────────────────
    const autoApply = process.argv.includes('--auto-apply');
    if (autoApply) {
      process.stderr.write('Applying maxDeliberation = ' + kForTarget + ' (--auto-apply)...\n');
      const result = applyMaxDeliberationUpdate(kForTarget);
      if (result.success) {
        process.stderr.write('Applied successfully. Machine: ' + result.machineUpdated +
          ', Config: ' + result.configUpdated + ', Specs: ' + result.specsRegenerated + '\n');
        process.exit(0); // Success after auto-apply
      } else {
        process.stderr.write('Auto-apply failed: ' + result.error + ' (rolled back)\n');
        process.exit(1);
      }
    } else {
      process.stderr.write('        Run with --auto-apply to apply automatically, or manually update:\n' +
        '        src/machines/nf-workflow.machine.ts and re-run: node bin/generate-formal-specs.cjs && node bin/check-spec-sync.cjs\n\n');
      process.exit(1);
    }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { suggestMaxDeliberation, applyMaxDeliberationUpdate, computeRates, pMajorityExternal, computePassAtKRates };

// ── CLI Execution ─────────────────────────────────────────────────────────────

if (require.main === module) {
  main();
}
