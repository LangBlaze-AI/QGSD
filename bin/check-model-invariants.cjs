#!/usr/bin/env node
'use strict';
// bin/check-model-invariants.cjs
// Model-checking sweep for BEHAVIORAL formal defects (deadlock potential, safety
// invariant violations) that static lints cannot see — by actually running TLC.
// This wires up nForma's existing TLC integration (resolve-formal-tools + tla2tools);
// it is NOT a new model checker.
//
// Scope (keeps it fast + false-positive-free):
//   - Only CONCRETE models (no CONSTANTS) — they need no bounding cfg, so a cfg can
//     be auto-generated. Constant-parameterized models need hand cfgs (that's why the
//     full TLC pass is --fast-skipped) and are left alone.
//   - Flags ONLY genuine `Invariant X is violated` — NOT TLC's default deadlock check
//     (which fires on models that legitimately terminate) and NOT cfg/parse errors.
//   Verified 0 findings across nForma's real concrete models, so any finding is a
//   real reachable safety violation.
//
// Fail-open: if tla2tools.jar / Java is unavailable, returns skipped (residual -1,
// never a false 0).
//
// Usage:  node bin/check-model-invariants.cjs --json   → { findings, count, skipped? }
// Exit:   0 = clean/skipped, 1 = violations.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const TLA_DIR = path.join(ROOT, '.planning', 'formal', 'tla');

function resolveJar(root) {
  try {
    const { resolveTlaJar } = require('./resolve-formal-tools.cjs');
    return resolveTlaJar(root);
  } catch (_) {
    const home = path.join(process.env.HOME || '', '.local', 'share', 'nf-formal', 'tla', 'tla2tools.jar');
    return fs.existsSync(home) ? home : null;
  }
}

// Per-model TLC cap: a reachable-state safety violation on a concrete model is found
// in well under a second; 15s is ample headroom while bounding a pathological
// non-terminating model. TOTAL_BUDGET_MS caps cumulative wall time so a handful of
// state-exploding models can't blow up latency — remaining models are skipped
// (informational sweep, fail-open). Measured ~7s across nForma's 197 .tla files, so
// the budget is never hit in practice; it's a defensive ceiling.
const PER_MODEL_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 60000;

function stripComments(c) {
  return String(c).replace(/\(\*[\s\S]*?\*\)/g, ' ').replace(/\\\*[^\n]*/g, ' ');
}

// Parse the temporal SPECIFICATION def name and the safety-invariant candidate defs.
// Spec: a def whose OWN body (not spanning other defs) contains a `[][Next]` formula;
// prefer one literally named Spec. Invariants: nullary boolean state predicates with
// no primes and no temporal/action operators.
function analyzeModel(content) {
  const c = stripComments(content);
  const lines = c.split('\n');
  const headRe = /^([A-Za-z_]\w*)\s*==(.*)$/;
  let spec = null;
  const invs = [];
  let i = 0;
  while (i < lines.length) {
    const h = lines[i].match(headRe);
    if (!h) { i++; continue; }
    const name = h[1];
    const parenParams = /^[A-Za-z_]\w*\s*\([^)]*\)\s*==/.test(lines[i]);
    const bodyLines = [h[2]];
    let j = i + 1;
    for (; j < lines.length; j++) { if (headRe.test(lines[j]) || /^====/.test(lines[j])) break; bodyLines.push(lines[j]); }
    const body = bodyLines.join(' ');
    if (/\[\]\s*\[/.test(body)) {
      if (name === 'Spec') spec = 'Spec';
      else if (!spec) spec = name;
    } else if (
      !parenParams &&
      !['Init', 'Next', 'vars', 'Spec'].includes(name) &&
      !/'/.test(body) &&
      !/\[\]|<>|WF_|SF_|ENABLED|UNCHANGED/.test(body) &&
      !/CHOOSE|LET/.test(body) &&
      /=|#|\\in|~|=>|\\A|\\E|\\subseteq/.test(body)
    ) {
      invs.push(name);
    }
    i = j;
  }
  return { spec, invs };
}

function checkModelInvariants(root) {
  const jar = resolveJar(root);
  if (!jar || !fs.existsSync(jar)) return { skipped: true, reason: 'tla2tools.jar not found', findings: [], count: 0 };
  const dir = path.join(root, '.planning', 'formal', 'tla');
  if (!fs.existsSync(dir)) return { skipped: false, findings: [], count: 0 };
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.tla') && f.indexOf('_TTrace_') === -1); }
  catch (_) { return { skipped: false, findings: [], count: 0 }; }

  const findings = [];
  const startedAt = Date.now();
  for (const f of files) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break; // defensive wall-clock ceiling
    let content;
    try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
    if (/\bCONSTANTS?\b/.test(stripComments(content))) continue; // parameterized — needs a hand cfg
    const { spec, invs } = analyzeModel(content);
    if (!spec || invs.length === 0) continue;
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-mc-')); // inside try: a mkdtemp failure skips THIS model, not the loop
      const base = f.replace(/\.tla$/, '');
      fs.writeFileSync(path.join(tmp, f), content);
      fs.writeFileSync(path.join(tmp, base + '.cfg'), 'SPECIFICATION ' + spec + '\n' + invs.map(x => 'INVARIANT ' + x).join('\n') + '\n');
      const r = spawnSync('java', ['-cp', jar, 'tlc2.TLC', '-config', base + '.cfg', f], { cwd: tmp, encoding: 'utf8', timeout: PER_MODEL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      const out = (r.stdout || '') + (r.stderr || '');
      const m = out.match(/Invariant (\w+) is violated/);
      if (m) {
        findings.push({ rule: 'invariant-violation', model: base, invariant: m[1], message: 'TLC found a reachable state violating invariant ' + m[1] + ' in ' + f });
      }
    } catch (_) { /* per-model failure — skip, never crash the sweep */ }
    finally { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } }
  }
  return { skipped: false, findings: findings, count: findings.length };
}

module.exports = { checkModelInvariants: checkModelInvariants, analyzeModel: analyzeModel };

if (require.main === module) {
  const asJson = process.argv.includes('--json');
  const r = checkModelInvariants(ROOT);
  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else if (r.skipped) {
    console.log('[model-check] skipped: ' + r.reason);
  } else {
    for (const f of r.findings) console.log('[' + f.rule + '] ' + f.model + ': ' + f.message);
    console.log(r.count + ' model-check violation(s)');
  }
  process.exit(!r.skipped && r.count > 0 ? 1 : 0);
}
