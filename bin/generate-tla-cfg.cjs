#!/usr/bin/env node
'use strict';
// bin/generate-tla-cfg.cjs
// Generates TLA+ model configuration files from the XState machine.
//
// The XState machine (src/machines/nf-workflow.machine.ts) is the SOURCE OF TRUTH.
// MCsafety.cfg and MCliveness.cfg are generated artifacts — do not edit them by hand.
// To change MaxDeliberation, update the XState machine context default instead.
//
// Usage:
//   node bin/generate-tla-cfg.cjs        # writes MCsafety.cfg + MCliveness.cfg
//   node bin/generate-tla-cfg.cjs --dry  # print output without writing
//
// Why agent counts are hardcoded here (not derived from code):
//   SAFETY_AGENTS=5 and LIVENESS_AGENTS=3 are model-checking parameters, not
//   runtime constants. 5 matches the quorum slot count; 3 keeps the liveness
//   state space tractable (liveness + symmetry = incompatible in TLC).

const fs   = require('fs');
const path = require('path');

const ROOT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project-root='));
  if (arg) return path.resolve(arg.slice('--project-root='.length));
  return path.join(__dirname, '..');
})();
const DRY   = process.argv.includes('--dry');

// ── Model-checking parameters (stable, not derived from code) ─────────────────
const SAFETY_AGENTS   = 5;   // N for MCsafety — matches nForma quorum slot count
const LIVENESS_AGENTS = 3;   // N for MCliveness — smaller for tractable liveness

// ── Extract MaxDeliberation from the XState machine ───────────────────────────
const machineFile = path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts');
let machineStat = null;
try { machineStat = fs.statSync(machineFile); } catch (_e) { machineStat = null; }
if (!machineStat || !machineStat.isFile()) {
  process.stderr.write('[generate-tla-cfg] XState machine not found: ' + machineFile + '\n');
  process.exit(1);
}
const machineSrc = fs.readFileSync(machineFile, 'utf8');

const maxDelibMatch = machineSrc.match(/maxDeliberation:\s*(\d+)/);
if (!maxDelibMatch) {
  process.stderr.write(
    '[generate-tla-cfg] Could not find maxDeliberation in XState context defaults.\n' +
    '[generate-tla-cfg] Expected: maxDeliberation: <number>\n'
  );
  process.exit(1);
}
const maxDeliberation = parseInt(maxDelibMatch[1], 10);
process.stdout.write('[generate-tla-cfg] Extracted maxDeliberation=' + maxDeliberation + ' from XState machine\n');

// ── Generate agent declarations ───────────────────────────────────────────────
function agentDecls(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push('    a' + i + ' = a' + i);
  }
  return lines.join('\n');
}

function agentsSet(n) {
  const names = [];
  for (let i = 1; i <= n; i++) names.push('a' + i);
  return '{' + names.join(', ') + '}';
}

// ── Build MCsafety.cfg ────────────────────────────────────────────────────────
const safetyCfg = [
  '\\* .planning/formal/tla/MCsafety.cfg',
  '\\* GENERATED — do not edit by hand.',
  '\\* Source of truth: src/machines/nf-workflow.machine.ts',
  '\\* Regenerate: node bin/generate-tla-cfg.cjs',
  '\\*',
  '\\* TLC safety model: N=' + SAFETY_AGENTS + ' agents, symmetry reduction, no liveness check.',
  '\\* Run: node bin/run-tlc.cjs MCsafety  (requires Java >=17 and tla2tools.jar)',
  '\\* NOTE: SYMMETRY requires model values — agents declared as model values (a1=a1 etc.)',
  'SPECIFICATION Spec',
  'CONSTANTS',
  agentDecls(SAFETY_AGENTS),
  '    Agents = ' + agentsSet(SAFETY_AGENTS),
  '    MaxDeliberation = ' + maxDeliberation,
  'SYMMETRY AgentSymmetry',
  'INVARIANT TypeOK',
  'INVARIANT MinQuorumMet',
  'PROPERTY NoInvalidTransition',
  'CHECK_DEADLOCK FALSE',
  '',
].join('\n');

// ── Build MCliveness.cfg ──────────────────────────────────────────────────────
const livenessCfg = [
  '\\* .planning/formal/tla/MCliveness.cfg',
  '\\* GENERATED — do not edit by hand.',
  '\\* Source of truth: src/machines/nf-workflow.machine.ts',
  '\\* Regenerate: node bin/generate-tla-cfg.cjs',
  '\\*',
  '\\* TLC liveness model: N=' + LIVENESS_AGENTS + ' agents, NO symmetry (incompatible with liveness), PROPERTY only.',
  '\\* Use -workers 1 for liveness (defensive against older TLC multi-worker liveness bugs).',
  '\\* Run: node bin/run-tlc.cjs MCliveness  (requires Java >=17 and tla2tools.jar)',
  '\\* NOTE: Agents set to ' + LIVENESS_AGENTS + ' model values for tractable liveness checking.',
  'SPECIFICATION Spec',
  'CONSTANTS',
  agentDecls(LIVENESS_AGENTS),
  '    Agents = ' + agentsSet(LIVENESS_AGENTS),
  '    MaxDeliberation = ' + maxDeliberation,
  'PROPERTY EventualConsensus',
  'CHECK_DEADLOCK FALSE',
  '',
].join('\n');

// ── Write or print ────────────────────────────────────────────────────────────
const safetyPath   = path.join(ROOT, '.planning', 'formal', 'tla', 'MCsafety.cfg');
const livenessPath = path.join(ROOT, '.planning', 'formal', 'tla', 'MCliveness.cfg');

if (DRY) {
  process.stdout.write('\n--- MCsafety.cfg ---\n' + safetyCfg);
  process.stdout.write('\n--- MCliveness.cfg ---\n' + livenessCfg);
} else {
  fs.mkdirSync(path.dirname(safetyPath),   { recursive: true });
  fs.mkdirSync(path.dirname(livenessPath), { recursive: true });
  fs.writeFileSync(safetyPath,   safetyCfg,   'utf8');
  fs.writeFileSync(livenessPath, livenessCfg, 'utf8');
  process.stdout.write('[generate-tla-cfg] Written: .planning/formal/tla/MCsafety.cfg\n');
  process.stdout.write('[generate-tla-cfg] Written: .planning/formal/tla/MCliveness.cfg\n');
}

process.stdout.write('[generate-tla-cfg] MaxDeliberation=' + maxDeliberation +
  '  SafetyAgents=' + SAFETY_AGENTS + '  LivenessAgents=' + LIVENESS_AGENTS + '\n');
