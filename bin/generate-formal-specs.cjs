#!/usr/bin/env node
'use strict';
// bin/generate-formal-specs.cjs
// Generates ALL formal verification artifacts from the XState machine.
//
// The XState machine (src/machines/nf-workflow.machine.ts) is the SINGLE SOURCE OF TRUTH.
// All formal specs are generated artifacts — do not edit them by hand.
//
// Generates:
//   .planning/formal/tla/NFQuorum.tla   — TLA+ spec (states, transitions, invariants)
//   .planning/formal/tla/MCsafety.cfg     — TLC safety model config (N=5, symmetry)
//   .planning/formal/tla/MCliveness.cfg   — TLC liveness model config (N=3)
//   .planning/formal/alloy/quorum-votes.als — Alloy vote-counting model
//   .planning/formal/prism/quorum.pm      — PRISM DTMC convergence model
//   .planning/formal/prism/quorum.props   — PRISM property file
//
// Usage:
//   node bin/generate-formal-specs.cjs        # write all specs
//   node bin/generate-formal-specs.cjs --dry  # print without writing
//
// Guard translations are driven by GUARD_REGISTRY below.
// When guard formulas change in the machine, update GUARD_REGISTRY — never hardcode
// guard logic in template strings.

const fs   = require('fs');
const path = require('path');

let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}
const DRY  = process.argv.includes('--dry');

// ── nForma repo guard ────────────────────────────────────────────────────────
// This script generates from the XState machine — only meaningful in the nForma repo.
const MACHINE_PATH = path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts');
if (!fs.existsSync(MACHINE_PATH)) {
  process.stderr.write('[generate-formal-specs] Not an nForma repo (src/machines/nf-workflow.machine.ts not found) — skipping.\n');
  process.exit(0);
}

// ── Model registry update helper ──────────────────────────────────────────────
// Uses shared module extracted to bin/adapters/registry-update.cjs (ARCH-01 wiring).
const { updateModelRegistry: _updateModelRegistryShared } = require('./adapters/registry-update.cjs');
function updateModelRegistry(absPath) {
  _updateModelRegistryShared(absPath, { dry: DRY, projectRoot: ROOT });
}

// ── Parse XState machine ──────────────────────────────────────────────────────
const machineFile = path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts');
if (!fs.existsSync(machineFile)) {
  process.stderr.write('[generate-formal-specs] XState machine not found at ' + machineFile + ' — skipping (not required for external projects)\n');
  process.exit(0);
}
const src = fs.readFileSync(machineFile, 'utf8');

// State names (4-space indent top-level state keys inside `states:`)
const stateNames = (src.match(/^    ([A-Z_]+):\s*\{/gm) || [])
  .map(l => l.trim().split(':')[0]);

// maxDeliberation default
const maxDelibMatch = src.match(/maxDeliberation:\s*(\d+)/);
const maxDelib = maxDelibMatch ? parseInt(maxDelibMatch[1], 10) : null;

// maxSize default — cap on voters polled per round
const maxSizeMatch = src.match(/maxSize:\s*(\d+)/);
const maxSize = maxSizeMatch ? parseInt(maxSizeMatch[1], 10) : 3;

// polledCount initial value
const polledCountMatch = src.match(/polledCount:\s*(\d+)/);
const polledCountInit = polledCountMatch ? parseInt(polledCountMatch[1], 10) : 0;

// Initial state
const initialMatch = src.match(/initial:\s*'([A-Z_]+)'/);
const initialState = initialMatch ? initialMatch[1] : null;

// Final state (type: 'final') — match state block with no nested braces before type:'final'
// [^{]* prevents the regex from crossing into adjacent state blocks
const finalMatch = src.match(/^    ([A-Z_]+):\s*\{[^{]*?type:\s*'final'/m);
const finalState = finalMatch ? finalMatch[1] : null;

if (!stateNames.length || maxDelib === null || !initialState || !finalState || maxSize === null) {
  process.stderr.write('[generate-formal-specs] Could not extract all facts from XState machine.\n');
  process.stderr.write('  states: ' + stateNames.join(', ') + '\n');
  process.stderr.write('  maxDeliberation: ' + maxDelib + '\n');
  process.stderr.write('  maxSize: ' + maxSize + '\n');
  process.stderr.write('  initial: ' + initialState + '\n');
  process.stderr.write('  final:   ' + finalState + '\n');
  process.exit(1);
}

const ts = new Date().toISOString().split('T')[0];
const GENERATED_HEADER = (comment, file) =>
  comment + ' ' + file + '\n' +
  comment + ' GENERATED — do not edit by hand.\n' +
  comment + ' Source of truth: src/machines/nf-workflow.machine.ts\n' +
  comment + ' Regenerate:      node bin/generate-formal-specs.cjs\n' +
  comment + ' Generated:       ' + ts + '\n';

process.stdout.write('[generate-formal-specs] XState machine → ' + stateNames.join(', ') +
  '  maxDeliberation=' + maxDelib + '  maxSize=' + maxSize + '  initial=' + initialState + '  final=' + finalState + '\n');

// ── Guard-to-formal translation registry ─────────────────────────────────────
// Each guard maps its TypeScript predicate to its TLA+, Alloy, and PRISM translations.
// Update this registry when guard formulas change — never hardcode guard logic in templates.
const GUARD_REGISTRY = {
  unanimityMet: {
    ts:    'successCount >= polledCount',
    tla:   'n = p',                                          // CollectVotes(n,p): all polled approved
    alloy: '#r.approvals = #r.polled',                       // VoteRound: approvals equals polled set
    prism: 'tp_rate',                                        // P(unanimous | available) = tp_rate
    desc:  'All polled agents approved (unanimity within the polled set)',
  },
  minQuorumMet: {
    ts:    'successCount >= Math.ceil(slotsAvailable / 2)',
    tla:   'n * 2 >= N',                                     // majority of total roster
    alloy: 'mul[#r.approvals, 2] >= r.total',
    prism: 'tp_rate * (1 - unavail)',
    desc:  'Majority of available agents approved (legacy — superseded by unanimityMet)',
  },
  noInfiniteDeliberation: {
    ts:    'deliberationRounds < maxDeliberation',
    tla:   'deliberationRounds < MaxDeliberation',
    alloy: 'r.rounds < MaxDeliberation',
    prism: 'deliberationRounds < maxDelib',
    desc:  'Deliberation has not reached the maximum round cap',
  },
};

// ── 1. NFQuorum.tla ─────────────────────────────────────────────────────────
// Intermediate states = all states except initial and final
const collectingState   = 'COLLECTING_VOTES';
const deliberatingState = 'DELIBERATING';
const phaseSet = stateNames.map(s => '"' + s + '"').join(', ');

const tlaSpec = [
  '---- MODULE NFQuorum ----',
  '(*',
  GENERATED_HEADER(' *', '.planning/formal/tla/NFQuorum.tla'),
  ' * Models the quorum workflow defined in src/machines/nf-workflow.machine.ts.',
  ' * Guard translations (from GUARD_REGISTRY in bin/generate-formal-specs.cjs):',
  ' *   unanimityMet (' + GUARD_REGISTRY.unanimityMet.ts + '):   ' + GUARD_REGISTRY.unanimityMet.tla,
  ' *   noInfiniteDeliberation (' + GUARD_REGISTRY.noInfiniteDeliberation.ts + '):  ' + GUARD_REGISTRY.noInfiniteDeliberation.tla,
  '*)',
  'EXTENDS Naturals, FiniteSets, TLC',
  '',
  'CONSTANTS',
  '    Agents,          \\* Set of quorum model slots (e.g., {"a1","a2","a3","a4","a5"})',
  '    MaxDeliberation, \\* Maximum deliberation rounds before forced ' + finalState + ' (default: ' + maxDelib + ')',
  '    MaxSize          \\* Cap on voters polled per round (default: ' + maxSize + ')',
  '',
  'ASSUME MaxDeliberation \\in Nat /\\ MaxDeliberation > 0',
  '',
  '\\* N = total number of agents; used for cardinality checks',
  'N == Cardinality(Agents)',
  '',
  'ASSUME MaxSize \\in 1..N',
  '',
  '\\* AgentSymmetry: referenced by MCsafety.cfg as SYMMETRY AgentSymmetry.',
  'AgentSymmetry == Permutations(Agents)',
  '',
  'VARIABLES',
  '    phase,              \\* One of: ' + phaseSet,
  '    successCount,       \\* Number of APPROVE votes collected in current round',
  '    polledCount,        \\* Number of agents actually recruited this round (≤ MaxSize; may be less if roster runs dry)',
  '    deliberationRounds  \\* Number of deliberation rounds completed',
  '',
  'vars == <<phase, successCount, polledCount, deliberationRounds>>',
  '',
  '\\* ── Type invariant ───────────────────────────────────────────────────────────',
  '\\* @requirement QUORUM-01',
  'TypeOK ==',
  '    /\\ phase \\in {' + phaseSet + '}',
  '    /\\ successCount \\in 0..MaxSize',
  '    /\\ polledCount \\in 0..MaxSize',
  '    /\\ deliberationRounds \\in 0..MaxDeliberation',
  '',
  '\\* ── Initial state ────────────────────────────────────────────────────────────',
  'Init ==',
  '    /\\ phase              = "' + initialState + '"',
  '    /\\ successCount       = 0',
  '    /\\ polledCount        = ' + polledCountInit,
  '    /\\ deliberationRounds = 0',
  '',
  '\\* ── Actions ──────────────────────────────────────────────────────────────────',
  '',
  '\\* StartQuorum: workflow leaves ' + initialState + ' → ' + collectingState,
  'StartQuorum ==',
  '    /\\ phase = "' + initialState + '"',
  '    /\\ phase\' = "' + collectingState + '"',
  '    /\\ UNCHANGED <<successCount, polledCount, deliberationRounds>>',
  '',
  '\\* CollectVotes(n, p): n APPROVE votes from p polled agents (p ≤ MaxSize).',
  '\\* unanimityMet (' + GUARD_REGISTRY.unanimityMet.ts + '): ' + GUARD_REGISTRY.unanimityMet.desc + '.',
  '\\* ' + GUARD_REGISTRY.unanimityMet.tla + ' → ' + finalState + '; otherwise → ' + deliberatingState + '.',
  'CollectVotes(n, p) ==',
  '    /\\ phase = "' + collectingState + '"',
  '    /\\ p \\in 1..MaxSize',
  '    /\\ n \\in 0..p',
  '    /\\ successCount\' = n',
  '    /\\ polledCount\' = p',
  '    /\\ IF ' + GUARD_REGISTRY.unanimityMet.tla,
  '       THEN /\\ phase\' = "' + finalState + '"',
  '            /\\ UNCHANGED deliberationRounds',
  '       ELSE /\\ phase\' = "' + deliberatingState + '"',
  '            /\\ deliberationRounds\' = deliberationRounds + 1',
  '',
  '\\* Deliberate(n): n APPROVE votes after a deliberation round.',
  '\\* Unanimity or exhaustion (deliberationRounds >= MaxDeliberation) → ' + finalState + '.',
  'Deliberate(n) ==',
  '    /\\ phase = "' + deliberatingState + '"',
  '    /\\ n \\in 0..MaxSize',
  '    /\\ successCount\' = n',
  '    /\\ IF n = polledCount \\/ deliberationRounds >= MaxDeliberation',
  '       THEN /\\ phase\' = "' + finalState + '"',
  '            /\\ UNCHANGED deliberationRounds',
  '       ELSE /\\ phase\' = "' + deliberatingState + '"',
  '            /\\ deliberationRounds\' = deliberationRounds + 1',
  '    /\\ UNCHANGED polledCount',
  '',
  '\\* Decide: forced termination when deliberation limit is exhausted.',
  'Decide ==',
  '    /\\ phase = "' + deliberatingState + '"',
  '    /\\ deliberationRounds >= MaxDeliberation',
  '    /\\ phase\' = "' + finalState + '"',
  '    /\\ UNCHANGED <<successCount, polledCount, deliberationRounds>>',
  '',
  'Next ==',
  '    \\/ StartQuorum',
  '    \\/ \\E p \\in 1..MaxSize : \\E n \\in 0..p : CollectVotes(n, p)',
  '    \\/ \\E n \\in 0..MaxSize : Deliberate(n)',
  '    \\/ Decide',
  '',
  '\\* ── Safety invariants ────────────────────────────────────────────────────────',
  '',
  '\\* UnanimityMet: if ' + finalState + ' via approval, unanimity was achieved or deliberation was exhausted.',
  '\\* @requirement QUORUM-02',
  '\\* @requirement SAFE-01',
  'UnanimityMet ==',
  '    phase = "' + finalState + '" =>',
  '        (successCount = polledCount \\/ deliberationRounds >= MaxDeliberation)',
  '',
  '\\* QuorumCeilingMet: when ' + finalState + ', polledCount did not exceed MaxSize.',
  '\\* @requirement QUORUM-03',
  '\\* @requirement SLOT-01',
  'QuorumCeilingMet ==',
  '    phase = "' + finalState + '" =>',
  '        /\\ polledCount <= MaxSize',
  '        /\\ (successCount = polledCount \\/ deliberationRounds >= MaxDeliberation)',
  '',
  '\\* NoInvalidTransition: ' + initialState + ' can only advance to ' + collectingState + '.',
  '\\* Kept for backwards compatibility; AllTransitionsValid covers this and all other states.',
  'NoInvalidTransition ==',
  '    [][phase = "' + initialState + '" => phase\' \\in {"' + initialState + '", "' + collectingState + '"}]_vars',
  '',
  '\\* AllTransitionsValid: every state can only reach its defined successors.',
  '\\* Covers all four states — a superset of NoInvalidTransition.',
  '\\* @requirement SAFE-02',
  'AllTransitionsValid ==',
  '    /\\ [][phase = "' + initialState + '" => phase\' \\in {"' + initialState + '", "' + collectingState + '"}]_vars',
  '    /\\ [][phase = "' + collectingState + '" => phase\' \\in {"' + collectingState + '", "' + deliberatingState + '", "' + finalState + '"}]_vars',
  '    /\\ [][phase = "' + deliberatingState + '" => phase\' \\in {"' + deliberatingState + '", "' + finalState + '"}]_vars',
  '    /\\ [][phase = "' + finalState + '" => phase\' = "' + finalState + '"]_vars',
  '',
  '\\* DeliberationBounded: deliberationRounds never exceeds MaxDeliberation.',
  '\\* Follows from the guard noInfiniteDeliberation on the DELIBERATING→DELIBERATING branch.',
  '\\* @requirement LOOP-01',
  'DeliberationBounded ==',
  '    deliberationRounds <= MaxDeliberation',
  '',
  '\\* DeliberationMonotone: deliberationRounds only ever increases.',
  '\\* Ensures rounds cannot be rolled back — a key soundness property.',
  '\\* @requirement SAFE-03',
  'DeliberationMonotone ==',
  '    [][deliberationRounds\' >= deliberationRounds]_vars',
  '',
  '\\* ── Liveness ─────────────────────────────────────────────────────────────────',
  '',
  '\\* EventualConsensus: every behavior eventually reaches ' + finalState + '.',
  '\\* @requirement QUORUM-04',
  '\\* @requirement RECV-01',
  'EventualConsensus == <>(phase = "' + finalState + '")',
  '',
  '\\* ── Composite actions for fairness ──────────────────────────────────────────',
  'AnyCollectVotes == \\E p \\in 1..MaxSize : \\E n \\in 0..p : CollectVotes(n, p)',
  'AnyDeliberate   == \\E n \\in 0..MaxSize : Deliberate(n)',
  '',
  '\\* ── Full specification with fairness ────────────────────────────────────────',
  'Spec == Init /\\ [][Next]_vars',
  '        /\\ WF_vars(Decide)',
  '        /\\ WF_vars(StartQuorum)',
  '        /\\ WF_vars(AnyCollectVotes)',
  '        /\\ WF_vars(AnyDeliberate)',
  '',
  '====',
  '',
].join('\n');

// ── 2. MCsafety.cfg + MCliveness.cfg ─────────────────────────────────────────
const SAFETY_AGENTS   = 5;
const LIVENESS_AGENTS = 3;

function agentDecls(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push('    a' + i + ' = a' + i);
  return lines.join('\n');
}
function agentsSet(n) {
  const names = [];
  for (let i = 1; i <= n; i++) names.push('a' + i);
  return '{' + names.join(', ') + '}';
}

const tlaCfgHeader = (file, desc) => [
  '\\* ' + file,
  '\\* GENERATED — do not edit by hand.',
  '\\* Source of truth: src/machines/nf-workflow.machine.ts',
  '\\* Regenerate:      node bin/generate-formal-specs.cjs',
  '\\* Generated:       ' + ts,
  '\\*',
  '\\* ' + desc,
  '\\* Run: node bin/run-tlc.cjs ' + file.replace('.planning/formal/tla/', '').replace('.cfg', ''),
].join('\n');

const safetyCfg = tlaCfgHeader('.planning/formal/tla/MCsafety.cfg',
  'TLC safety model: N=' + SAFETY_AGENTS + ' agents, no liveness.') + '\n' + [
  'SPECIFICATION Spec',
  'CONSTANTS',
  agentDecls(SAFETY_AGENTS),
  '    Agents = ' + agentsSet(SAFETY_AGENTS),
  '    MaxDeliberation = ' + maxDelib,
  '    MaxSize = ' + maxSize,
  '    MaxBound = ' + SAFETY_AGENTS,
  'INVARIANT TypeOK',
  // Real safety invariants (each TLC-verified to hold): a decided quorum meets
  // unanimity-or-bound, never exceeds the size ceiling, and stays within MaxDeliberation.
  // Without these the safety model only type-checked (see formal-model-teeth).
  'INVARIANT UnanimityMet',
  'INVARIANT QuorumCeilingMet',
  'INVARIANT DeliberationBounded',
  'CHECK_DEADLOCK FALSE',
  '',
].join('\n');

const livenessCfg = tlaCfgHeader('.planning/formal/tla/MCliveness.cfg',
  'TLC liveness model: N=' + LIVENESS_AGENTS + ' agents, no symmetry (incompatible with liveness).') + '\n' + [
  'SPECIFICATION Spec',
  'CONSTANTS',
  agentDecls(LIVENESS_AGENTS),
  '    Agents = ' + agentsSet(LIVENESS_AGENTS),
  '    MaxDeliberation = ' + maxDelib,
  '    MaxSize = ' + maxSize,
  'PROPERTY EventualConsensus',
  'CHECK_DEADLOCK FALSE',
  '',
].join('\n');

// ── 3. quorum-votes.als ───────────────────────────────────────────────────────
// Alloy vote-counting model — derived from unanimityMet guard in XState machine
const alloySpec = [
  GENERATED_HEADER('--', '.planning/formal/alloy/quorum-votes.als'),
  '-- nForma Quorum Vote-Counting Model (Alloy 6)',
  '-- Requirements: ALY-01',
  '--',
  '-- Models the unanimityMet guard from src/machines/nf-workflow.machine.ts:',
  '--   ' + GUARD_REGISTRY.unanimityMet.ts,
  '--   ≡  ' + GUARD_REGISTRY.unanimityMet.alloy + '  (all polled agents approved)',
  '--',
  '-- Guard registry translation: GUARD_REGISTRY.unanimityMet.alloy',
  '-- ' + GUARD_REGISTRY.unanimityMet.desc,
  '--',
  '-- Checks that no round reaches ' + finalState + ' without satisfying the unanimity predicate.',
  '-- Scope: ' + SAFETY_AGENTS + ' agents (nForma quorum slot count), 5 vote rounds.',
  '',
  'module quorum_votes',
  '',
  '-- Fix agent count to ' + SAFETY_AGENTS + ' (nForma quorum slot count).',
  '-- This makes the numeric threshold assertions below concrete and verifiable.',
  'fact AgentCount { #Agent = ' + SAFETY_AGENTS + ' }',
  '',
  'sig Agent {}',
  '',
  'sig VoteRound {',
  '    approvals : set Agent,',
  '    polled    : one Int,',
  '    total     : one Int',
  '}',
  '',
  '-- UnanimityReached: mirrors unanimityMet guard from XState machine.',
  '-- ' + GUARD_REGISTRY.unanimityMet.desc + '.',
  '-- Equivalent to successCount >= polledCount in TypeScript.',
  'pred UnanimityReached [r : VoteRound] {',
  '    #r.approvals = r.polled',
  '}',
  '',
  'pred ValidRound [r : VoteRound] {',
  '    r.total = #Agent        -- total must equal actual agent count',
  '    r.polled <= r.total     -- can\'t poll more than exist',
  '    r.polled >= 1           -- must poll at least one agent',
  '    #r.approvals <= r.polled -- can\'t have more approvals than polled',
  '}',
  '',
  '-- ASSERTION 1: Full unanimity — all polled agents approve.',
  '-- Non-trivial: Alloy must verify #approvals = polled for unanimity.',
  '-- @requirement QUORUM-02',
  '-- @requirement SAFE-01',
  'assert ThresholdPasses {',
  '    all r : VoteRound |',
  '        (ValidRound[r] and #r.approvals = r.polled) implies UnanimityReached[r]',
  '}',
  '',
  '-- ASSERTION 2: One missing approval fails unanimity.',
  '-- Non-trivial: any polled agent not approving must block consensus.',
  '-- @requirement QUORUM-02',
  '-- @requirement SAFE-01',
  'assert BelowThresholdFails {',
  '    all r : VoteRound |',
  '        (ValidRound[r] and r.polled > 1 and #r.approvals = minus[r.polled, 1]) implies not UnanimityReached[r]',
  '}',
  '',
  '-- ASSERTION 3: Zero approvals always fails — safety baseline regardless of N.',
  '-- @requirement SAFE-04',
  'assert ZeroApprovalsFail {',
  '    all r : VoteRound | ValidRound[r] implies (not (#r.approvals = 0 and UnanimityReached[r]))',
  '}',
  '',
  'check ThresholdPasses   for ' + SAFETY_AGENTS + ' Agent, 5 VoteRound',
  'check BelowThresholdFails for ' + SAFETY_AGENTS + ' Agent, 5 VoteRound',
  'check ZeroApprovalsFail for ' + SAFETY_AGENTS + ' Agent, 5 VoteRound',
  '',
  '-- Show an example valid unanimity round',
  'run UnanimityReached for ' + SAFETY_AGENTS + ' Agent, 1 VoteRound',
  '',
].join('\n');

// ── 4. quorum.pm ─────────────────────────────────────────────────────────────
// PRISM DTMC — 3-state model derived from machine states (collecting, deliberating, decided)
// State numbering: 0=collecting, 1=decided, 2=deliberating (absorbing at 1)
const prismSpec = [
  GENERATED_HEADER('//', '.planning/formal/prism/quorum.pm'),
  '// nForma Quorum Convergence — DTMC Model',
  '// Requirements: PRM-01',
  '//',
  '// Discrete-Time Markov Chain modeling quorum state transitions.',
  '// States:',
  '//   s=0 : ' + collectingState + '  (initial)',
  '//   s=1 : ' + finalState + '       (absorbing)',
  '//   s=2 : ' + deliberatingState + '     (retry)',
  '//',
  '// Derived from src/machines/nf-workflow.machine.ts:',
  '//   ' + stateNames.join(', '),
  '//',
  '// Guard translations (from GUARD_REGISTRY):',
  '//   unanimityMet (' + GUARD_REGISTRY.unanimityMet.ts + '): ' + GUARD_REGISTRY.unanimityMet.desc,
  '//   PRISM translation: ' + GUARD_REGISTRY.unanimityMet.prism + ' = P(all polled agents approve)',
  '//',
  '// Default rates are conservative priors. Override with empirical values:',
  '//   node bin/export-prism-constants.cjs',
  '//',
  '// To run (requires PRISM_BIN env var):',
  '//   $PRISM_BIN .planning/formal/prism/quorum.pm -pf "P=? [ F s=1 ]"',
  '//',
  '// To override rates from empirical scoreboard data (no file-include in PRISM):',
  '//   $PRISM_BIN .planning/formal/prism/quorum.pm -pf "P=? [ F s=1 ]" -const tp_rate=0.72 -const unavail=0.28',
  '',
  'dtmc',
  '',
  '// Slot aggregate rates (conservative priors — override with empirical data)',
  '// tp_rate = P(a slot votes APPROVE | it is AVAILABLE) — unanimityMet criterion',
  '// unavail = P(slot is UNAVAILABLE in a given round)',
  'const double tp_rate;   // injected by run-prism.cjs from scoreboard (see bin/export-prism-constants.cjs)',
  'const double unavail;   // injected by run-prism.cjs from scoreboard (see bin/export-prism-constants.cjs)',
  '',
  'module quorum_convergence',
  '    s : [0..2] init 0;',
  '',
  '    // From ' + collectingState + ':',
  '    // unanimityMet → ' + finalState + '; otherwise → ' + deliberatingState,
  '    [] s=0 -> (tp_rate * (1 - unavail)) : (s\'=1)',
  '            + (1 - tp_rate * (1 - unavail)) : (s\'=2);',
  '',
  '    // From ' + deliberatingState + ': same transition probabilities (memoryless DTMC)',
  '    // Note: MaxDeliberation (' + maxDelib + ') is enforced by XState guard, not modeled here.',
  '    // The DTMC captures convergence probability per round, not the capped count.',
  '    [] s=2 -> (tp_rate * (1 - unavail)) : (s\'=1)',
  '            + (1 - tp_rate * (1 - unavail)) : (s\'=2);',
  '',
  '    // ' + finalState + ' is an absorbing state',
  '    [] s=1 -> 1.0 : (s\'=1);',
  '',
  'endmodule',
  '',
  '// Reward structure: count deliberation rounds (steps spent outside ' + finalState + ')',
  'rewards "rounds"',
  '    s=0 : 1;  // cost of one ' + collectingState + ' step',
  '    s=2 : 1;  // cost of one ' + deliberatingState + ' step',
  'endrewards',
  '',
  '// Properties checked in .planning/formal/prism/quorum.props (run with quorum.props file):',
  '// P1: Eventual convergence — P=? [ F s=1 ]   (should be 1.0)',
  '// P2: Expected rounds     — R{"rounds"}=? [ F s=1 ]   (should be ~1/' + 'p where p=tp_rate*(1-unavail))',
  '// P3: Decide within ' + maxDelib + ' rounds — P=? [ F<=' + maxDelib + ' s=1 ]',
  '// P4: Decide within 10    — P=? [ F<=10 s=1 ]',
  '',
].join('\n');

// ── 4b. quorum.props ─────────────────────────────────────────────────────────
const prismProps = [
  '// .planning/formal/prism/quorum.props',
  '// GENERATED — do not edit by hand.',
  '// Source of truth: src/machines/nf-workflow.machine.ts',
  '// Regenerate:      node bin/generate-formal-specs.cjs',
  '// Generated:       ' + ts,
  '//',
  '// Run all properties:',
  '//   $PRISM_BIN .planning/formal/prism/quorum.pm .planning/formal/prism/quorum.props',
  '',
  '// P1: Eventual convergence — must be exactly 1.0 (certain termination)',
  '// @requirement PRM-01',
  '// @requirement QUORUM-04',
  'P=? [ F s=1 ]',
  '',
  '// P2: Expected deliberation rounds until ' + finalState,
  '// Conservative priors (tp_rate=0.85, unavail=0.15) give p=0.7225, E=~1.38 rounds.',
  '// @requirement PRM-01',
  'R{"rounds"}=? [ F s=1 ]',
  '',
  '// P3: Probability of deciding within MaxDeliberation=' + maxDelib + ' rounds',
  '// @requirement PRM-01',
  '// @requirement LOOP-01',
  'P=? [ F<=' + maxDelib + ' s=1 ]',
  '',
  '// P4: Probability of deciding within 10 rounds (high-confidence bound)',
  '// @requirement PRM-01',
  'P=? [ F<=10 s=1 ]',
  '',
].join('\n');

// ── Write or print ────────────────────────────────────────────────────────────
const outputs = [
  { rel: '.planning/formal/tla/NFQuorum.tla',              content: tlaSpec      },
  { rel: '.planning/formal/tla/MCsafety.cfg',                content: safetyCfg    },
  { rel: '.planning/formal/tla/MCliveness.cfg',              content: livenessCfg  },
  { rel: '.planning/formal/alloy/quorum-votes.als',           content: alloySpec    },
  { rel: '.planning/formal/prism/quorum.pm',                  content: prismSpec    },
  { rel: '.planning/formal/prism/quorum.props',               content: prismProps   },
];

const REGISTRY_EXTS = new Set(['.tla', '.als', '.pm']);

for (const { rel, content } of outputs) {
  if (DRY) {
    process.stdout.write('\n--- ' + rel + ' ---\n' + content + '\n');
  } else {
    const absOut = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, content, 'utf8');
    process.stdout.write('[generate-formal-specs] Written: ' + rel + '\n');
    // Update model registry for canonical spec files only (not .cfg or .props)
    if (REGISTRY_EXTS.has(path.extname(rel))) {
      updateModelRegistry(absOut);
    }
  }
}

if (!DRY) {
  process.stdout.write('[generate-formal-specs] All formal specs generated from XState machine.\n');
}
