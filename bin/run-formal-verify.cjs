#!/usr/bin/env node
'use strict';
// bin/run-formal-verify.cjs
// Master runner: executes ALL formal verification tools and generates ALL formal artifacts.
//
// Coverage:
//   Generate   (2)  — xstate-to-tla.cjs (XState → TLA+, cfg)
//                     generate-formal-specs.cjs (XState → Alloy, PRISM)
//   Petri net  (2)  — generate-petri-net.cjs  + render account-manager DOT → SVG
//   TLA+       (10) — MCsafety, MCliveness, MCoscillation, MCconvergence,
//                     MCbreaker, MCdeliberation, MCprefilter, MCaccount-manager, MCMCPEnv,
//                     MCStopHook
//   Alloy      (8)  — quorum-votes, scoreboard-recompute, availability-parsing,
//                     transcript-scan, install-scope, taxonomy-safety, account-pool-structure,
//                     quorum-composition
//   PRISM      (3)  — quorum, oauth-rotation, mcp-availability
//   CI enforce (4)  — check-trace-redaction.cjs, check-trace-schema-drift.cjs, check-liveness-fairness.cjs,
//                     validate-traces.cjs
//   Triage     (1)  — generate-triage-bundle.cjs (diff-report.md + suspects.md)
//   Traceability (3) — generate-traceability-matrix.cjs (requirements <-> properties matrix)
//                      check-coverage-guard.cjs (coverage regression guard vs baseline)
//                      analyze-state-space.cjs (state-space risk classification per TLA+ model)
//   Gates     (3)  — compute-per-model-gates.cjs aggregate + gate A/B/C reporting aliases
//   Registry  (N)  — custom check commands from model-registry.json
//   ─────────────────────────────────────────────────────────────
//   Total:    36+ steps (dynamic — registry can add more)
//
// Usage:
//   node bin/run-formal-verify.cjs                    # all 28 steps
//   node bin/run-formal-verify.cjs --concurrent       # run tool groups in parallel (old behavior)
//   NF_FORMAL_CONCURRENT=1 node bin/run-formal-verify.cjs  # same via env var
//   node bin/run-formal-verify.cjs --only=generate    # source extraction only (2 steps)
//   node bin/run-formal-verify.cjs --only=tla         # TLA+ only  (10 steps)
//   node bin/run-formal-verify.cjs --only=alloy       # Alloy only (8 steps)
//   node bin/run-formal-verify.cjs --only=prism       # PRISM only (3 steps)
//   node bin/run-formal-verify.cjs --only=petri       # Petri only (2 steps)
//   node bin/run-formal-verify.cjs --only=ci          # CI enforcement only (4 steps)
//   node bin/run-formal-verify.cjs --scope=MCsafety,quorum-votes  # run only these models
//
// Behaviour:
//   - Runs steps sequentially; streams child output to stdout/stderr.
//   - Continues on failure; collects pass/fail for every step.
//   - Prints a summary table at the end.
//   - Exits 0 only when every step passes.
//
// Prerequisites: see individual runner scripts in bin/.

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const TAG = '[run-formal-verify]';
const HR  = '═'.repeat(64);
const SEP = '─'.repeat(64);

let ROOT = process.cwd();

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

// ── nForma repo detection ─────────────────────────────────────────────────────
// The XState machine file is the canonical marker for the nForma repo.
// Steps marked nformaOnly are skipped when running in external/target repos
// to prevent cross-repo contamination of nForma-internal formal models.
const isNformaRepo = fs.existsSync(path.join(ROOT, 'src', 'machines', 'nf-workflow.machine.ts'));

// ── Runner picker maps ─────────────────────────────────────────────────────────
// Maps known nForma model names to their specialized runners. Unknown models
// fall back to generic runners (run-tlc.cjs, run-alloy.cjs, run-prism.cjs).

const TLA_RUNNER_MAP = {
  'MCoscillation':     { script: 'run-oscillation-tlc.cjs',      args: (c) => [c] },
  'MCconvergence':     { script: 'run-oscillation-tlc.cjs',      args: (c) => [c] },
  'MCbreaker':         { script: 'run-breaker-tlc.cjs',          args: (c) => [c] },
  'MCdeliberation':    { script: 'run-protocol-tlc.cjs',         args: (c) => [c] },
  'MCprefilter':       { script: 'run-protocol-tlc.cjs',         args: (c) => [c] },
  'MCaccount-manager': { script: 'run-account-manager-tlc.cjs',  args: () => [] },
  'MCStopHook':        { script: 'run-stop-hook-tlc.cjs',        args: (c) => [c] },
};
function pickTLARunner(configName) {
  return TLA_RUNNER_MAP[configName] || { script: 'run-tlc.cjs', args: (c) => [c] };
}

const ALLOY_RUNNER_MAP = {
  'quorum-votes':           { script: 'run-alloy.cjs',                    args: [] },
  'scoreboard-recompute':   { script: 'run-audit-alloy.cjs',              args: ['--spec=scoreboard-recompute'] },
  'availability-parsing':   { script: 'run-audit-alloy.cjs',              args: ['--spec=availability-parsing'] },
  'transcript-scan':        { script: 'run-transcript-alloy.cjs',         args: ['--spec=transcript-scan'] },
  'install-scope':          { script: 'run-installer-alloy.cjs',          args: ['--spec=install-scope'] },
  'taxonomy-safety':        { script: 'run-installer-alloy.cjs',          args: ['--spec=taxonomy-safety'] },
  'account-pool-structure': { script: 'run-account-pool-alloy.cjs',       args: [] },
  'quorum-composition':     { script: 'run-quorum-composition-alloy.cjs', args: [] },
};
function pickAlloyRunner(specName) {
  return (ALLOY_RUNNER_MAP[specName] || { script: 'run-alloy.cjs', args: ['--spec=' + specName] }).script;
}
function pickAlloyArgs(specName) {
  return (ALLOY_RUNNER_MAP[specName] || { script: 'run-alloy.cjs', args: ['--spec=' + specName] }).args;
}

const PRISM_RUNNER_MAP = {
  'quorum':           { script: 'run-prism.cjs',                args: [] },
  'oauth-rotation':   { script: 'run-oauth-rotation-prism.cjs', args: [] },
  'mcp-availability': { script: 'run-prism.cjs',                args: ['--model=mcp-availability'] },
};
function pickPrismRunner(modelName) {
  return (PRISM_RUNNER_MAP[modelName] || { script: 'run-prism.cjs', args: ['--model=' + modelName] }).script;
}
function pickPrismArgs(modelName) {
  return (PRISM_RUNNER_MAP[modelName] || { script: 'run-prism.cjs', args: ['--model=' + modelName] }).args;
}

// ── Dynamic model discovery ───────────────────────────────────────────────────
// Scans ROOT/.planning/formal/{tla,alloy,prism,petri}/ and builds step entries.
// Also reads ROOT/.planning/formal/model-registry.json for:
//   - search_dirs: additional directories to scan for formal model files
//   - models[].check.command: custom shell commands producing type:shell steps
function discoverModels(root) {
  const discovered = [];
  const formalDir = path.join(root, '.planning', 'formal');

  // TLA+: scan for *.cfg files in .planning/formal/tla/
  const tlaDir = path.join(formalDir, 'tla');
  if (fs.existsSync(tlaDir)) {
    const cfgFiles = fs.readdirSync(tlaDir).filter(f => f.endsWith('.cfg'));
    for (const cfg of cfgFiles) {
      const configName = cfg.replace('.cfg', '');
      const runner = pickTLARunner(configName);
      discovered.push({
        tool: 'tla',
        id: 'tla:' + configName.toLowerCase(),
        label: 'TLA+ — ' + configName,
        type: 'node',
        script: runner.script,
        args: runner.args(configName),
      });
    }
  }

  // Alloy: scan for *.als files in .planning/formal/alloy/ (exclude subdirectories, JARs)
  const alloyDir = path.join(formalDir, 'alloy');
  if (fs.existsSync(alloyDir)) {
    const alsFiles = fs.readdirSync(alloyDir).filter(f => f.endsWith('.als'));
    for (const als of alsFiles) {
      const specName = als.replace('.als', '');
      discovered.push({
        tool: 'alloy',
        id: 'alloy:' + specName,
        label: 'Alloy ' + specName,
        type: 'node',
        script: pickAlloyRunner(specName),
        args: pickAlloyArgs(specName),
      });
    }
  }

  // PRISM: scan for *.pm files in .planning/formal/prism/
  const prismDir = path.join(formalDir, 'prism');
  if (fs.existsSync(prismDir)) {
    const pmFiles = fs.readdirSync(prismDir).filter(f => f.endsWith('.pm'));
    for (const pm of pmFiles) {
      const modelName = pm.replace('.pm', '');
      discovered.push({
        tool: 'prism',
        id: 'prism:' + modelName,
        label: 'PRISM ' + modelName,
        type: 'node',
        script: pickPrismRunner(modelName),
        args: pickPrismArgs(modelName),
      });
    }
  }

  // Petri: scan for *.dot files in .planning/formal/petri/
  const petriDir = path.join(formalDir, 'petri');
  if (fs.existsSync(petriDir)) {
    const dotFiles = fs.readdirSync(petriDir).filter(f => f.endsWith('.dot'));
    for (const dot of dotFiles) {
      const name = dot.replace('.dot', '');
      discovered.push({
        tool: 'petri',
        id: 'petri:' + name,
        label: 'Petri ' + name + ' — render DOT -> SVG',
        type: 'wasm-dot',
        dot: dot,
        svg: dot.replace('.dot', '.svg'),
      });
    }
  }

  // ── Registry-driven discovery ────────────────────────────────────────────
  // Read model-registry.json for search_dirs and check.command entries.
  // Fail-open: if missing or malformed, log warning and continue.
  let registry = null;
  const registryPath = path.join(root, '.planning', 'formal', 'model-registry.json');
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    registry = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(TAG + ' Warning: could not read model-registry.json: ' + err.message + '\n');
  }

  if (registry && Array.isArray(registry.search_dirs)) {
    for (const dir of registry.search_dirs) {
      if (typeof dir !== 'string') continue;
      const resolvedDir = path.resolve(root, dir);
      let files;
      try {
        const st = fs.statSync(resolvedDir);
        if (!st.isDirectory()) continue;
        files = fs.readdirSync(resolvedDir);
      } catch (_) {
        continue;
      }

      // TLA+: *.cfg
      for (const f of files.filter(f => f.endsWith('.cfg'))) {
        const configName = f.replace('.cfg', '');
        const runner = pickTLARunner(configName);
        const stepId = ('tla:' + path.join(dir, configName).replace(/\\/g, '/')).toLowerCase();
        discovered.push({
          tool: 'tla',
          id: stepId,
          label: 'TLA+ — ' + dir + '/' + configName,
          type: 'node',
          script: runner.script,
          args: runner.args(configName),
        });
      }

      // Alloy: *.als
      for (const f of files.filter(f => f.endsWith('.als'))) {
        const specName = f.replace('.als', '');
        const stepId = ('alloy:' + path.join(dir, specName).replace(/\\/g, '/')).toLowerCase();
        discovered.push({
          tool: 'alloy',
          id: stepId,
          label: 'Alloy ' + dir + '/' + specName,
          type: 'node',
          script: pickAlloyRunner(specName),
          args: pickAlloyArgs(specName),
        });
      }

      // PRISM: *.pm
      for (const f of files.filter(f => f.endsWith('.pm'))) {
        const modelName = f.replace('.pm', '');
        const stepId = ('prism:' + path.join(dir, modelName).replace(/\\/g, '/')).toLowerCase();
        discovered.push({
          tool: 'prism',
          id: stepId,
          label: 'PRISM ' + dir + '/' + modelName,
          type: 'node',
          script: pickPrismRunner(modelName),
          args: pickPrismArgs(modelName),
        });
      }

      // Petri: *.dot
      for (const f of files.filter(f => f.endsWith('.dot'))) {
        const name = f.replace('.dot', '');
        const stepId = ('petri:' + path.join(dir, name).replace(/\\/g, '/')).toLowerCase();
        discovered.push({
          tool: 'petri',
          id: stepId,
          label: 'Petri ' + dir + '/' + name + ' — render DOT -> SVG',
          type: 'wasm-dot',
          dot: f,
          svg: f.replace('.dot', '.svg'),
        });
      }

    }
  }

  // Registry check.command entries → type:shell steps
  // Normalize legacy formal-spec/ paths → .planning/formal/ (fixes #24)
  if (registry && registry.models && typeof registry.models === 'object') {
    for (const [modelPath, entry] of Object.entries(registry.models)) {
      if (entry && entry.check && typeof entry.check.command === 'string') {
        const normalizedCmd = entry.check.command.replace(
          /\bformal-spec\//g,
          '.planning/formal/specs/'
        );
        discovered.push({
          tool: 'registry',
          id: 'registry:' + modelPath,
          label: 'Registry check — ' + modelPath,
          type: 'shell',
          command: normalizedCmd,
          config: entry.check.config || null,
          cwd: root,
          nonCritical: entry.check.nonCritical || false,
        });
      }
    }
  }

  // Also normalize model keys that reference formal-spec/ (legacy paths)
  if (registry && registry.models && typeof registry.models === 'object') {
    for (const key of Object.keys(registry.models)) {
      if (key.startsWith('formal-spec/')) {
        const newKey = key.replace('formal-spec/', '.planning/formal/');
        if (!registry.models[newKey]) {
          registry.models[newKey] = registry.models[key];
        }
        delete registry.models[key];
      }
    }
  }

  return discovered;
}

// ── Step registry ─────────────────────────────────────────────────────────────
//
// type: 'node'     — run  node bin/<script> <args...>
// type: 'wasm-dot' — render .planning/formal/petri/<dot> → .planning/formal/petri/<svg>
//                    via @hpcc-js/wasm-graphviz (async)
//
// STATIC_STEPS: always run (generate, CI enforcement, triage, traceability).
// Dynamic steps are discovered from ROOT/.planning/formal/{tla,alloy,prism,petri}/.
const STATIC_STEPS = [
  // ─ Source extraction — must run first so generated specs are fresh ──────────
  {
    tool: 'generate', id: 'generate:tla-from-xstate',
    label: 'Generate TLA+ spec (NFQuorum_xstate.tla) + TLC model config from XState machine (xstate-to-tla)',
    type: 'node', script: 'xstate-to-tla.cjs',
    args: ['src/machines/nf-workflow.machine.ts', '--module=NFQuorum', '--config=.planning/formal/tla/guards/nf-workflow.json'],
    nformaOnly: true,
  },
  {
    tool: 'generate', id: 'generate:alloy-prism-specs',
    label: 'Generate Alloy + PRISM models from XState machine (generate-formal-specs)',
    type: 'node', script: 'generate-formal-specs.cjs', args: [],
    nformaOnly: true,
  },

  // ─ Petri net generator (produces DOT files — discovery handles rendering) ──
  {
    tool: 'petri', id: 'petri:quorum',
    label: 'Petri quorum — generate DOT + render SVG',
    type: 'node', script: 'generate-petri-net.cjs', args: [],
    nformaOnly: true,
  },
  {
    tool: 'petri', id: 'petri:verify',
    label: 'Petri net verification — structure validation + model analysis (run-petri)',
    type: 'node', script: 'run-petri.cjs', args: [],
    nonCritical: true,
  },

  // ─ CI enforcement — redaction + schema drift ──────────────────────────────
  {
    tool: 'ci', id: 'ci:trace-redaction',
    label: 'Trace redaction enforcement (check-trace-redaction.cjs)',
    type: 'node', script: 'check-trace-redaction.cjs', args: [],
    nformaOnly: true,
  },
  {
    tool: 'ci', id: 'ci:trace-schema-drift',
    label: 'Trace schema drift guard (check-trace-schema-drift.cjs)',
    type: 'node', script: 'check-trace-schema-drift.cjs', args: [],
    nformaOnly: true,
  },
  {
    tool: 'ci', id: 'ci:liveness-fairness-lint',
    label: 'Liveness-fairness lint — detect liveness properties without fairness declarations (LIVE-01, LIVE-02)',
    type: 'node', script: 'check-liveness-fairness.cjs', args: [],
  },
  {
    tool: 'ci', id: 'ci:conformance-traces',
    label: 'Conformance trace validation — XState machine replay with evidence confidence (EVID-01, EVID-02)',
    type: 'node', script: 'validate-traces.cjs', args: [],
    nformaOnly: true,
  },

  // ─ Triage bundle ─────────────────────────────────────────────────────────
  {
    tool: 'ci', id: 'ci:triage-bundle',
    label: 'Generate triage bundle — diff-report.md + suspects.md (generate-triage-bundle)',
    type: 'node', script: 'generate-triage-bundle.cjs', args: [],
    nonCritical: true,
  },

  // ─ Traceability matrix ─────────────────────────────────────────────────────
  {
    tool: 'traceability', id: 'traceability:matrix',
    label: 'Generate traceability matrix (requirements <-> formal properties)',
    type: 'node', script: 'generate-traceability-matrix.cjs', args: ['--quiet'],
    nonCritical: true,
  },
  {
    tool: 'traceability', id: 'traceability:coverage-guard',
    label: 'Check formal coverage regression against baseline',
    type: 'node', script: 'check-coverage-guard.cjs', args: ['--quiet'],
    nonCritical: true,
  },
  {
    tool: 'traceability', id: 'traceability:state-space',
    label: 'State-space analysis (risk classification per TLA+ model)',
    type: 'node', script: 'analyze-state-space.cjs', args: [],
    nonCritical: true,
  },

  // ─ Gates — cross-layer alignment checks ─────────────────────────────────────
  {
    tool: 'gates', id: 'gates:gate-a',
    label: 'Gate A — per-model grounding and maturity alignment',
    type: 'node', script: 'compute-per-model-gates.cjs', args: ['--aggregate', '--json'],
    nonCritical: true, timeoutMs: 30_000,
  },
  {
    tool: 'gates', id: 'gates:gate-b',
    label: 'Gate B — requirement/property linkage alignment',
    type: 'node', script: 'compute-per-model-gates.cjs', args: ['--aggregate', '--json'],
    nonCritical: true, timeoutMs: 30_000,
  },
  {
    tool: 'gates', id: 'gates:gate-c',
    label: 'Gate C — verification evidence and promotion alignment',
    type: 'node', script: 'compute-per-model-gates.cjs', args: ['--aggregate', '--json'],
    nonCritical: true, timeoutMs: 30_000,
  },
];

// Discover dynamic model steps from ROOT/.planning/formal/
const dynamicSteps = discoverModels(ROOT);

// Deduplicate: if a dynamic step has the same id as a static step, skip it
const staticIds = new Set(STATIC_STEPS.map(s => s.id));
const uniqueDynamicSteps = dynamicSteps.filter(s => !staticIds.has(s.id));

let STEPS = [...STATIC_STEPS, ...uniqueDynamicSteps];

// Filter out nForma-only steps when running in external repos
if (!isNformaRepo) {
  const before = STEPS.length;
  const skipped = STEPS.filter(s => s.nformaOnly);
  STEPS = STEPS.filter(s => !s.nformaOnly);
  if (skipped.length > 0) {
    process.stdout.write(TAG + ' Non-nForma repo detected — skipping ' + skipped.length + ' nForma-internal step(s)\n');
    for (const s of skipped) {
      process.stdout.write(TAG + '   skip: ' + s.id + ' (' + s.label + ')\n');
    }
  }
}

process.stdout.write(TAG + ' Static steps: ' + STATIC_STEPS.length + '\n');
process.stdout.write(TAG + ' Discovered models: ' + uniqueDynamicSteps.length + '\n');

// ── CLI filter ────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const onlyArg = argv.find(a => a.startsWith('--only='));
const only    = onlyArg ? onlyArg.split('=')[1] : null;
const scopeArg = argv.find(a => a.startsWith('--scope='));
const scopeList = scopeArg ? scopeArg.split('=')[1].split(',').map(s => s.trim().toLowerCase()) : null;
const concurrent = argv.includes('--concurrent') || process.env.NF_FORMAL_CONCURRENT === '1';

let steps = only
  ? STEPS.filter(s => s.tool === only || s.id === only)
  : [...STEPS];

if (only && steps.length === 0) {
  process.stderr.write(
    TAG + ' Unknown --only value: ' + only + '\n' +
    TAG + ' Valid values: tla, alloy, prism, petri, generate, ci, gates, registry, or a step id\n'
  );
  process.exit(1);
}

// --scope: filter to specific model names (applies after --only)
if (scopeList) {
  steps = steps.filter(s => {
    const modelName = s.id.includes(':') ? s.id.split(':').slice(1).join(':') : s.id;
    return scopeList.some(m =>
      modelName.toLowerCase() === m ||
      s.id.toLowerCase() === m
    );
  });
}

if (scopeList && steps.length === 0) {
  process.stderr.write(
    TAG + ' No models match --scope=' + scopeList.join(',') + '\n' +
    TAG + ' Available model IDs:\n'
  );
  for (const s of STEPS) {
    process.stderr.write(TAG + '   ' + s.id + '\n');
  }
  process.exit(1);
}

// ── Result tracker ────────────────────────────────────────────────────────────
const results = [];  // { id, label, passed, note }

function record(id, label, passed, note, nonCritical) {
  results.push({ id, label, passed, note: note || '', nonCritical: !!nonCritical });
}

// ── Step execution ────────────────────────────────────────────────────────────
function runNodeStep(step) {
  const scriptPath = path.join(__dirname, step.script);
  if (!fs.existsSync(scriptPath)) {
    process.stderr.write(TAG + ' Script not found: ' + scriptPath + '\n');
    return false;
  }
  // Auto-forward --project-root to child scripts
  const childArgs = [...step.args];
  if (!childArgs.some(a => a.startsWith('--project-root='))) {
    childArgs.push('--project-root=' + ROOT);
  }
  const stepTimeout = step.timeoutMs || 300_000; // 5 min default per step
  const result = spawnSync(process.execPath, [scriptPath, ...childArgs], {
    stdio: step.nonCritical ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, CHECK_RESULTS_ROOT: ROOT },
    timeout: stepTimeout,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  if (result.error) {
    const msg = result.signal === 'SIGTERM'
      ? 'Step timed out after ' + (stepTimeout / 1000) + 's'
      : result.error.message;
    process.stderr.write(TAG + ' Launch error: ' + msg + '\n');
    return false;
  }
  return result.status === 0;
}

function runShellStep(step) {
  // NOTE: command.split(/\s+/) is a known limitation — quoted arguments
  // with spaces (e.g., 'echo "hello world"') will be split incorrectly.
  // Future enhancement: accept command as an array format for complex args.
  const parts = step.command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  // Substitute {{config}} placeholder if config is set
  const resolvedArgs = step.config
    ? args.map(a => a.replace('{{config}}', step.config))
    : args;
  const result = spawnSync(cmd, resolvedArgs, {
    stdio: 'inherit',
    encoding: 'utf8',
    cwd: step.cwd || ROOT,
    env: { ...process.env, CHECK_RESULTS_ROOT: ROOT },
  });
  if (result.error) {
    process.stderr.write(TAG + ' Shell launch error: ' + result.error.message + '\n');
    return false;
  }
  return result.status === 0;
}

async function runWasmDotStep(step) {
  const petriDir = path.join(ROOT, '.planning', 'formal', 'petri');
  const dotPath  = path.join(petriDir, step.dot);
  const svgPath  = path.join(petriDir, step.svg);

  if (!fs.existsSync(dotPath)) {
    process.stderr.write(TAG + ' DOT source not found: ' + dotPath + '\n');
    return false;
  }

  const dotContent = fs.readFileSync(dotPath, 'utf8');

  let Graphviz;
  try {
    ({ Graphviz } = await import('@hpcc-js/wasm-graphviz'));
  } catch (_) {
    process.stderr.write(
      TAG + ' @hpcc-js/wasm-graphviz not installed.\n' +
      TAG + ' Run: npm install --save-dev @hpcc-js/wasm-graphviz\n'
    );
    return false;
  }

  try {
    const graphviz = await Graphviz.load();
    const svg      = graphviz.dot(dotContent);
    fs.writeFileSync(svgPath, svg);
    process.stdout.write(TAG + ' SVG written: ' + svgPath + '\n');
    return true;
  } catch (err) {
    process.stderr.write(TAG + ' SVG render failed: ' + err.message + '\n');
    return false;
  }
}

// ── Group runner — executes steps sequentially within a group ─────────────────
async function runGroup(groupSteps) {
  for (const step of groupSteps) {
    process.stdout.write(TAG + ' ' + SEP + '\n');
    process.stdout.write(TAG + ' [' + step.id + '] ' + step.label + '\n');
    process.stdout.write(TAG + ' ' + SEP + '\n');

    let passed = false;
    if (step.type === 'node') {
      passed = runNodeStep(step);
    } else if (step.type === 'wasm-dot') {
      passed = await runWasmDotStep(step);
    } else if (step.type === 'shell') {
      passed = runShellStep(step);
    }

    const mark = passed ? '✓' : '✗';
    process.stdout.write('\n' + TAG + ' ' + mark + ' ' + step.id + '\n\n');
    record(step.id, step.label, passed, undefined, step.nonCritical);
  }
}

// ── runOnce() — executes the full pipeline once ───────────────────────────────
// Returns the count of failed steps (0 = all passed).
// Does NOT call process.exit() — the caller decides (non-watch exits, watch loops).
async function runOnce() {
  // Reset results array so watch-mode re-runs start clean
  results.length = 0;
  // Truncate NDJSON file — fresh run (UNIF-02)
  const ndjsonPath = path.join(ROOT, '.planning', 'formal', 'check-results.ndjson');
  fs.mkdirSync(path.dirname(ndjsonPath), { recursive: true });
  fs.writeFileSync(ndjsonPath, '', 'utf8');

  process.stdout.write(TAG + ' ' + HR + '\n');
  process.stdout.write(TAG + ' nForma Formal Verification Suite\n');
  if (only) {
    process.stdout.write(TAG + ' Filter: --only=' + only + '\n');
  }
  if (scopeList) {
    process.stdout.write(TAG + ' Scope: --scope=' + scopeList.join(',') + '\n');
  }
  process.stdout.write(TAG + ' Steps: ' + steps.length + '\n');
  process.stdout.write(TAG + ' ' + HR + '\n\n');

  const startMs = Date.now();

  // ── Phase 1: Generate (sequential prerequisite) ────────────────────────────
  const generateSteps = steps.filter(s => s.tool === 'generate');
  const toolSteps     = steps.filter(s => s.tool !== 'generate' && s.tool !== 'traceability');
  const postSteps     = steps.filter(s => s.tool === 'traceability');

  if (generateSteps.length > 0) {
    process.stdout.write(TAG + ' Phase 1: Running generate steps sequentially...\n\n');
    await runGroup(generateSteps);
  }

  // ── Phase 2: Tool groups (sequential by default, --concurrent for parallel) ─
  if (toolSteps.length > 0) {
    const toolGroupNames = [...new Set(toolSteps.map(s => s.tool))];
    if (concurrent) {
      process.stdout.write(TAG + ' Phase 2: Running tool groups concurrently: ' + toolGroupNames.join(', ') + '\n\n');
      await Promise.all(
        toolGroupNames.map(tool => runGroup(toolSteps.filter(s => s.tool === tool)))
      );
    } else {
      process.stdout.write(TAG + ' Phase 2: Running tool groups sequentially: ' + toolGroupNames.join(', ') + '\n\n');
      for (const tool of toolGroupNames) {
        await runGroup(toolSteps.filter(s => s.tool === tool));
      }
    }
  }

  // ── Phase 3: Post-processing (needs fully populated check-results.ndjson) ──
  if (postSteps.length > 0) {
    process.stdout.write(TAG + ' Phase 3: Post-processing (traceability matrix)...\n\n');
    await runGroup(postSteps);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed && !r.nonCritical).length;

  process.stdout.write(TAG + ' ' + HR + '\n');
  process.stdout.write(TAG + ' SUMMARY — ' + passed + '/' + results.length + ' passed\n');
  process.stdout.write(TAG + ' ' + HR + '\n');

  for (const r of results) {
    const mark  = r.passed ? '✓' : '✗';
    const extra = r.note ? '  (' + r.note + ')' : '';
    process.stdout.write(TAG + '  ' + mark + '  ' + r.id.padEnd(30) + r.label + extra + '\n');
  }

  process.stdout.write(TAG + ' ' + HR + '\n');

  const elapsedMs  = Date.now() - startMs;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  process.stdout.write(TAG + ' Wall-clock: ' + elapsedSec + 's (' + elapsedMs + 'ms)\n');
  process.stdout.write(TAG + ' ' + HR + '\n');

  // NDJSON-based summary (UNIF-03)
  try {
    const ndjsonLines = fs.readFileSync(ndjsonPath, 'utf8')
      .split('\n').filter(l => l.trim().length > 0);
    const checkResults = ndjsonLines.map(l => JSON.parse(l));
    const ndjsonFailed = checkResults.filter(r => r.result === 'fail').length;
    const ndjsonPassed = checkResults.filter(r => r.result === 'pass').length;
    const ndjsonOther  = checkResults.length - ndjsonFailed - ndjsonPassed;
    process.stdout.write(
      TAG + ' check-results.ndjson: ' + ndjsonPassed + ' pass, ' +
      ndjsonFailed + ' fail' +
      (ndjsonOther > 0 ? ', ' + ndjsonOther + ' warn/inconclusive' : '') + '\n'
    );
  } catch (err) {
    process.stderr.write(TAG + ' Warning: could not read check-results.ndjson: ' + err.message + '\n');
  }

  return failed;
}

// ── Entry point ───────────────────────────────────────────────────────────────
const watchArg = argv.includes('--watch');

if (watchArg) {
  // ── Watch mode ─────────────────────────────────────────────────────────────
  // machineDir uses process.cwd() so tests can point the watcher at a tmpDir
  // by spawning with a custom cwd. __dirname-relative paths would always point
  // to the real repo's src/machines/ regardless of spawn cwd, breaking isolation.
  const machineDir  = path.join(process.cwd(), 'src', 'machines');
  const machineName = 'nf-workflow.machine.ts';
  let debounceTimer = null;
  let running       = false;  // concurrent-run guard
  let watcher       = null;

  process.stdout.write(TAG + ' ' + HR + '\n');
  process.stdout.write(TAG + ' Watch mode enabled\n');
  process.stdout.write(TAG + ' Watching: ' + path.join(machineDir, machineName) + '\n');
  process.stdout.write(TAG + ' Press Ctrl+C to stop.\n');
  process.stdout.write(TAG + ' Tip: use --only=generate for faster feedback, --concurrent for parallel tool groups.\n');
  process.stdout.write(TAG + ' ' + HR + '\n\n');

  // Existence check — fail fast if invoked from wrong directory
  if (!fs.existsSync(machineDir)) {
    process.stderr.write(TAG + ' Error: machine directory not found: ' + machineDir + '\n');
    process.stderr.write(TAG + ' Run --watch from the project root (where src/machines/ exists).\n');
    process.exit(1);
  }

  // Initial run
  runOnce().catch(err => process.stderr.write(TAG + ' Error: ' + err.message + '\n'));

  // Watch parent directory — NOT the file directly.
  // On macOS, watching a file dies after first rename (editor atomic-write pattern).
  watcher = fs.watch(machineDir, (eventType, filename) => {
    if (filename === machineName) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (running) return;
        running = true;
        process.stdout.write('\n' + TAG + ' ' + HR + '\n');
        process.stdout.write(TAG + ' Change detected — re-running verification\n');
        process.stdout.write(TAG + ' ' + new Date().toISOString() + '\n');
        process.stdout.write(TAG + ' ' + HR + '\n\n');
        runOnce()
          .catch(err => process.stderr.write(TAG + ' Error: ' + err.message + '\n'))
          .finally(() => { running = false; });
      }, 300);
    }
  });

  process.on('SIGINT', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) watcher.close();
    process.stdout.write('\n' + TAG + ' Exiting watch mode.\n');
    process.exit(0);
  });

} else {
  // ── Non-watch mode: original behavior ──────────────────────────────────────
  runOnce().then(failed => {
    if (failed > 0) {
      process.stderr.write(TAG + ' ' + failed + ' step(s) failed.\n');
      process.exit(1);
    }
    process.exit(0);
  });
}
