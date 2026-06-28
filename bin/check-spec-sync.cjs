#!/usr/bin/env node
'use strict';
// bin/check-spec-sync.cjs
// Verifies that formal specs stay in sync with the XState machine.
//
// The XState machine (src/machines/nf-workflow.machine.ts) is the SOURCE OF TRUTH.
// Formal specs must mirror it — not the other way around.
//
// Checks:
//   1. State names in NFQuorum.tla TypeOK match the XState machine states
//   2. MaxDeliberation in MCsafety.cfg and MCliveness.cfg matches the XState context default
//   3. Initial state in NFQuorum.tla Init matches the XState initial state
//   4. Alloy .als files do not reference state names or guard names not in XState machine
//   5. Guard names in XState machine match keys in .planning/formal/tla/guards/nf-workflow.json (bidirectional)
//
// Exit 0 = in sync; Exit 1 = drift detected.
// Usage: node bin/check-spec-sync.cjs [--tla-path=<path>] [--guards-path=<path>]
//
// CLI overrides (for fixture-based tests):
//   --tla-path=<abs-path>    Override path to NFQuorum.tla (default: .planning/formal/tla/NFQuorum.tla)
//   --guards-path=<abs-path> Override path to guards JSON (default: .planning/formal/tla/guards/nf-workflow.json)

const { buildSync } = require('esbuild');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}

// ── nForma repo guard ────────────────────────────────────────────────────────
// This script verifies XState ↔ formal spec sync — only meaningful in the nForma repo.
if (!fs.existsSync(path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts'))) {
  process.stdout.write('[check-spec-sync] Not an nForma repo — skipping.\n');
  process.exit(0);
}

// ── CLI overrides (for fixture-based drift injection tests) ───────────────────
// These allow tests to substitute temp fixture files without modifying the repo.
const tlaPathOverride   = process.argv.find(a => a.startsWith('--tla-path='));
const guardsPathOverride = process.argv.find(a => a.startsWith('--guards-path='));

// Resolved paths (absolute)
const TLA_ABS_PATH = tlaPathOverride
  ? tlaPathOverride.slice('--tla-path='.length)
  : path.join(ROOT, '.planning', 'formal', 'tla', 'NFQuorum.tla');

const GUARDS_ABS_PATH = guardsPathOverride
  ? guardsPathOverride.slice('--guards-path='.length)
  : path.join(ROOT, '.planning', 'formal', 'tla', 'guards', 'nf-workflow.json');

// ── Load files ───────────────────────────────────────────────────────────────
function load(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    process.stderr.write('[check-spec-sync] File not found: ' + rel + '\n');
    process.exit(1);
  }
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    process.stderr.write(
      '[check-spec-sync] Could not read file (not a regular readable file — e.g. a directory or unreadable): ' +
      rel + ' (' + (e && e.code ? e.code.toLowerCase() : 'read error') + ')\n'
    );
    process.exit(1);
  }
}

function loadAbs(abs) {
  if (!fs.existsSync(abs)) {
    process.stderr.write('[check-spec-sync] File not found: ' + abs + '\n');
    process.exit(1);
  }
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    process.stderr.write(
      '[check-spec-sync] Could not read file (not a regular readable file — e.g. a directory or unreadable): ' +
      abs + ' (' + (e && e.code ? e.code.toLowerCase() : 'read error') + ')\n'
    );
    process.exit(1);
  }
}

const tlaSrc      = loadAbs(TLA_ABS_PATH);
const safetyCfg   = load('.planning/formal/tla/MCsafety.cfg');
const livenessCfg = load('.planning/formal/tla/MCliveness.cfg');

// ── 1. Extract XState facts using esbuild+require() ────────────────────────────
// Compile the TypeScript machine to a temporary CJS bundle, then require() it.
// This gives us the live machine object — no regex parsing of raw source.

const MACHINE_FILE = path.join(ROOT, 'src/machines/nf-workflow.machine.ts');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-spec-sync-'));
const tmpBundle = path.join(tmpDir, 'machine.cjs');

let machineObj = null;
let xstateExtractError = null;

try {
  buildSync({
    entryPoints: [MACHINE_FILE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: tmpBundle,
    logLevel: 'silent',
  });
  const m = require(tmpBundle);
  // Find the exported machine — look for .config property (XState v5 machine)
  machineObj = Object.values(m).find(v => v && typeof v === 'object' && v.config);
} catch (err) {
  xstateExtractError = err.message;
}

// Extract structural facts from the machine object
let xstateStateNames = [];
let xstateGuardNames = [];
let xstateEventNames = [];
let xstateMaxDelib = null;
let xstateInitial = null;

if (machineObj && machineObj.config) {
  const cfg = machineObj.config;

  // State names (all top-level states)
  xstateStateNames = Object.keys(cfg.states || {});

  // Initial state
  xstateInitial = cfg.initial || null;

  // Guard names from implementations.guards
  const impls = machineObj.implementations || {};
  xstateGuardNames = Object.keys(impls.guards || {});

  // Event names from all transitions across all states
  const eventSet = new Set();
  for (const stateCfg of Object.values(cfg.states || {})) {
    for (const evtName of Object.keys(stateCfg.on || {})) {
      eventSet.add(evtName);
    }
  }
  xstateEventNames = [...eventSet];

  // maxDeliberation from context defaults
  const ctxDefaults = cfg.context || {};
  if (typeof ctxDefaults.maxDeliberation === 'number') {
    xstateMaxDelib = ctxDefaults.maxDeliberation;
  }
} else if (xstateExtractError) {
  // Fallback: use regex if esbuild fails (e.g., in environments without esbuild)
  process.stderr.write('[check-spec-sync] esbuild extraction failed: ' + xstateExtractError + '\n');
  process.stderr.write('[check-spec-sync] Falling back to regex extraction (limited)\n');
  const machineSrc = load('src/machines/nf-workflow.machine.ts');
  xstateStateNames = (machineSrc.match(/^    ([A-Z_]+):\s*\{/gm) || []).map(l => l.trim().split(':')[0]);
  const md = machineSrc.match(/maxDeliberation:\s*(\d+)/);
  xstateMaxDelib = md ? parseInt(md[1], 10) : null;
  const im = machineSrc.match(/initial:\s*'([A-Z_]+)'/);
  xstateInitial = im ? im[1] : null;
}

// ── 2. Extract TLA+ facts ────────────────────────────────────────────────────
// Phase values in TypeOK: phase \in {"IDLE", "COLLECTING_VOTES", ...}
const typeOkMatch = tlaSrc.match(/phase\s*\\in\s*\{([^}]+)\}/);
const tlaPhaseValues = typeOkMatch
  ? (typeOkMatch[1].match(/"([A-Z_]+)"/g) || []).map(s => s.replace(/"/g, ''))
  : [];

// Initial phase in Init block: find Init ==, then first phase = "..."
const initBlockMatch = tlaSrc.match(/Init\s*==[\s\S]*?phase\s*=\s*"([A-Z_]+)"/);
const tlaInitPhase = initBlockMatch ? initBlockMatch[1] : null;

// ── 3. Extract MaxDeliberation from cfg files ─────────────────────────────────
const safetyMaxDelibMatch   = safetyCfg.match(/MaxDeliberation\s*=\s*(\d+)/);
const livenessMaxDelibMatch  = livenessCfg.match(/MaxDeliberation\s*=\s*(\d+)/);
const safetyMaxDelib   = safetyMaxDelibMatch  ? parseInt(safetyMaxDelibMatch[1], 10)  : null;
const livenessMaxDelib = livenessMaxDelibMatch ? parseInt(livenessMaxDelibMatch[1], 10) : null;

// ── 4. Run checks ────────────────────────────────────────────────────────────
const errors = [];
const warnings = [];

function fail(msg) { errors.push('  FAIL  ' + msg); }
function warn(msg) { warnings.push('  WARN  ' + msg); }
function ok(msg)   { process.stdout.write('  OK    ' + msg + '\n'); }

process.stdout.write('\n[check-spec-sync] Source of truth: src/machines/nf-workflow.machine.ts\n\n');

// Check 1: State names
if (xstateStateNames.length === 0) {
  fail('Could not extract state names from XState machine');
} else {
  ok('XState states: ' + xstateStateNames.join(', '));

  if (tlaPhaseValues.length === 0) {
    fail('Could not parse phase values from NFQuorum.tla TypeOK');
  } else {
    ok('TLA+ phases:  ' + tlaPhaseValues.join(', '));

    const missing = xstateStateNames.filter(s => !tlaPhaseValues.includes(s));
    const extra   = tlaPhaseValues.filter(s => !xstateStateNames.includes(s));

    if (missing.length > 0) {
      fail('XState states missing from TLA+ TypeOK: ' + missing.join(', '));
    }
    if (extra.length > 0) {
      fail('TLA+ TypeOK has orphaned phases not in XState machine: ' + extra.join(', ') +
        '\n         (These TLA+ phases have no corresponding XState state — update NFQuorum.tla)');
    }
    if (missing.length === 0 && extra.length === 0) {
      ok('State names match exactly');
    }
  }
}

// Check 2: MaxDeliberation
if (xstateMaxDelib === null) {
  fail('Could not extract maxDeliberation from XState context defaults');
} else {
  ok('XState maxDeliberation: ' + xstateMaxDelib);

  if (safetyMaxDelib === null) {
    fail('Could not parse MaxDeliberation from MCsafety.cfg');
  } else if (safetyMaxDelib !== xstateMaxDelib) {
    fail(
      'MCsafety.cfg MaxDeliberation=' + safetyMaxDelib +
      ' does not match XState maxDeliberation=' + xstateMaxDelib
    );
  } else {
    ok('MCsafety.cfg MaxDeliberation=' + safetyMaxDelib + ' matches');
  }

  if (livenessMaxDelib === null) {
    fail('Could not parse MaxDeliberation from MCliveness.cfg');
  } else if (livenessMaxDelib !== xstateMaxDelib) {
    fail(
      'MCliveness.cfg MaxDeliberation=' + livenessMaxDelib +
      ' does not match XState maxDeliberation=' + xstateMaxDelib
    );
  } else {
    ok('MCliveness.cfg MaxDeliberation=' + livenessMaxDelib + ' matches');
  }
}

// Check 3: Initial state
if (xstateInitial === null) {
  fail('Could not extract initial state from XState machine');
} else {
  ok('XState initial state: ' + xstateInitial);

  if (tlaInitPhase === null) {
    fail('Could not parse Init phase from NFQuorum.tla');
  } else if (tlaInitPhase !== xstateInitial) {
    fail(
      'TLA+ Init sets phase="' + tlaInitPhase +
      '" but XState initial is "' + xstateInitial + '"'
    );
  } else {
    ok('Initial state matches: "' + xstateInitial + '"');
  }
}

// Check 4: Alloy orphan detection
// Scan Alloy .als files for:
//   (a) ALL_CAPS quoted string literals → cross-reference against xstateStateNames
//   (b) camelCase guard name occurrences (verbatim word-boundary matches) → advisory cross-reference
//
// Note: Alloy orphan detection uses warn() not fail() because Alloy models are intentional
// abstractions — they may use different predicate names (e.g., MajorityReached instead of
// minQuorumMet). The authoritative guard mapping check is in Check 5 (guards/nf-workflow.json).
const alloyDir = path.join(ROOT, '.planning', 'formal', 'alloy');
if (fs.existsSync(alloyDir)) {
  const alsFiles = fs.readdirSync(alloyDir).filter(f => f.endsWith('.als'));
  for (const alsFile of alsFiles) {
    const alsSrc = fs.readFileSync(path.join(alloyDir, alsFile), 'utf8');

    // (a) State orphan scan: quoted ALL_CAPS string literals
    const alloyStateRefs = (alsSrc.match(/"([A-Z_]{3,})"/g) || [])
      .map(s => s.replace(/"/g, ''));
    const orphanedStates = alloyStateRefs.filter(s => xstateStateNames.length > 0 && !xstateStateNames.includes(s));
    if (orphanedStates.length > 0) {
      warn('Alloy ' + alsFile + ' references states not in XState machine: ' + [...new Set(orphanedStates)].join(', '));
    }

    // (b) Guard name cross-reference: scan for verbatim camelCase XState guard names.
    // Reports which XState guard names appear by exact name in the Alloy source (informational).
    // Only flags Alloy files that reference XState guard names verbatim — PascalCase TLA+
    // predicates (MinQuorumMet, DeliberationBounded) are NOT XState guard names and are not checked here.
    if (xstateGuardNames.length > 0) {
      const referencedGuards = xstateGuardNames.filter(g => {
        const re = new RegExp('\\b' + g + '\\b');
        return re.test(alsSrc);
      });
      if (referencedGuards.length > 0) {
        ok('Alloy ' + alsFile + ' references XState guard names: ' + referencedGuards.join(', '));
      }
    }
  }
  ok('Alloy orphan scan complete');
}

// Check 5: Guard drift enforcement
// Verify each XState guard name is documented in the TLA+ guard mapping file, and vice versa.
//
// Mapping context:
//   XState uses camelCase guard names (minQuorumMet, noInfiniteDeliberation, phaseMonotonicallyAdvances).
//   TLA+ uses PascalCase predicates (MinQuorumMet, DeliberationBounded) — different names, same semantics.
//   The bridge is .planning/formal/tla/guards/nf-workflow.json, which maps XState guard names to TLA+ expressions.
//
//   If a guard is renamed in the XState machine, it must also be updated in guards/nf-workflow.json.
//   If a mapping entry is removed from guards/nf-workflow.json without removing the guard from
//   the machine (or vice versa), this check will detect the inconsistency.
//
// This check also corroborates by scanning NFQuorum.tla source text for camelCase guard name
// occurrences (they appear in the header comment block as documentation of guard translations).
if (xstateGuardNames.length > 0) {
  if (!fs.existsSync(GUARDS_ABS_PATH)) {
    fail('.planning/formal/tla/guards/nf-workflow.json not found — cannot verify guard name sync');
  } else {
    let guardsJson = null;
    let guardsParsed = false;
    try {
      guardsJson = JSON.parse(fs.readFileSync(GUARDS_ABS_PATH, 'utf8'));
      guardsParsed = true;
    } catch (e) {
      fail('Could not parse guards JSON at ' + GUARDS_ABS_PATH + ': ' + e.message);
    }
    if (guardsParsed && (guardsJson === null || typeof guardsJson !== 'object' || Array.isArray(guardsJson))) {
      fail('Guards JSON at ' + GUARDS_ABS_PATH + ' is not a JSON object (got ' +
        (guardsJson === null ? 'null' : Array.isArray(guardsJson) ? 'array' : typeof guardsJson) +
        ') — cannot verify guard name sync');
    }
    if (guardsJson && typeof guardsJson === 'object' && !Array.isArray(guardsJson)) {
      const mappedGuardNames = Object.keys(guardsJson.guards || {});
      ok('XState guard names:           ' + xstateGuardNames.join(', '));
      ok('Guards JSON mapped names:     ' + mappedGuardNames.join(', '));

      // Forward check: XState guard → guards JSON (drift detection)
      // If a guard is renamed in XState but guards/nf-workflow.json still has the old name, this fires.
      const missingFromMapping = xstateGuardNames.filter(g => !mappedGuardNames.includes(g));
      if (missingFromMapping.length > 0) {
        fail(
          'XState guards not found in guards/nf-workflow.json: ' + missingFromMapping.join(', ') +
          '\n         (Update .planning/formal/tla/guards/nf-workflow.json to map these guard names to their TLA+ predicates)'
        );
      }

      // Reverse check: guards JSON → XState (orphan detection)
      // If a guard mapping entry exists in guards/nf-workflow.json but the guard was removed from
      // the XState machine, this is an orphaned mapping.
      const orphanedGuards = mappedGuardNames.filter(g => !xstateGuardNames.includes(g));
      if (orphanedGuards.length > 0) {
        fail(
          'guards/nf-workflow.json references guards not in XState machine: ' + orphanedGuards.join(', ') +
          '\n         (These guard mappings are orphaned — remove them or restore the XState guard)'
        );
      }

      if (missingFromMapping.length === 0 && orphanedGuards.length === 0) {
        ok('Guard names match exactly between XState machine and guards/nf-workflow.json');
      }

      // Corroboration: check TLA+ source mentions guard names in comment references
      const tlaGuardRefs = xstateGuardNames.filter(g => tlaSrc.includes(g));
      if (tlaGuardRefs.length > 0) {
        ok('TLA+ source references guard names (comment docs): ' + tlaGuardRefs.join(', '));
      }
    }
  }
} else {
  warn('No guard names extracted from XState machine — skipping guard drift check');
}

// ── 5. Report ────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  process.stdout.write('\nWarnings:\n');
  warnings.forEach(w => process.stdout.write(w + '\n'));
}

if (errors.length > 0) {
  process.stdout.write('\nSpec drift detected:\n');
  errors.forEach(e => process.stderr.write(e + '\n'));
  process.stdout.write(
    '\nThe XState machine is the source of truth.\n' +
    'Update the formal specs to match the code, then re-run this check.\n\n'
  );
  process.exit(1);
}

process.stdout.write('\nAll checks passed — formal specs are in sync with the XState machine.\n\n');
