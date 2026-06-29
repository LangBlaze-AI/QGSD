#!/usr/bin/env node
'use strict';

/**
 * cross-layer-dashboard.cjs — Cross-Layer Alignment Dashboard.
 *
 * Aggregates L1 coverage, Wiring:Evidence, Wiring:Purpose, and Wiring:Coverage scores into a single
 * terminal view. Re-runs gate scripts by default for freshness.
 *
 * Requirements: INTG-04
 *
 * Usage:
 *   node bin/cross-layer-dashboard.cjs              # re-run gates, display terminal dashboard
 *   node bin/cross-layer-dashboard.cjs --cached     # read existing gate JSON files (fast)
 *   node bin/cross-layer-dashboard.cjs --json       # output aggregated JSON
 *   node bin/cross-layer-dashboard.cjs --cached --json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveGateScore } = require('./gate-score-utils.cjs');

const ROOT = process.env.PROJECT_ROOT
  || (process.argv.find(a => a.startsWith('--project-root=')) || '').replace('--project-root=', '')
  || path.join(__dirname, '..');
const SCRIPT_DIR = __dirname;
const FORMAL = path.join(ROOT, '.planning', 'formal');
const EVIDENCE_DIR = path.join(FORMAL, 'evidence');
const GATES_DIR = path.join(FORMAL, 'gates');

const args = process.argv.slice(2);
const JSON_FLAG = args.includes('--json');
const CACHED_FLAG = args.includes('--cached');

// ── Health indicator logic ──────────────────────────────────────────────────

/**
 * Returns [PASS], [WARN], or [FAIL] based on score vs target.
 * PASS: score >= target
 * WARN: score >= target * 0.8
 * FAIL: score < target * 0.8
 */
function healthIndicator(score, target) {
  if (score == null || target == null) return '[N/A]';
  if (score >= target) return '[PASS]';
  if (score >= target * 0.8) return '[WARN]';
  return '[FAIL]';
}

// ── spawnTool (adapted from nf-solve.cjs) ───────────────────────────────────

function spawnTool(script, spawnArgs) {
  const scriptPath = path.join(SCRIPT_DIR, path.basename(script));
  const childArgs = [...spawnArgs];
  if (!childArgs.some(a => a.startsWith('--project-root='))) {
    childArgs.push('--project-root=' + ROOT);
  }
  try {
    const result = spawnSync(process.execPath, [scriptPath, ...childArgs], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60000,
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) {
      return { ok: false, stdout: '', stderr: result.error.message };
    }
    // Gate scripts exit 1 when target not met but still produce valid JSON
    return {
      ok: result.status === 0 || result.status === 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status,
    };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err.message };
  }
}

// ── Data collection ─────────────────────────────────────────────────────────

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function collectGateData(script, cachedFile, jsonFlag) {
  if (CACHED_FLAG) {
    const cached = readJsonFile(path.join(GATES_DIR, cachedFile));
    if (cached) return cached;
    process.stderr.write(`[dashboard] WARN: cached file ${cachedFile} not found, gate unavailable\n`);
    return null;
  }
  const result = spawnTool(script, ['--json']);
  if (!result.ok) {
    process.stderr.write(`[dashboard] WARN: ${script} failed: ${result.stderr.slice(0, 200)}\n`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    process.stderr.write(`[dashboard] WARN: ${script} produced invalid JSON\n`);
    return null;
  }
}

function collectL1Coverage() {
  const imap = readJsonFile(path.join(EVIDENCE_DIR, 'instrumentation-map.json'));
  if (!imap || !imap.coverage) return null;
  return imap.coverage.coverage_pct;
}

function collectMaturityData() {
  if (CACHED_FLAG) {
    // No cached file for maturity; skip in cached mode
    return null;
  }
  const result = spawnTool('promote-gate-maturity.cjs', ['--check', '--json']);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch { return null; }
}

function collectAll() {
  let gateA = null, gateB = null, gateC = null;

  if (CACHED_FLAG) {
    // Read from cached gate files (written by --aggregate mode)
    gateA = readJsonFile(path.join(GATES_DIR, 'gate-a-grounding.json'));
    gateB = readJsonFile(path.join(GATES_DIR, 'gate-b-abstraction.json'));
    gateC = readJsonFile(path.join(GATES_DIR, 'gate-c-validation.json'));
  } else {
    const result = spawnTool('compute-per-model-gates.cjs', ['--aggregate', '--json']);
    if (result.ok || result.stdout) {
      try {
        const data = JSON.parse(result.stdout);
        if (data.aggregate) {
          gateA = data.aggregate.gate_a;
          gateB = data.aggregate.gate_b;
          gateC = data.aggregate.gate_c;
        }
      } catch { /* fall through with nulls */ }
    }
  }

  const l1Pct = collectL1Coverage();
  const maturity = collectMaturityData();
  return { gateA, gateB, gateC, l1Pct, maturity };
}

// ── Build aggregated result ─────────────────────────────────────────────────

function buildResult(data) {
  const { gateA, gateB, gateC, l1Pct, maturity } = data || {};

  const result = {
    generated: new Date().toISOString(),
    l1_coverage_pct: (typeof l1Pct === 'number' && Number.isFinite(l1Pct)) ? l1Pct : null,
    gate_a: gateA ? {
      score: resolveGateScore(gateA, 'a'),
      target: gateA.target,
      target_met: gateA.target_met,
      explained: gateA.explained,
      total: gateA.total,
    } : null,
    gate_b: gateB ? {
      score: resolveGateScore(gateB, 'b'),
      target: gateB.target,
      target_met: gateB.target_met,
      grounded_entries: gateB.grounded_entries,
      total_entries: gateB.total_entries,
    } : null,
    gate_c: gateC ? {
      score: resolveGateScore(gateC, 'c'),
      target: gateC.target,
      target_met: gateC.target_met,
      validated_entries: gateC.validated_entries,
      total_entries: gateC.total_entries,
    } : null,
    maturity: maturity ? {
      total: maturity.total,
      by_level: maturity.by_level,
    } : null,
  };

  // Determine overall health
  const allMet = [
    result.gate_a?.target_met,
    result.gate_b?.target_met,
    result.gate_c?.target_met,
  ];
  result.all_targets_met = allMet.every(v => v === true);

  return result;
}

// ── Terminal rendering ──────────────────────────────────────────────────────

function pct(value, decimals = 1) {
  if (value == null) return 'N/A';
  return (value * 100).toFixed(decimals) + '%';
}

function renderTerminal(result) {
  result = result || {};
  const lines = [];
  const W = 64;
  const hr = '─'.repeat(W);
  const dhr = '═'.repeat(W);

  lines.push('╔' + dhr + '╗');
  lines.push('║' + '  Cross-Layer Alignment Dashboard'.padEnd(W) + '║');
  lines.push('╚' + dhr + '╝');
  lines.push('');

  // L1 Coverage
  const l1Target = 50; // percentage
  const l1Val = result.l1_coverage_pct;
  const l1Health = l1Val != null
    ? healthIndicator(l1Val / 100, l1Target / 100)
    : '[N/A]';
  lines.push('┌' + hr + '┐');
  lines.push('│' + '  Layer Health'.padEnd(W) + '│');
  lines.push('├' + hr + '┤');
  lines.push('│' + `  L1 Coverage:  ${l1Val != null ? l1Val.toFixed(1) + '%' : 'N/A'}`.padEnd(W - 8) + l1Health.padStart(8) + '│');

  // Wiring:Evidence
  const gaScore = result.gate_a?.score;
  const gaTarget = result.gate_a?.target ?? 0.8;
  const gaHealth = gaScore != null ? healthIndicator(gaScore, gaTarget) : '[N/A]';
  const gaDetail = result.gate_a
    ? `${result.gate_a.explained}/${result.gate_a.total} traces explained`
    : '';
  lines.push('│' + `  Wiring:Evidence: ${pct(gaScore)}`.padEnd(W - 8) + gaHealth.padStart(8) + '│');
  if (gaDetail) {
    lines.push('│' + `                ${gaDetail}`.padEnd(W) + '│');
  }

  // Wiring:Purpose
  const gbScore = result.gate_b?.score;
  const gbTarget = result.gate_b?.target ?? 1.0;
  const gbHealth = gbScore != null ? healthIndicator(gbScore, gbTarget) : '[N/A]';
  const gbDetail = result.gate_b
    ? `${result.gate_b.grounded_entries}/${result.gate_b.total_entries} entries grounded`
    : '';
  lines.push('│' + `  Wiring:Purpose:  ${pct(gbScore)}`.padEnd(W - 8) + gbHealth.padStart(8) + '│');
  if (gbDetail) {
    lines.push('│' + `                ${gbDetail}`.padEnd(W) + '│');
  }

  // Wiring:Coverage
  const gcScore = result.gate_c?.score;
  const gcTarget = result.gate_c?.target ?? 0.8;
  const gcHealth = gcScore != null ? healthIndicator(gcScore, gcTarget) : '[N/A]';
  const gcDetail = result.gate_c
    ? `${result.gate_c.validated_entries}/${result.gate_c.total_entries} entries validated`
    : '';
  lines.push('│' + `  Wiring:Coverage: ${pct(gcScore)}`.padEnd(W - 8) + gcHealth.padStart(8) + '│');
  if (gcDetail) {
    lines.push('│' + `                ${gcDetail}`.padEnd(W) + '│');
  }

  lines.push('└' + hr + '┘');

  // Maturity distribution
  if (result.maturity) {
    lines.push('');
    lines.push('┌' + hr + '┐');
    lines.push('│' + '  Gate Maturity Distribution'.padEnd(W) + '│');
    lines.push('├' + hr + '┤');
    const by = result.maturity.by_level || {};
    lines.push('│' + `  ADVISORY:    ${by.ADVISORY ?? 0}`.padEnd(W) + '│');
    lines.push('│' + `  SOFT_GATE:   ${by.SOFT_GATE ?? 0}`.padEnd(W) + '│');
    lines.push('│' + `  HARD_GATE:   ${by.HARD_GATE ?? 0}`.padEnd(W) + '│');
    lines.push('│' + `  Total:       ${result.maturity.total ?? 0}`.padEnd(W) + '│');
    lines.push('└' + hr + '┘');
  }

  // Composite summary
  lines.push('');
  const status = result.all_targets_met ? 'ALL TARGETS MET' : 'TARGETS NOT MET';
  const statusIndicator = result.all_targets_met ? '[PASS]' : '[FAIL]';
  lines.push(`  Composite: ${status}  ${statusIndicator}`);
  lines.push('');

  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const data = collectAll();
  const result = buildResult(data);

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderTerminal(result));
  }

  // Exit 0 if all gates met, 1 otherwise
  process.exit(result.all_targets_met ? 0 : 1);
}

// Export for testing
module.exports = { healthIndicator, buildResult, renderTerminal };

if (require.main === module) {
  main();
}
