#!/usr/bin/env node
'use strict';
// bin/run-formal-verify.test.cjs
// Error-path, integration smoke, and watch-mode tests for bin/run-formal-verify.cjs.
// Error-path and smoke tests: no Java/TLC/Alloy/PRISM invocation.
// Watch-mode tests: spawn + SIGINT, --only=generate only (no Java needed).
// Requirements: INTG-01, INTG-02, DX-01

const { test }      = require('node:test');
const assert        = require('node:assert');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('node:fs');
const os   = require('os');

const RUN_FV = path.join(__dirname, 'run-formal-verify.cjs');

test('exits non-zero with descriptive error for unknown --only value', () => {
  const result = spawnSync(process.execPath, [RUN_FV, '--only=bogus-invalid'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr || result.stdout, /unknown|invalid|bogus|--only/i);
});

test('syntax smoke: script loads without SyntaxError', () => {
  // Use node --check to parse the file for syntax errors without executing it.
  const result = spawnSync(process.execPath, ['--check', RUN_FV], {
    encoding: 'utf8',
    timeout: 5000,
  });
  // --check exits 0 on valid syntax; stderr contains "SyntaxError" on failure.
  assert.doesNotMatch(result.stderr || '', /SyntaxError/);
  assert.strictEqual(result.status, 0);
});

test('integration smoke: --only=generate filter resolves step list without Java', () => {
  // --only=generate with no Java still passes the argument-parsing stage
  // and enters the step-execution loop. Verify the filter is accepted
  // (it does NOT exit 1 for "Unknown --only value").
  // The step will fail (no generate-formal-specs.cjs execution succeeds without tooling),
  // but the important check is: the unknown-option guard does NOT fire.
  const result = spawnSync(process.execPath, [RUN_FV, '--only=generate'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  // Should NOT match the "Unknown --only value" error path
  assert.doesNotMatch(result.stderr || '', /Unknown --only value/i);
  // Full integration requires Java — note for CI documentation.
  // (exit code may be non-zero when child scripts fail; we only verify the pipeline is callable)
});

test('timing (PERF-02): output includes Wall-clock line and runner completes within 120s', () => {
  // Verify wall-clock timing instrumentation is present and runner does not hang.
  // Uses --only=generate so only the 2 generate steps run (no Java/TLC/Alloy needed).
  const startMs = Date.now();
  const result = spawnSync(process.execPath, [RUN_FV, '--only=generate'], {
    encoding: 'utf8',
    timeout: 120000,  // 120s hard cap — runner must not hang
  });
  const elapsedMs = Date.now() - startMs;

  // Must not be killed by timeout signal
  assert.strictEqual(result.signal, null, 'runner must not be killed by timeout');
  assert.ok(elapsedMs < 120000, 'runner completed in ' + elapsedMs + 'ms (limit: 120000ms)');

  // Output must include the Wall-clock timing line added for PERF-02
  const output = (result.stdout || '') + (result.stderr || '');
  assert.match(output, /Wall-clock/i, 'output must include Wall-clock timing line');
});

test('parallelization smoke (PERF-01): all 8 TLA+ step IDs appear in output with --only=tla', () => {
  // Verify that parallelization does not silently drop steps.
  // With --only=tla, the 8 TLA+ step IDs must all appear in stdout.
  // Steps will fail (no Java) but must be ATTEMPTED — step IDs are printed at header before execution.
  // Dynamic discovery uses cfg filenames lowercased as IDs
  const TLA_STEP_IDS = [
    'tla:mcsafety',
    'tla:mcliveness',
    'tla:mcoscillation',
    'tla:mcconvergence',
    'tla:mcbreaker',
    'tla:mcdeliberation',
    'tla:mcprefilter',
    'tla:mcaccount-manager',
  ];

  const result = spawnSync(process.execPath, [RUN_FV, '--only=tla'], {
    encoding: 'utf8',
    timeout: 120000,
  });

  const output = (result.stdout || '') + (result.stderr || '');

  for (const stepId of TLA_STEP_IDS) {
    assert.ok(
      output.includes(stepId),
      'Expected step ID "' + stepId + '" to appear in output — step may have been silently dropped'
    );
  }
});

// ── Watch mode integration tests (DX-01) ─────────────────────────────────────
// Require --only=generate so no Java/TLC/Alloy/PRISM is needed.
// All tests spawn with cwd: tmpDir (machine file copied there) so the
// watcher uses tmpDir/src/machines/ and does not affect the real repo.

test('watch mode (DX-01): --watch flag starts process and does not exit immediately', { timeout: 30000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-watch-start-'));
  try {
    const machinesDir = path.join(tmpDir, 'src', 'machines');
    fs.mkdirSync(machinesDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'src', 'machines', 'nf-workflow.machine.ts'),
      path.join(machinesDir, 'nf-workflow.machine.ts')
    );

    const child = spawn(process.execPath, [RUN_FV, '--watch', '--only=generate'], {
      cwd:   tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });

    // Wait for watch startup message AND first SUMMARY (initial run complete).
    // Sending SIGINT while spawnSync is blocking inside runOnce() can produce
    // signal-based termination instead of our process.exit(0) handler.
    // Waiting for SUMMARY ensures the initial run finished and we are back
    // in the fs.watch event loop before we send SIGINT.
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('timeout waiting for watch startup + initial run: ' + output)), 20000
      );
      const check = setInterval(() => {
        if (output.includes('Watch mode enabled') && output.includes('SUMMARY')) {
          clearInterval(check); clearTimeout(deadline); resolve();
        }
      }, 100);
    });

    child.kill('SIGINT');
    const exitCode = await new Promise(resolve => child.on('close', code => resolve(code)));

    assert.ok(
      output.includes('Watch mode enabled') || output.includes('Watching:'),
      'must print watch startup message — got: ' + output.slice(0, 200)
    );
    assert.strictEqual(exitCode, 0, 'must exit 0 on SIGINT');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('watch mode (DX-01): re-runs verification when machine file changes', { timeout: 30000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-watch-change-'));
  try {
    const machinesDir = path.join(tmpDir, 'src', 'machines');
    fs.mkdirSync(machinesDir, { recursive: true });
    const machinePath = path.join(machinesDir, 'nf-workflow.machine.ts');
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'src', 'machines', 'nf-workflow.machine.ts'),
      machinePath
    );

    const child = spawn(process.execPath, [RUN_FV, '--watch', '--only=generate'], {
      cwd:   tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });

    // Wait for initial run to complete (SUMMARY appears when first run finishes)
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('timeout waiting for initial run: ' + output)), 20000
      );
      const check = setInterval(() => {
        if (output.includes('SUMMARY')) { clearInterval(check); clearTimeout(deadline); resolve(); }
      }, 100);
    });

    // Touch machine file to trigger change detection
    const before = output.length;
    fs.writeFileSync(machinePath, fs.readFileSync(machinePath, 'utf8') + '\n// watch-trigger-test');

    // Wait for 'Change detected' message
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('timeout waiting for change detection: ' + output.slice(before))), 10000
      );
      const check = setInterval(() => {
        if (output.length > before && output.includes('Change detected')) {
          clearInterval(check); clearTimeout(deadline); resolve();
        }
      }, 100);
    });

    child.kill('SIGINT');
    await new Promise(resolve => child.on('close', resolve));

    assert.match(output, /Change detected/i, 'must print "Change detected" after file write');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('watch mode (DX-01): exits cleanly on SIGINT with exit code 0', { timeout: 30000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-watch-sigint-'));
  try {
    const machinesDir = path.join(tmpDir, 'src', 'machines');
    fs.mkdirSync(machinesDir, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'src', 'machines', 'nf-workflow.machine.ts'),
      path.join(machinesDir, 'nf-workflow.machine.ts')
    );

    const child = spawn(process.execPath, [RUN_FV, '--watch', '--only=generate'], {
      cwd:   tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });

    // Wait for watch startup AND first SUMMARY (initial run complete).
    // Same timing rationale as the startup test: SIGINT sent after the initial
    // runOnce() finishes so we are back in the fs.watch event loop.
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('timeout waiting for watch startup + initial run: ' + output)), 20000
      );
      const check = setInterval(() => {
        if (output.includes('Watch mode enabled') && output.includes('SUMMARY')) {
          clearInterval(check); clearTimeout(deadline); resolve();
        }
      }, 100);
    });

    child.kill('SIGINT');
    const { code, signal } = await new Promise(resolve =>
      child.on('close', (code, signal) => resolve({ code, signal }))
    );

    assert.strictEqual(code, 0,
      'must exit with code 0 on SIGINT (got code: ' + code + ', signal: ' + signal + ')');
    assert.match(output, /Exiting watch mode/i,
      'must print "Exiting watch mode" on SIGINT — got: ' + output.slice(-200));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UNIF-03: --only=ci filter resolves ci:trace-redaction and ci:trace-schema-drift steps', () => {
  const result = spawnSync(process.execPath, [RUN_FV, '--only=ci'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  // Must NOT exit with "Unknown --only value" error (which happens when no STEPS match)
  assert.doesNotMatch(result.stderr || '', /Unknown --only value/i);
  const output = (result.stdout || '') + (result.stderr || '');
  assert.ok(
    output.includes('ci:trace-redaction'),
    'ci:trace-redaction must be in STEPS — UNIF-03 fix requires both CI enforcement steps inside orchestrator'
  );
  assert.ok(
    output.includes('ci:trace-schema-drift'),
    'ci:trace-schema-drift must be in STEPS — UNIF-03 fix requires both CI enforcement steps inside orchestrator'
  );
});

test('LIVE-02: STEPS includes ci:liveness-fairness-lint entry', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run-formal-verify.cjs'), 'utf8');
  // Verify the entry exists with correct tool='ci' and script='check-liveness-fairness.cjs'
  assert.match(src, /ci:liveness-fairness-lint/);
  assert.match(src, /check-liveness-fairness\.cjs/);
  assert.match(src, /tool:\s*['"]ci['"]/);
});

test('STEPS contains ci:conformance-traces entry', () => {
  // Guard: ensures the ci:conformance-traces STEPS entry is not accidentally removed (EVID-01, EVID-02)
  const src = fs.readFileSync(path.join(__dirname, 'run-formal-verify.cjs'), 'utf8');
  assert.ok(src.includes("id: 'ci:conformance-traces'"), "STEPS must include ci:conformance-traces");
  assert.ok(src.includes("validate-traces.cjs"), "STEPS ci:conformance-traces must reference validate-traces.cjs");
});

test('TRIAGE-02: STEPS includes ci:triage-bundle entry as final step', () => {
  // Guard: ensures the ci:triage-bundle STEPS entry is not accidentally removed (TRIAGE-02)
  // STEPS total is now 27 (was 26 before this step was added).
  const src = fs.readFileSync(path.join(__dirname, 'run-formal-verify.cjs'), 'utf8');
  assert.ok(
    src.includes('ci:triage-bundle'),
    'Expected ci:triage-bundle STEPS entry in run-formal-verify.cjs (TRIAGE-02)'
  );
  assert.ok(
    src.includes('generate-triage-bundle.cjs'),
    'ci:triage-bundle STEPS entry must reference generate-triage-bundle.cjs'
  );
  // Verify total STEPS count
  assert.ok(
    src.includes('Total:    36+ steps'),
    'Comment block must reflect updated total of 36+ steps (dynamic)'
  );
});

// ── Registry-driven discovery tests (SOLVE-05) ─────────────────────────────

test('registry search_dirs discovery: scan additional directories for models', { timeout: 30000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-searchdirs-'));
  try {
    // Create minimal .planning/formal/ so script does not error
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'tla'), { recursive: true });
    // Create search_dirs target with a cfg file
    const specsDir = path.join(tmpDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'MCTestModel.cfg'), 'SPECIFICATION Spec\n');
    // Create model-registry.json with search_dirs
    const registry = {
      version: '1.0',
      last_sync: '2026-01-01T00:00:00Z',
      search_dirs: ['specs/'],
      models: {},
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry, null, 2)
    );
    // Also need check-results.ndjson to exist
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson'), '');

    const result = spawnSync(process.execPath, [RUN_FV, '--project-root=' + tmpDir, '--only=tla'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    // Must find the prefixed step ID from search_dirs
    assert.ok(
      output.includes('tla:specs/'),
      'Expected tla:specs/ prefix in output for search_dirs model — got: ' + output.slice(0, 500)
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('registry check.command discovery: creates type:shell steps', { timeout: 30000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-checkcmd-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'tla'), { recursive: true });
    const registry = {
      version: '1.0',
      last_sync: '2026-01-01T00:00:00Z',
      search_dirs: [],
      models: {
        '.planning/formal/alloy/test-model.als': {
          version: 1,
          last_updated: '2026-01-01T00:00:00Z',
          update_source: 'manual',
          source_id: null,
          session_id: null,
          description: 'test',
          requirements: [],
          check: { command: 'echo hello' },
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify(registry, null, 2)
    );
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson'), '');

    const result = spawnSync(process.execPath, [RUN_FV, '--project-root=' + tmpDir, '--only=registry'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.ok(
      output.includes('registry:'),
      'Expected registry: step ID in output — got: ' + output.slice(0, 500)
    );
    // echo hello should succeed (exit 0)
    assert.strictEqual(result.status, 0, 'registry check.command "echo hello" should exit 0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('shell step type handled: source contains type === shell branch', () => {
  const src = fs.readFileSync(path.join(__dirname, 'run-formal-verify.cjs'), 'utf8');
  assert.ok(
    src.includes("type === 'shell'"),
    'run-formal-verify.cjs must contain type === \'shell\' dispatch branch'
  );
});

test('fail-open: missing registry does not crash', { timeout: 30000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-noreg-'));
  try {
    // Create .planning/formal/tla/ but NO model-registry.json
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'tla'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson'), '');

    const result = spawnSync(process.execPath, [RUN_FV, '--project-root=' + tmpDir, '--only=tla'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    // Should not crash — it may exit 0 (no tla steps to run) or show warning
    // The key is it should NOT throw an unhandled exception
    assert.ok(
      !output.includes('SyntaxError') && !output.includes('Unexpected token'),
      'Should not crash with SyntaxError when registry is missing'
    );
    // It should show a warning about missing registry
    assert.ok(
      output.includes('could not read model-registry.json') || output.includes('Warning'),
      'Should warn about missing registry — got: ' + output.slice(0, 500)
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Gates step group tests ────────────────────────────────────────────────────

test('STATIC_STEPS includes 3 entries with tool=gates', () => {
  // Re-read the module source to inspect STATIC_STEPS without executing
  const src = fs.readFileSync(RUN_FV, 'utf8');
  const gateEntries = src.match(/tool:\s*'gates'/g) || [];
  assert.strictEqual(gateEntries.length, 3, 'Should have exactly 3 gate entries in STATIC_STEPS');
});

test('gate step IDs are gates:gate-a, gates:gate-b, gates:gate-c', () => {
  const src = fs.readFileSync(RUN_FV, 'utf8');
  assert.ok(src.includes("id: 'gates:gate-a'"), 'Should have gates:gate-a');
  assert.ok(src.includes("id: 'gates:gate-b'"), 'Should have gates:gate-b');
  assert.ok(src.includes("id: 'gates:gate-c'"), 'Should have gates:gate-c');
});

test('gate steps are marked nonCritical', () => {
  const src = fs.readFileSync(RUN_FV, 'utf8');
  // Each gate entry must have nonCritical: true on the same block
  const gateABlock = src.match(/id:\s*'gates:gate-a'[\s\S]*?nonCritical:\s*true/);
  const gateBBlock = src.match(/id:\s*'gates:gate-b'[\s\S]*?nonCritical:\s*true/);
  const gateCBlock = src.match(/id:\s*'gates:gate-c'[\s\S]*?nonCritical:\s*true/);
  assert.ok(gateABlock, 'gates:gate-a should be nonCritical');
  assert.ok(gateBBlock, 'gates:gate-b should be nonCritical');
  assert.ok(gateCBlock, 'gates:gate-c should be nonCritical');
});

test('--only=gates filtering returns exactly 3 steps', () => {
  const result = spawnSync(process.execPath, [RUN_FV, '--only=gates'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  // Should NOT match the "Unknown --only value" error
  assert.doesNotMatch(output, /Unknown --only value/i,
    '--only=gates should be accepted as a valid filter');
  // The output should mention the 3 gate step IDs
  assert.ok(output.includes('gates:gate-a'), 'output should include gates:gate-a');
  assert.ok(output.includes('gates:gate-b'), 'output should include gates:gate-b');
  assert.ok(output.includes('gates:gate-c'), 'output should include gates:gate-c');
  // Verify Steps: 3 in output
  assert.ok(output.includes('Steps: 3'), 'Should report exactly 3 steps for --only=gates');
});

test('fail-open: non-string search_dirs element does not crash runner', { timeout: 30000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-badsearchdir-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'tla'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson'), '');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify({ version: '1.0', search_dirs: [123, null, {}], models: {} })
    );
    const result = spawnSync(process.execPath, [RUN_FV, '--project-root=' + tmpDir, '--only=tla'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.doesNotMatch(output, /ERR_INVALID_ARG_TYPE/, 'malformed search_dirs element must not crash the runner');
    assert.doesNotMatch(output, /TypeError/, 'must not throw an uncaught TypeError');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fail-open: search_dirs pointing at a file does not crash runner', { timeout: 30000 }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfv-filesearchdir-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'tla'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'formal', 'check-results.ndjson'), '');
    fs.writeFileSync(path.join(tmpDir, 'afile.txt'), 'not a directory');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'formal', 'model-registry.json'),
      JSON.stringify({ version: '1.0', search_dirs: ['afile.txt'], models: {} })
    );
    const result = spawnSync(process.execPath, [RUN_FV, '--project-root=' + tmpDir, '--only=tla'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    assert.doesNotMatch(output, /ENOTDIR/, 'a file in search_dirs must not crash the runner with ENOTDIR');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
