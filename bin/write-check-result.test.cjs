'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const MODULE_PATH = path.join(__dirname, 'write-check-result.cjs');

// ─── Test 1: module loads without error ────────────────────────────────────
test('module loads without error', () => {
  assert.doesNotThrow(() => {
    require(MODULE_PATH);
  });
});

// ─── Test 2: writeCheckResult throws on missing tool field ─────────────────
test('writeCheckResult throws on missing tool field', () => {
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({}),
    /tool is required/
  );
});

// ─── Test 3: throws on invalid formalism ───────────────────────────────────
test('writeCheckResult throws on invalid formalism', () => {
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({ tool: 'x', formalism: 'bad', result: 'pass' }),
    /formalism/
  );
});

// ─── Test 4: throws on invalid result ──────────────────────────────────────
test('writeCheckResult throws on invalid result', () => {
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({ tool: 'x', formalism: 'tla', result: 'bad' }),
    /result/
  );
});

// ─── Test 5: appends exactly one line to NDJSON file ─────────────────────
test('writeCheckResult appends one line to NDJSON file', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    // Re-require with env override pointing to tmpDir file
    const { writeCheckResult } = (() => {
      const origEnv = process.env.CHECK_RESULTS_PATH;
      process.env.CHECK_RESULTS_PATH = tmpFile;
      // Force fresh require by clearing cache
      delete require.cache[require.resolve(MODULE_PATH)];
      const mod = require(MODULE_PATH);
      process.env.CHECK_RESULTS_PATH = origEnv;
      return mod;
    })();

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 1234,
      summary: 'pass: MCsafety in 1234ms'
    });

    const content = fs.readFileSync(tmpFile, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    assert.strictEqual(lines.length, 1, 'Expected exactly 1 non-empty line');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 6: record has all required fields ────────────────────────────────
test('writeCheckResult record has all required fields', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-alloy', formalism: 'alloy', result: 'fail',
      check_id: 'alloy:quorum-consistency', surface: 'alloy',
      property: 'Consistency invariants', runtime_ms: 5000,
      summary: 'fail: consistency check failed', metadata: { spec: 'test' }
    });

    const line    = fs.readFileSync(tmpFile, 'utf8').trim();
    const record  = JSON.parse(line);

    assert.ok('tool'      in record, 'Missing field: tool');
    assert.ok('formalism' in record, 'Missing field: formalism');
    assert.ok('result'    in record, 'Missing field: result');
    assert.ok('timestamp' in record, 'Missing field: timestamp');
    assert.ok('metadata'  in record, 'Missing field: metadata');

    assert.strictEqual(record.tool,      'run-alloy');
    assert.strictEqual(record.formalism, 'alloy');
    assert.strictEqual(record.result,    'fail');
    assert.deepStrictEqual(record.metadata, { spec: 'test' });

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 7: NDJSON_PATH exported correctly ────────────────────────────────
test('NDJSON_PATH exported correctly', () => {
  // Clear env override so we get the default path
  const origEnv = process.env.CHECK_RESULTS_PATH;
  delete process.env.CHECK_RESULTS_PATH;
  delete require.cache[require.resolve(MODULE_PATH)];

  const { NDJSON_PATH } = require(MODULE_PATH);
  assert.strictEqual(typeof NDJSON_PATH, 'string');
  assert.ok(NDJSON_PATH.endsWith('check-results.ndjson'), 'NDJSON_PATH should end with check-results.ndjson');

  // Restore
  if (origEnv !== undefined) process.env.CHECK_RESULTS_PATH = origEnv;
  delete require.cache[require.resolve(MODULE_PATH)];
});

// ─── Test 8: writeCheckResult throws on missing check_id ──────────────────
test('writeCheckResult throws on missing check_id', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({ tool: 'run-tlc', formalism: 'tla', result: 'pass' }),
    /check_id/
  );
});

// ─── Test 9: writeCheckResult throws on missing surface ───────────────────
test('writeCheckResult throws on missing surface', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({ tool: 'run-tlc', formalism: 'tla', result: 'pass', check_id: 'tla:quorum-safety' }),
    /surface/
  );
});

// ─── Test 10: writeCheckResult throws on missing property ─────────────────
test('writeCheckResult throws on missing property', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({ tool: 'run-tlc', formalism: 'tla', result: 'pass', check_id: 'tla:quorum-safety', surface: 'tla' }),
    /property/
  );
});

// ─── Test 11: writeCheckResult throws on missing runtime_ms ───────────────
test('writeCheckResult throws on missing runtime_ms', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', summary: 'pass: MCsafety in 0ms'
    }),
    /runtime_ms/
  );
});

// ─── Test 12: writeCheckResult throws on missing summary ──────────────────
test('writeCheckResult throws on missing summary', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 1823
    }),
    /summary/
  );
});

// ─── Test 13: v2.1 record has all required fields at top level ─────────────
test('v2.1 record has all required fields at top level', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants — TypeInvariant, SafetyInvariant',
      runtime_ms: 1823, summary: 'pass: MCsafety verified in 1823ms',
      triage_tags: [], metadata: { config: 'MCsafety' }
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);

    assert.ok('check_id'    in record, 'Missing top-level field: check_id');
    assert.ok('surface'     in record, 'Missing top-level field: surface');
    assert.ok('property'    in record, 'Missing top-level field: property');
    assert.ok('runtime_ms'  in record, 'Missing top-level field: runtime_ms');
    assert.ok('summary'     in record, 'Missing top-level field: summary');
    assert.ok('triage_tags' in record, 'Missing top-level field: triage_tags');

    assert.strictEqual(record.runtime_ms, 1823, 'runtime_ms must be integer 1823 (not float)');
    assert.ok(Number.isInteger(record.runtime_ms), 'runtime_ms must be an integer');
    assert.deepStrictEqual(record.triage_tags, [], 'triage_tags must deep-equal []');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 14: v2.1 record without observation_window omits the field ───────
test('v2.1 record without observation_window omits the field', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 1823,
      summary: 'pass: MCsafety verified in 1823ms',
      triage_tags: [], metadata: { config: 'MCsafety' }
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);

    assert.strictEqual('observation_window' in record, false, 'observation_window must be absent when not provided');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 14b: result 'error' is accepted for infrastructure failures ─────
test('writeCheckResult accepts result error for infrastructure failures', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    assert.doesNotThrow(() => {
      writeCheckResult({
        tool: 'run-alloy', formalism: 'alloy', result: 'error',
        check_id: 'alloy:quorum-votes', surface: 'alloy',
        property: 'Vote counting correctness', runtime_ms: 0,
        summary: 'error: alloy:quorum-votes (JAR not found)'
      });
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);
    assert.strictEqual(record.result, 'error');
    assert.ok(record.summary.startsWith('error:'));

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 14c: VALID_RESULTS includes error ────────────────────────────────
test('VALID_RESULTS includes error', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { VALID_RESULTS } = require(MODULE_PATH);
  assert.ok(VALID_RESULTS.includes('error'),
    'VALID_RESULTS must include "error" for infrastructure failure classification');
});


// ─── Test 16: requirement_ids defaults to empty array when not provided ─────
test('requirement_ids defaults to empty array when not provided', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 100,
      summary: 'pass: test'
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);

    assert.ok(Array.isArray(record.requirement_ids) && record.requirement_ids.length === 0,
      'requirement_ids must default to empty array []');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 17: requirement_ids is emitted when provided ──────────────────────
test('requirement_ids is emitted when provided', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 100,
      summary: 'pass: test',
      requirement_ids: ['SCHEMA-01', 'SCHEMA-02']
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);

    assert.deepStrictEqual(record.requirement_ids, ['SCHEMA-01', 'SCHEMA-02'],
      'requirement_ids must equal the provided array');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 18: requirement_ids rejects non-string elements ───────────────────
test('requirement_ids rejects non-string elements', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 100,
      summary: 'pass: test',
      requirement_ids: ['SCHEMA-01', 42]
    }),
    /requirement_ids must contain only strings/
  );
});

// ─── Test 19: requirement_ids rejects non-array values ──────────────────────
test('requirement_ids rejects non-array values', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 100,
      summary: 'pass: test',
      requirement_ids: 'SCHEMA-01'
    }),
    /requirement_ids must be an array/
  );
});

// ─── Test 20: backward compatibility: existing valid entry without requirement_ids ─
test('backward compatibility: existing valid entry without requirement_ids', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    assert.doesNotThrow(() => {
      writeCheckResult({
        tool: 'run-tlc', formalism: 'tla', result: 'pass',
        check_id: 'tla:quorum-safety', surface: 'tla',
        property: 'Safety invariants', runtime_ms: 1823,
        summary: 'pass: MCsafety in 1823ms'
      });
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);
    assert.ok(typeof record === 'object' && record !== null, 'Output must be valid JSON object');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── Test 15: triage_tags defaults to empty array when not provided ─────────
test('triage_tags defaults to empty array when not provided', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 1823,
      summary: 'pass: MCsafety verified in 1823ms'
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);

    assert.ok(Array.isArray(record.triage_tags) && record.triage_tags.length === 0,
      'triage_tags must default to empty array []');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── writeCheckResult creates the parent directory when missing ────────────
test('writeCheckResult creates missing parent directory', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  // Parent dirs 'nested/deep' deliberately do NOT exist yet.
  const tmpFile = path.join(tmpDir, 'nested', 'deep', 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    assert.doesNotThrow(() => {
      writeCheckResult({
        tool: 'run-tlc', formalism: 'tla', result: 'pass',
        check_id: 'tla:quorum-safety', surface: 'tla',
        property: 'Safety invariants', runtime_ms: 100,
        summary: 'pass: test'
      });
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);
    assert.strictEqual(record.result, 'pass');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});

// ─── writeCheckResult rejects non-finite runtime_ms ────────────────────────
test('writeCheckResult rejects NaN runtime_ms', () => {
  delete require.cache[require.resolve(MODULE_PATH)];
  const { writeCheckResult } = require(MODULE_PATH);
  assert.throws(
    () => writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: NaN,
      summary: 'pass: test'
    }),
    /runtime_ms/
  );
});

// ─── metadata coerces to {} when not a plain object ────────────────────────
test('writeCheckResult normalizes non-object metadata to {}', () => {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wcr-test-'));
  const tmpFile = path.join(tmpDir, 'check-results.ndjson');
  try {
    const origEnv = process.env.CHECK_RESULTS_PATH;
    process.env.CHECK_RESULTS_PATH = tmpFile;
    delete require.cache[require.resolve(MODULE_PATH)];
    const { writeCheckResult } = require(MODULE_PATH);

    writeCheckResult({
      tool: 'run-tlc', formalism: 'tla', result: 'pass',
      check_id: 'tla:quorum-safety', surface: 'tla',
      property: 'Safety invariants', runtime_ms: 100,
      summary: 'pass: test', metadata: 'oops'
    });

    const line   = fs.readFileSync(tmpFile, 'utf8').trim();
    const record = JSON.parse(line);
    assert.deepStrictEqual(record.metadata, {},
      'non-object metadata must be normalized to an empty object');

    process.env.CHECK_RESULTS_PATH = origEnv;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});
