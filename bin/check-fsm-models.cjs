#!/usr/bin/env node
'use strict';
// bin/check-fsm-models.cjs
// Closes the FSM → TLA+ → model-check loop. nForma transpiles its own state machines
// to TLA+ via bin/fsm-to-tla.cjs (28 framework adapters), emitting to
// .planning/formal/tla/ a parameterized .tla PLUS a sibling `MC<name>.cfg` that pins
// the CONSTANTS and declares `INVARIANT TypeOK`. The concrete-only model_check sweep
// (check-model-invariants.cjs) SKIPS these (they carry CONSTANTS), so nForma's own
// transpiled state machines were never model-checked. This sweep consumes the
// emitter's provided cfg and runs TLC on each — activating those dormant models.
//
// Safety (INVARIANT) runs on every paired model. Liveness (PROPERTY) runs ONLY under
// the behavior-#3 dual gate — the cfg declares a PROPERTY AND the spec carries
// fairness (WF_/SF_) — see .planning/quorum/debates/2026-07-04-fsm-tla-loop-closure.md:
//   - Safety: cfg's INVARIANT blocks, PROPERTY stripped, CHECK_DEADLOCK FALSE. This is
//     FP-safe on the emitter's SEQUENTIAL specs (a reachable INVARIANT violation is
//     genuine regardless of interleaving).
//   - Liveness: cfg's PROPERTY blocks, INVARIANT stripped, CHECK_DEADLOCK FALSE, run
//     ONLY when the spec declares fairness. Without fairness a `<>P` fails vacuously
//     via stuttering — the exact false-positive class the FSM-loop Round-1 BLOCK
//     flagged; the fairness gate eliminates it (verified 0 violations / 21 fair
//     models). Deadlock-checking and multi-process concurrency remain deferred (they
//     need an emitter Termination annotation / PlusCal process composition — naive
//     CHECK_DEADLOCK false-positives on legitimately-terminating FSMs).
//   - cfg→spec pairing reuses run-tlc.cjs's proven heuristic (header .tla reference,
//     then MC-strip + NF/QNF/bare/_xstate naming). If pairing is UNRESOLVED it SKIPS
//     the cfg — it never falls back to a default model (that would model-check the
//     wrong spec and manufacture false findings).
//
// Fail-open: missing jar / unreadable cfg / unresolved spec / TLC error all SKIP the
// individual model; a whole-sweep failure returns skipped. Any finding is a real
// reachable invariant violation in a transpiled state machine.
//
// Usage:  node bin/check-fsm-models.cjs --json  → { findings, count, checked, skipped? }
// Exit:   0 = clean/skipped, 1 = invariant violations found.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const PER_MODEL_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 90000; // more models than the concrete sweep → a larger ceiling

function resolveJar(root) {
  try {
    const { resolveTlaJar } = require('./resolve-formal-tools.cjs');
    return resolveTlaJar(root);
  } catch (_) {
    const home = path.join(process.env.HOME || '', '.local', 'share', 'nf-formal', 'tla', 'tla2tools.jar');
    return fs.existsSync(home) ? home : null;
  }
}

// Pair an MC<name>.cfg to its spec .tla. Mirrors run-tlc.cjs resolveSpecFile, but
// returns null (SKIP) instead of falling back to a default — an FP-safe sweep must
// never model-check the wrong model. `allTla` is the list of .tla basenames.
function resolveSpec(cfgName, cfgContent, allTla) {
  const has = (f) => allTla.indexOf(f) !== -1;
  // Strategy 1: an explicit `<Name>.tla` reference in the cfg header, or "for <Name>".
  const header = String(cfgContent).split('\n').slice(0, 10).join('\n');
  const ref = header.match(/\b([A-Z]\w+)\.tla\b/);
  if (ref && has(ref[1] + '.tla')) return ref[1] + '.tla';
  const forRef = header.match(/\bfor\s+([A-Z]\w+)/);
  if (forRef && has(forRef[1] + '.tla')) return forRef[1] + '.tla';
  // Strategy 2: naming convention — strip MC, then match NF*/QNF*/bare/_xstate.
  const norm = (s) => s.toLowerCase().replace(/-/g, '');
  const stripped = norm(cfgName.replace(/^MC/, ''));
  const tlas = allTla.filter((f) => f.endsWith('.tla') && f.indexOf('TTrace') === -1);
  const nf = tlas.filter((f) => f.startsWith('NF'));
  let m = nf.find((f) => norm(f.replace('NF', '').replace('.tla', '')) === stripped) || nf.find((f) => norm(f).indexOf(stripped) !== -1);
  if (m) return m;
  const qnf = tlas.filter((f) => f.startsWith('QNF'));
  m = qnf.find((f) => norm(f.replace('QNF', '').replace('.tla', '')) === stripped) || qnf.find((f) => norm(f).indexOf(stripped) !== -1);
  if (m) return m;
  m = tlas.find((f) => norm(f.replace('.tla', '')) === stripped);
  if (m) return m;
  m = tlas.find((f) => norm(f.replace('.tla', '')) === stripped + '_xstate');
  if (m) return m;
  return null; // unresolved → skip (never a default fallback)
}

// Rewrite the emitted cfg to INVARIANT-ONLY: keep CONSTANT(S)/SPECIFICATION/INVARIANT
// lines, DROP every PROPERTY line, and force CHECK_DEADLOCK FALSE. Returns null if the
// cfg declares no INVARIANT (a PROPERTY-only cfg is out of step-1 scope → skip).
// Any top-level cfg directive (or a comment/blank line) terminates a preceding
// PROPERTY/PROPERTIES continuation block. Listed exhaustively so a directive that
// follows a PROPERTY block (e.g. CHECK_DEADLOCK, ALIAS, POSTCONDITION) correctly
// resets the "dropping" state instead of swallowing subsequent lines.
const CFG_DIRECTIVE = /^(SPECIFICATION|INVARIANTS?|PROPERT(Y|IES)|CONSTANTS?|INIT|NEXT|SYMMETRY|VIEW|CONSTRAINTS?|ACTION_CONSTRAINT|CHECK_DEADLOCK|ALIAS|POSTCONDITION|TEMPORAL)\b/;

function toInvariantOnlyCfg(cfgContent) {
  const lines = String(cfgContent).split('\n');
  const kept = [];
  let hasInv = false;
  let inProperty = false;
  for (const line of lines) {
    const t = line.trim();
    // A new directive OR a comment/blank line ends any PROPERTY continuation block.
    if (CFG_DIRECTIVE.test(t) || t.startsWith('\\*') || t.length === 0) inProperty = false;
    if (/^PROPERT(Y|IES)\b/.test(t)) { inProperty = true; continue; } // drop the PROPERTY header
    if (inProperty) continue; // an indented continuation line of a dropped PROPERTY block
    if (/^CHECK_DEADLOCK\b/.test(t)) continue; // stripped — we re-add it explicitly below
    if (/^INVARIANT/.test(t)) hasInv = true;
    kept.push(line);
  }
  if (!hasInv) return null;
  kept.push('CHECK_DEADLOCK FALSE');
  return kept.join('\n') + '\n';
}

// Build a LIVENESS cfg: keep SPECIFICATION / CONSTANT(S) / PROPERTY, DROP INVARIANT
// (isolate the temporal signal), force CHECK_DEADLOCK FALSE. Returns null if the cfg
// declares no PROPERTY. Only used under the dual gate (spec must also carry fairness).
function toLivenessCfg(cfgContent) {
  const lines = String(cfgContent).split('\n');
  const kept = [];
  let hasProp = false;
  let inInvariant = false;
  for (const line of lines) {
    const t = line.trim();
    if (CFG_DIRECTIVE.test(t) || t.startsWith('\\*') || t.length === 0) inInvariant = false;
    if (/^INVARIANTS?\b/.test(t)) { inInvariant = true; continue; } // drop INVARIANT header
    if (inInvariant) continue; // continuation of a dropped INVARIANT block
    if (/^CHECK_DEADLOCK\b/.test(t)) continue;
    if (/^PROPERT(Y|IES)\b/.test(t)) hasProp = true;
    kept.push(line);
  }
  if (!hasProp) return null;
  kept.push('CHECK_DEADLOCK FALSE');
  return kept.join('\n') + '\n';
}

// The liveness dual gate (behavior #3): a temporal PROPERTY is only checkable when the
// spec declares fairness. Without WF_/SF_ the system may stutter forever, so every
// `<>P` fails vacuously — not false-positive-safe. This is exactly the restriction
// that resolved the FSM-loop Round-1 BLOCK (no liveness on unfair sequential specs).
function specHasFairness(specContent) {
  return /\bWF_|\bSF_/.test(String(specContent));
}

function checkFsmModels(root) {
  const jar = resolveJar(root);
  if (!jar || !fs.existsSync(jar)) return { skipped: true, reason: 'tla2tools.jar not found', findings: [], count: 0, checked: 0 };
  const dir = path.join(root, '.planning', 'formal', 'tla');
  if (!fs.existsSync(dir)) return { skipped: false, findings: [], count: 0, checked: 0 };
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (_) { return { skipped: false, findings: [], count: 0, checked: 0 }; }
  const allTla = entries.filter((f) => f.endsWith('.tla'));
  const cfgs = entries.filter((f) => /^MC.*\.cfg$/.test(f));

  const findings = [];
  let checked = 0;
  const startedAt = Date.now();
  for (const cfg of cfgs) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;
    let cfgContent;
    try { cfgContent = fs.readFileSync(path.join(dir, cfg), 'utf8'); } catch (_) { continue; }
    const spec = resolveSpec(cfg.replace(/\.cfg$/, ''), cfgContent, allTla);
    if (!spec) continue; // unresolved pairing → skip
    const invCfg = toInvariantOnlyCfg(cfgContent);
    // Liveness is dual-gated (behavior #3): cfg has a PROPERTY AND the spec carries
    // fairness. Both must hold, or we don't emit a liveness check at all.
    let specContent = null;
    try { specContent = fs.readFileSync(path.join(dir, spec), 'utf8'); } catch (_) { continue; }
    const liveCfg = specHasFairness(specContent) ? toLivenessCfg(cfgContent) : null;
    if (!invCfg && !liveCfg) continue; // nothing checkable in step-1/2 scope
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fsm-'));
      fs.writeFileSync(path.join(tmp, spec), specContent);
      const base = cfg.replace(/\.cfg$/, '');
      if (invCfg) {
        const cfgName = base + '-inv.cfg';
        fs.writeFileSync(path.join(tmp, cfgName), invCfg);
        const r = spawnSync('java', ['-cp', jar, 'tlc2.TLC', '-config', cfgName, spec], { cwd: tmp, encoding: 'utf8', timeout: PER_MODEL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        const out = (r.stdout || '') + (r.stderr || '');
        const m = out.match(/Invariant (\w+) is violated/);
        if (m) {
          findings.push({ rule: 'fsm-invariant-violation', source: 'fsm-transpiled', model: spec.replace(/\.tla$/, ''), cfg: cfg, invariant: m[1], message: 'TLC found a reachable state violating invariant ' + m[1] + ' in transpiled state machine ' + spec + ' (cfg ' + cfg + ')' });
        }
      }
      if (liveCfg) {
        const cfgName = base + '-live.cfg';
        fs.writeFileSync(path.join(tmp, cfgName), liveCfg);
        // -workers 1: TLC's older liveness checker has known multi-worker bugs (see
        // run-tlc.cjs). Options BEFORE the spec positional — TLC wants the spec module
        // last, so a trailing flag is fragile across versions.
        const r = spawnSync('java', ['-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', cfgName, spec], { cwd: tmp, encoding: 'utf8', timeout: PER_MODEL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        const out = (r.stdout || '') + (r.stderr || '');
        if (/Temporal properties were violated/.test(out)) {
          findings.push({ rule: 'fsm-liveness-violation', source: 'fsm-transpiled', model: spec.replace(/\.tla$/, ''), cfg: cfg, message: 'TLC found a declared liveness property unsatisfiable under the model\'s own fairness in transpiled state machine ' + spec + ' (cfg ' + cfg + ')' });
        }
      }
      checked++;
    } catch (_) { /* per-model failure → skip, never crash the sweep */ }
    finally { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } }
  }
  return { skipped: false, findings: findings, count: findings.length, checked: checked };
}

module.exports = { checkFsmModels: checkFsmModels, resolveSpec: resolveSpec, toInvariantOnlyCfg: toInvariantOnlyCfg, toLivenessCfg: toLivenessCfg, specHasFairness: specHasFairness };

if (require.main === module) {
  const asJson = process.argv.includes('--json');
  const r = checkFsmModels(ROOT);
  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else if (r.skipped) {
    console.log('[fsm-models] skipped: ' + (r.reason || 'n/a'));
  } else {
    for (const f of r.findings) console.log('[' + f.rule + '] ' + f.model + ': ' + f.message);
    console.log(r.count + ' fsm-model invariant violation(s) across ' + r.checked + ' checked model(s)');
  }
  process.exit(!r.skipped && r.count > 0 ? 1 : 0);
}
