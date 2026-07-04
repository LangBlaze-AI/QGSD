#!/usr/bin/env node
'use strict';
// bin/formal-model-teeth.cjs — do nForma's formal models actually verify anything, or
// are they DECORATIVE? (The quorum's sharpest limit test, 2026-07-04: "inject a
// known-bad mutation; if the model doesn't detect it, it's decorative.")
//
// The mutation: a FROZEN-VARIABLE invariant. For each variable Init pins to a literal,
// synthesize  NF_Frozen == v1 = init1 /\ v2 = init2 /\ ...  and hand it to TLC as an
// INVARIANT. Any model with a real reachable transition MUST move at least one of those
// variables → NF_Frozen is violated → TLC catches it. So:
//   - VIOLATED  → LIVE: the state space is explored AND the invariant machinery works.
//   - HOLDS     → DEAD/decorative: the model never leaves its initial state — it
//                 "passes" model-checking vacuously and verifies nothing beyond Init.
//   - no literal-init var / TLC error / timeout → INDETERMINATE.
//
// This proves the verification *fires*; pair it with the trivial-invariant lint (which
// flags TRUE / x=x invariants) for the full "has teeth" picture. Read-only w.r.t. the
// repo — all mutation happens in a tmp dir.
//
// Usage: node bin/formal-model-teeth.cjs [--json] [--limit N] [--timeout-ms N]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const TLA_DIR = path.join(ROOT, '.planning', 'formal', 'tla');
const PER_MODEL_TIMEOUT_MS = 20000;

function resolveJar() {
  try { return require('./resolve-formal-tools.cjs').resolveTlaJar(ROOT); }
  catch (_) { return path.join(process.env.HOME || '', '.local', 'share', 'nf-formal', 'tla', 'tla2tools.jar'); }
}

function stripComments(s) { return s.replace(/\\\*.*$/gm, '').replace(/\(\*[\s\S]*?\*\)/g, ''); }

let CFG_TO_MODULE = {};
try { CFG_TO_MODULE = require('./analyze-state-space.cjs').CFG_TO_MODULE || {}; } catch (_) { /* optional */ }

// Resolve a cfg's spec .tla: static CFG_TO_MODULE map (legacy aliases like
// MCbreaker→NFCircuitBreaker) → header `.tla` ref → header `for <Name>` → MC-strip.
function resolveSpecForCfg(cfgPath, baseName) {
  const mapped = CFG_TO_MODULE[baseName];
  if (mapped && fs.existsSync(path.join(TLA_DIR, mapped + '.tla'))) return mapped + '.tla';
  try {
    const header = fs.readFileSync(cfgPath, 'utf8').split('\n').slice(0, 12).join('\n');
    const m = header.match(/\b([A-Z]\w+)\.tla\b/);
    if (m && fs.existsSync(path.join(TLA_DIR, m[1] + '.tla'))) return m[1] + '.tla';
    const f = header.match(/\bfor\s+([A-Z]\w+)/);
    if (f && fs.existsSync(path.join(TLA_DIR, f[1] + '.tla'))) return f[1] + '.tla';
  } catch (_) { /* fall through */ }
  const stripped = baseName.replace(/^MC/, '');
  if (stripped !== baseName && fs.existsSync(path.join(TLA_DIR, stripped + '.tla'))) return stripped + '.tla';
  if (fs.existsSync(path.join(TLA_DIR, baseName + '.tla'))) return baseName + '.tla';
  return null;
}

// Extract SPECIFICATION name + the raw CONSTANTS block lines from a cfg.
function cfgSpecAndConstants(cfgContent) {
  const lines = stripComments(cfgContent).split('\n');
  let spec = 'Spec', constants = [], inC = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sm = line.match(/^SPECIFICATION\s+(\w+)/i); if (sm) { spec = sm[1]; inC = false; continue; }
    if (/^CONSTANTS?\b/i.test(line)) { inC = true; const inl = line.replace(/^CONSTANTS?\s*/i, '').trim(); if (inl) constants.push(inl); continue; }
    if (/^(INVARIANTS?|PROPERT(Y|IES)|CHECK_DEADLOCK|SYMMETRY|CONSTRAINT|SPECIFICATION|INIT|NEXT)\b/i.test(line)) { inC = false; continue; }
    if (inC) constants.push(line);
  }
  return { spec, constants };
}

// Parse Init for `var = <literal>` conjuncts (numbers, "strings", TRUE/FALSE). Returns
// [{name, value}]. Non-literal inits (\in, functions, records) are skipped.
function literalInits(tlaContent) {
  const s = stripComments(tlaContent);
  const m = s.match(/\bInit\s*==\s*([\s\S]*?)(?=\n\s*\n|\n[A-Za-z]\w*\s*==)/);
  if (!m) return [];
  const out = [];
  const re = /\/\\\s*([A-Za-z]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|-?\d+|TRUE|FALSE)(?=\s|$)/gm;
  let x;
  while ((x = re.exec(m[1]))) out.push({ name: x[1], value: x[2] });
  return out;
}

// Count the model's OWN assertions beyond well-typedness: non-TypeOK INVARIANTs plus
// any temporal PROPERTY (liveness). A LIVE model whose only invariant is TypeOK and
// which checks no property explores states but verifies nothing meaningful.
function ownAssertedInvariants(cfgContent) {
  const names = [];
  for (const raw of stripComments(cfgContent).split('\n')) {
    const inv = raw.trim().match(/^INVARIANTS?\s+(.+)$/i);
    if (inv) for (const n of inv[1].split(/\s+/)) if (n && !/^Type(OK|Invariant|Inv)?$/i.test(n)) names.push(n);
    const prop = raw.trim().match(/^PROPERT(?:Y|IES)\s+(.+)$/i);
    if (prop) for (const n of prop[1].split(/\s+/)) if (n) names.push(n);
  }
  return names;
}

function testModel(jar, specFile, cfgPath) {
  const specContent = fs.readFileSync(path.join(TLA_DIR, specFile), 'utf8');
  const inits = literalInits(specContent);
  if (inits.length === 0) return { verdict: 'INDETERMINATE', reason: 'no literal-init variable to freeze' };
  const { spec, constants } = cfgSpecAndConstants(fs.readFileSync(cfgPath, 'utf8'));

  const frozen = 'NF_Frozen == ' + inits.map(i => i.name + ' = ' + i.value).join(' /\\ ');
  // Insert the mutant definition just before the module footer (====).
  const mutantTla = specContent.replace(/\n====+[\s\S]*$/, '\n' + frozen + '\n====\n');
  if (mutantTla === specContent) return { verdict: 'INDETERMINATE', reason: 'no module footer to splice' };

  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-teeth-'));
    fs.writeFileSync(path.join(tmp, specFile), mutantTla);
    const cfg = 'SPECIFICATION ' + spec + '\n'
      + (constants.length ? 'CONSTANTS\n' + constants.map(c => '    ' + c).join('\n') + '\n' : '')
      + 'INVARIANT NF_Frozen\nCHECK_DEADLOCK FALSE\n';
    fs.writeFileSync(path.join(tmp, 'teeth.cfg'), cfg);
    const r = spawnSync('java', ['-cp', jar, 'tlc2.TLC', '-workers', '1', '-config', 'teeth.cfg', specFile],
      { cwd: tmp, encoding: 'utf8', timeout: PER_MODEL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    if (/Invariant NF_Frozen is violated/.test(out)) {
      return { verdict: 'LIVE', reason: 'freeze caught — a reachable transition changes state, verification fires' };
    }
    if (r.error && r.error.code === 'ETIMEDOUT') return { verdict: 'INDETERMINATE', reason: 'TLC timed out (state space too large to settle)' };
    if (/(Error|Exception|cannot|not (a )?valid|Parsing|Semantic)/i.test(out) && !/Model checking completed/.test(out)) {
      return { verdict: 'INDETERMINATE', reason: 'TLC error (spec/cfg parse or constant gap)' };
    }
    // No violation, clean run → the frozen initial state is the ONLY reachable state.
    return { verdict: 'DEAD', reason: 'no reachable transition changes state — verifies nothing beyond Init' };
  } catch (e) {
    return { verdict: 'INDETERMINATE', reason: 'harness error: ' + e.message };
  } finally { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } }
}

function run(opts) {
  const jar = resolveJar();
  if (!jar || !fs.existsSync(jar)) return { skipped: true, reason: 'tla2tools.jar not found', results: [] };
  if (!fs.existsSync(TLA_DIR)) return { skipped: true, reason: 'no tla dir', results: [] };
  const cfgs = fs.readdirSync(TLA_DIR).filter(f => f.endsWith('.cfg')).sort();
  const results = [];
  const start = Date.now();
  for (const cfgFile of cfgs) {
    if (opts.limit && results.length >= opts.limit) break;
    if (Date.now() - start > (opts.totalMs || 600000)) break;
    const baseName = cfgFile.replace('.cfg', '');
    const specFile = resolveSpecForCfg(path.join(TLA_DIR, cfgFile), baseName);
    if (!specFile) { results.push({ cfg: baseName, verdict: 'INDETERMINATE', reason: 'spec not resolved' }); continue; }
    const t = testModel(jar, specFile, path.join(TLA_DIR, cfgFile));
    let asserted = [];
    try { asserted = ownAssertedInvariants(fs.readFileSync(path.join(TLA_DIR, cfgFile), 'utf8')); } catch (_) {}
    results.push({ cfg: baseName, spec: specFile, verdict: t.verdict, reason: t.reason, asserted_invariants: asserted.length });
  }
  return { skipped: false, results };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { json: argv.includes('--json'), limit: 0, totalMs: 600000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) opts.limit = parseInt(argv[++i], 10);
    if (argv[i] === '--timeout-ms' && argv[i + 1]) opts.totalMs = parseInt(argv[++i], 10);
  }
  const r = run(opts);
  if (r.skipped) { process.stdout.write('formal-model-teeth: SKIP — ' + r.reason + '\n'); process.exit(0); }
  if (opts.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(0); }
  const by = { LIVE: [], DEAD: [], INDETERMINATE: [] };
  for (const x of r.results) (by[x.verdict] || (by[x.verdict] = [])).push(x);
  process.stdout.write('Formal-model teeth test — freeze-mutation over ' + r.results.length + ' models:\n\n');
  for (const x of r.results) {
    const mark = x.verdict === 'LIVE' ? '✓ LIVE' : x.verdict === 'DEAD' ? '✗ DEAD' : '· INDET';
    const inv = x.verdict === 'LIVE' ? '  [' + x.asserted_invariants + ' asserted inv]' : '';
    process.stdout.write('  ' + mark.padEnd(9) + x.cfg.padEnd(26) + x.reason + inv + '\n');
  }
  const liveTypeOnly = by.LIVE.filter(x => x.asserted_invariants === 0);
  process.stdout.write('\nLIVE ' + by.LIVE.length + '  |  DEAD/decorative ' + by.DEAD.length + '  |  indeterminate ' + by.INDETERMINATE.length + '\n');
  process.stdout.write('of the LIVE: ' + (by.LIVE.length - liveTypeOnly.length) + ' assert a real property; ' + liveTypeOnly.length + ' type-check only (explore states but verify no property beyond TypeOK)\n');
  if (by.DEAD.length) process.stdout.write('DECORATIVE (verify nothing beyond Init): ' + by.DEAD.map(x => x.cfg).join(', ') + '\n');
  if (liveTypeOnly.length) process.stdout.write('TYPE-CHECK-ONLY (add a real invariant): ' + liveTypeOnly.map(x => x.cfg).join(', ') + '\n');
}

module.exports = { run: run, literalInits: literalInits, cfgSpecAndConstants: cfgSpecAndConstants, ownAssertedInvariants: ownAssertedInvariants };
