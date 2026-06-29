#!/usr/bin/env node
'use strict';
// bin/run-petri.test.cjs
// Tests for Petri net runner tool.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TOOL_PATH = path.join(__dirname, 'run-petri.cjs');

// Run run-petri.cjs in an isolated tmp dir
function runPetri(petriModels, env) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  const petriDir = path.join(formalDir, 'petri');
  fs.mkdirSync(petriDir, { recursive: true });

  // Write provided models
  if (petriModels && typeof petriModels === 'object') {
    for (const [name, content] of Object.entries(petriModels)) {
      fs.writeFileSync(path.join(petriDir, name), content, 'utf8');
    }
  }

  const ndjsonPath = path.join(formalDir, 'check-results.ndjson');
  const result = spawnSync(process.execPath, [TOOL_PATH, '--project-root=' + tmpDir], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ...env,
      CHECK_RESULTS_ROOT: tmpDir,
      PATH: process.env.PATH,
    },
  });

  return { tmpDir, result, petriDir, ndjsonPath };
}

// Test 1: syntax check
test('run-petri.cjs loads without syntax errors', () => {
  const result = spawnSync(process.execPath, ['--check', TOOL_PATH], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, 'node --check must exit 0: ' + (result.stderr || result.error));
});

// Test 2: graceful degradation — exit 0 when petri directory not found
test('run-petri.cjs exits 0 when petri directory missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  const result = spawnSync(process.execPath, [TOOL_PATH], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.strictEqual(result.status, 0, 'must exit 0 even when petri dir missing: ' + (result.stderr || result.error));
});

// Test 3: parses valid Petri net DOT files
test('run-petri.cjs validates well-formed Petri net DOT (simple)', () => {
  const validDot = `
digraph petri_simple {
  p0 [shape=circle];
  p1 [shape=circle];
  t0 [shape=rect];
  t1 [shape=rect];
  p0 -> t0;
  t0 -> p1;
  p1 -> t1;
  t1 -> p1;
}
  `;

  const { tmpDir, result, ndjsonPath } = runPetri({ 'test-simple.dot': validDot });

  // Parse output
  let ndjson = '';
  try {
    if (fs.existsSync(ndjsonPath)) {
      ndjson = fs.readFileSync(ndjsonPath, 'utf8');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.ok(ndjson.includes('petri:test-simple'), 'NDJSON must contain petri:test-simple check_id');
  assert.ok(
    ndjson.includes('"result":"pass"') || ndjson.includes('"result": "pass"'),
    'NDJSON must contain result=pass for valid model: ' + ndjson
  );
});

// Test 4: detects invalid Petri nets (no arcs/edges)
test('run-petri.cjs detects Petri nets missing edges', () => {
  const invalidDot = `
digraph petri_noarcs {
  p0 [shape=circle];
  p1 [shape=circle];
  t0 [shape=rect];
}
  `;

  const { tmpDir, result, ndjsonPath } = runPetri({ 'test-noarcs.dot': invalidDot });

  let ndjson = '';
  try {
    if (fs.existsSync(ndjsonPath)) {
      ndjson = fs.readFileSync(ndjsonPath, 'utf8');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(result.status, 0, 'must exit 0 even on validation failure');
  assert.ok(ndjson.includes('petri:test-noarcs'), 'NDJSON must contain check_id');
  assert.ok(
    ndjson.includes('"result":"fail"') || ndjson.includes('"result": "fail"'),
    'NDJSON must contain result=fail for invalid model (no edges): ' + ndjson
  );
});

// Test 5: detects invalid Petri nets (missing graph declaration)
test('run-petri.cjs detects invalid DOT syntax', () => {
  const invalidDot = `
  t0 [shape=rect];
  t1 [shape=rect];
  `;

  const { tmpDir, result, ndjsonPath } = runPetri({ 'test-invalid.dot': invalidDot });

  let ndjson = '';
  try {
    if (fs.existsSync(ndjsonPath)) {
      ndjson = fs.readFileSync(ndjsonPath, 'utf8');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.ok(ndjson.includes('petri:test-invalid'), 'NDJSON must contain check_id');
  assert.ok(
    ndjson.includes('"result":"fail"') || ndjson.includes('"result": "fail"'),
    'NDJSON must contain result=fail for invalid DOT: ' + ndjson
  );
});

// Test 6: processes multiple Petri models
test('run-petri.cjs processes multiple Petri models in directory', () => {
  const model1 = `
digraph p1 {
  p0 [shape=circle];
  t0 [shape=box];
  p0 -> t0;
}
  `;
  const model2 = `
digraph p2 {
  p0 [shape=circle];
  p1 [shape=circle];
  t0 [shape=box];
  p0 -> t0 -> p1;
}
  `;

  const { tmpDir, result, ndjsonPath } = runPetri({
    'model-one.dot': model1,
    'model-two.dot': model2,
  });

  let ndjson = '';
  try {
    if (fs.existsSync(ndjsonPath)) {
      ndjson = fs.readFileSync(ndjsonPath, 'utf8');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.ok(ndjson.includes('petri:model-one'), 'NDJSON must contain first model');
  assert.ok(ndjson.includes('petri:model-two'), 'NDJSON must contain second model');
  // Both should be valid
  const passes = (ndjson.match(/"result":"pass"/g) || []).length;
  assert.ok(passes >= 1, 'should have at least one passing model');
});

// Test 7: .planning/formal/petri/ directory exists with real models
test('.planning/formal/petri/ directory exists with real models', () => {
  const petriDir = path.join(__dirname, '..', '.planning', 'formal', 'petri');
  assert.ok(fs.existsSync(petriDir), 'petri directory must exist');
  const dotFiles = fs.readdirSync(petriDir).filter(f => f.endsWith('.dot'));
  assert.ok(dotFiles.length > 0, 'must have at least one .dot file');
});

// Test 8: run-formal-verify.cjs STEPS contains petri: entries
test('run-formal-verify.cjs STEPS contains petri: entries', () => {
  const rfvPath = path.join(__dirname, 'run-formal-verify.cjs');
  const src = fs.readFileSync(rfvPath, 'utf8');
  assert.ok(src.includes('petri:'), 'STEPS must include petri: entries');
});

// Test 9: petri path is a file, not a directory — must degrade gracefully (exit 0)
test('run-petri.cjs exits 0 when petri path is a file, not a directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'petri-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });
  // Create .planning/formal/petri as a FILE instead of a directory
  fs.writeFileSync(path.join(formalDir, 'petri'), 'not a directory', 'utf8');

  const result = spawnSync(process.execPath, [TOOL_PATH, '--project-root=' + tmpDir], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.strictEqual(
    result.status,
    0,
    'must exit 0 when petri path is a file, not crash: ' + (result.stderr || result.error)
  );
});

// Test 10: '->' inside a label attribute must not be counted as a real arc
test('run-petri.cjs does not count -> inside attribute labels as arcs', () => {
  const labelArcDot = `
digraph g {
  p0 [shape=circle,label="x->y"];
  t0 [shape=box];
}
`;

  const { tmpDir, result, ndjsonPath } = runPetri({ 'label-arc.dot': labelArcDot });

  let ndjson = '';
  try {
    if (fs.existsSync(ndjsonPath)) {
      ndjson = fs.readFileSync(ndjsonPath, 'utf8');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.ok(ndjson.includes('petri:label-arc'), 'NDJSON must contain check_id');
  assert.ok(
    ndjson.includes('"result":"fail"') || ndjson.includes('"result": "fail"'),
    'net with no real arcs must FAIL even when a label contains "->": ' + ndjson
  );
});

// Test 11: only the trailing .dot extension is stripped from the model name
test('run-petri.cjs strips only the trailing .dot from the model name', () => {
  const validDot = `
digraph g {
  p0 [shape=circle];
  t0 [shape=box];
  p0 -> t0;
}
`;

  const { tmpDir, result, ndjsonPath } = runPetri({ 'flow.dotcfg.dot': validDot });

  let ndjson = '';
  try {
    if (fs.existsSync(ndjsonPath)) {
      ndjson = fs.readFileSync(ndjsonPath, 'utf8');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(result.status, 0, 'must exit 0');
  assert.ok(
    ndjson.includes('petri:flow.dotcfg'),
    'check_id must strip only the trailing .dot: ' + ndjson
  );
  assert.ok(
    !ndjson.includes('petri:flowcfg.dot'),
    'must not mangle a middle .dot occurrence: ' + ndjson
  );
});
