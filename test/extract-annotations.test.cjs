'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'bin', 'extract-annotations.cjs');
const annotations = require('../bin/extract-annotations.cjs');

/**
 * Run extract-annotations.cjs with given args and return { stdout, stderr, status }.
 */
function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 30000
  });
}

// ── TLA+ Annotation Parsing ─────────────────────────────────────────────────

describe('TLA+ annotation parsing', () => {
  test('single @requirement before a property', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const breaker = data['.planning/formal/tla/NFCircuitBreaker.tla'];
    assert.ok(breaker, 'NFCircuitBreaker.tla should be in output');

    const typeOK = breaker.find(p => p.property === 'TypeOK');
    assert.ok(typeOK, 'TypeOK should be found');
    assert.deepStrictEqual(typeOK.requirement_ids, ['DETECT-01']);
  });

  test('multiple @requirement lines before a single property', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const stopHook = data['.planning/formal/tla/NFStopHook.tla'];
    assert.ok(stopHook, 'NFStopHook.tla should be in output');

    const safety1 = stopHook.find(p => p.property === 'SafetyInvariant1');
    assert.ok(safety1, 'SafetyInvariant1 should be found');
    assert.deepStrictEqual(safety1.requirement_ids, ['STOP-02', 'SPEC-01']);
  });

  test('TypeOK property detection', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);

    // Every TLA+ file should have TypeOK (or TypeInvariantHolds for MCPEnv)
    const quorum = data['.planning/formal/tla/QGSDQuorum.tla'];
    assert.ok(quorum, 'QGSDQuorum.tla should be in output');
    const typeOK = quorum.find(p => p.property === 'TypeOK');
    assert.ok(typeOK, 'TypeOK should be found in QGSDQuorum.tla');
    assert.deepStrictEqual(typeOK.requirement_ids, ['QUORUM-01']);
  });

  test('property with existing (* ... *) comment block above it', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const stopHook = data['.planning/formal/tla/NFStopHook.tla'];

    // SafetyInvariant2 has a (* ... *) comment block above it
    const safety2 = stopHook.find(p => p.property === 'SafetyInvariant2');
    assert.ok(safety2, 'SafetyInvariant2 should be found');
    assert.deepStrictEqual(safety2.requirement_ids, ['STOP-03']);
  });

  test('NFStopHook.tla returns 7 properties', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const stopHook = data['.planning/formal/tla/NFStopHook.tla'];
    assert.ok(stopHook, 'NFStopHook.tla should be in output');
    assert.strictEqual(stopHook.length, 7, 'Should have 7 properties');
  });
});

// ── Alloy Annotation Parsing ────────────────────────────────────────────────

describe('Alloy annotation parsing', () => {
  test('single @requirement before an assert', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const install = data['.planning/formal/alloy/install-scope.als'];
    assert.ok(install, 'install-scope.als should be in output');

    const noConflict = install.find(p => p.property === 'NoConflict');
    assert.ok(noConflict, 'NoConflict should be found');
    assert.deepStrictEqual(noConflict.requirement_ids, ['INST-01']);
  });

  test('multiple @requirement lines before an assert', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const votes = data['.planning/formal/alloy/quorum-votes.als'];
    assert.ok(votes, 'quorum-votes.als should be in output');

    const threshold = votes.find(p => p.property === 'ThresholdPasses');
    assert.ok(threshold, 'ThresholdPasses should be found');
    assert.deepStrictEqual(threshold.requirement_ids, ['QUORUM-02', 'SAFE-01']);
  });

  test('install-scope.als returns 5 assertions', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const install = data['.planning/formal/alloy/install-scope.als'];
    assert.ok(install, 'install-scope.als should be in output');
    assert.strictEqual(install.length, 5, 'Should have 5 assertions');
  });
});

// ── PRISM Annotation Parsing ────────────────────────────────────────────────

describe('PRISM annotation parsing', () => {
  test('P=? property detection', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const quorum = data['.planning/formal/prism/quorum.props'];
    assert.ok(quorum, 'quorum.props should be in output');

    const p1 = quorum.find(p => p.property.startsWith('P=? [ F s=1 ]'));
    assert.ok(p1, 'P=? [ F s=1 ] should be found');
    assert.ok(p1.requirement_ids.includes('PRM-01'));
    assert.ok(p1.requirement_ids.includes('QUORUM-04'));
  });

  test('R{...}=? property detection', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const quorum = data['.planning/formal/prism/quorum.props'];

    const r = quorum.find(p => p.property.startsWith('R{"rounds"}'));
    assert.ok(r, 'R{"rounds"}=? property should be found');
    assert.deepStrictEqual(r.requirement_ids, ['PRM-01']);
  });

  test('S=? property detection', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const mcp = data['.planning/formal/prism/mcp-availability.props'];
    assert.ok(mcp, 'mcp-availability.props should be in output');

    const s1 = mcp.find(p => p.property.includes('min_quorum_available'));
    assert.ok(s1, 'S=? [ "min_quorum_available" ] should be found');
    assert.deepStrictEqual(s1.requirement_ids, ['MCPENV-04']);
  });

  test('descriptive comment lines NOT treated as properties', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const quorum = data['.planning/formal/prism/quorum.props'];
    assert.ok(quorum, 'quorum.props should be in output');

    // Descriptive comments like "// P1: Eventual convergence" should not be properties
    for (const prop of quorum) {
      assert.ok(!prop.property.startsWith('//'), `"${prop.property}" should not start with //`);
    }
  });

  test('quorum.props returns 4 properties', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const quorum = data['.planning/formal/prism/quorum.props'];
    assert.ok(quorum, 'quorum.props should be in output');
    assert.strictEqual(quorum.length, 4, 'Should have 4 properties');
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('output is valid JSON', () => {
    const result = run();
    assert.doesNotThrow(() => JSON.parse(result.stdout), 'Output should be valid JSON');
  });

  test('no empty arrays in output', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    for (const [file, annotations] of Object.entries(data)) {
      assert.ok(annotations.length > 0, `${file} should have at least one annotation`);
    }
  });

  test('all requirement IDs match pattern', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    for (const [file, annotations] of Object.entries(data)) {
      for (const ann of annotations) {
        for (const id of ann.requirement_ids) {
          assert.ok(/^[\w-]+$/.test(id), `"${id}" in ${file} should match ID pattern`);
        }
      }
    }
  });
});

// ── Integration Tests ───────────────────────────────────────────────────────

describe('integration', () => {
  test('NFStopHook.tla has correct requirement IDs', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const stopHook = data['.planning/formal/tla/NFStopHook.tla'];
    assert.ok(stopHook);
    assert.strictEqual(stopHook.length, 7);

    const expectedMapping = {
      'TypeOK': ['STOP-01'],
      'SafetyInvariant1': ['STOP-02', 'SPEC-01'],
      'SafetyInvariant2': ['STOP-03'],
      'SafetyInvariant3': ['STOP-04'],
      'LivenessProperty1': ['STOP-05'],
      'LivenessProperty2': ['STOP-06'],
      'LivenessProperty3': ['STOP-07']
    };

    for (const [prop, expectedIds] of Object.entries(expectedMapping)) {
      const found = stopHook.find(p => p.property === prop);
      assert.ok(found, `${prop} should be found`);
      assert.deepStrictEqual(found.requirement_ids, expectedIds, `${prop} should have correct IDs`);
    }
  });

  test('install-scope.als has correct requirement IDs', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const install = data['.planning/formal/alloy/install-scope.als'];
    assert.ok(install);
    assert.strictEqual(install.length, 5);

    const expectedMapping = {
      'NoConflict': ['INST-01'],
      'AllEquivalence': ['INST-02'],
      'InstallIdempotent': ['INST-03'],
      'RollbackSoundCheck': ['INST-04'],
      'ConfigSyncCompleteCheck': ['INST-05']
    };

    for (const [prop, expectedIds] of Object.entries(expectedMapping)) {
      const found = install.find(p => p.property === prop);
      assert.ok(found, `${prop} should be found`);
      assert.deepStrictEqual(found.requirement_ids, expectedIds);
    }
  });

  test('quorum.props has correct requirement IDs', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const quorum = data['.planning/formal/prism/quorum.props'];
    assert.ok(quorum);
    assert.strictEqual(quorum.length, 4);

    // P1: PRM-01, QUORUM-04
    assert.ok(quorum[0].requirement_ids.includes('PRM-01'));
    assert.ok(quorum[0].requirement_ids.includes('QUORUM-04'));

    // P2: PRM-01
    assert.deepStrictEqual(quorum[1].requirement_ids, ['PRM-01']);

    // P3: PRM-01, LOOP-01
    assert.ok(quorum[2].requirement_ids.includes('PRM-01'));
    assert.ok(quorum[2].requirement_ids.includes('LOOP-01'));

    // P4: PRM-01
    assert.deepStrictEqual(quorum[3].requirement_ids, ['PRM-01']);
  });

  test('total file count >= 22', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    assert.ok(Object.keys(data).length >= 22, `Should have >= 22 files, got ${Object.keys(data).length}`);
  });

  test('total properties >= 85', () => {
    const result = run('--pretty');
    const data = JSON.parse(result.stdout);
    const totalProps = Object.values(data).flat().length;
    assert.ok(totalProps >= 85, `Should have >= 85 properties, got ${totalProps}`);
  });
});

// ── Validation Mode ─────────────────────────────────────────────────────────

describe('validation mode', () => {
  test('--validate reports unannotated count and exits consistently', () => {
    const result = run('--validate');
    // The tool should run without crashing (exit 0 if all annotated, exit 1 if some unannotated)
    assert.ok(result.status === 0 || result.status === 1, `Expected exit 0 or 1, got ${result.status}`);
    assert.ok(result.stdout.includes('VALIDATION:'), 'Should include VALIDATION prefix');
    assert.ok(result.stdout.includes('unannotated'), 'Should report unannotated count');
    // If unannotated exist, should list them
    if (result.status === 1) {
      assert.ok(result.stdout.includes('UNANNOTATED:'), 'Should list unannotated properties');
      assert.ok(result.stdout.includes('FAIL'), 'Should end with FAIL when unannotated exist');
    } else {
      assert.ok(result.stdout.includes('OK'), 'Should end with OK when all annotated');
    }
  });

  test('--summary shows counts per file', () => {
    const result = run('--summary');
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('Total:'), 'Should include Total summary');
    assert.ok(result.stdout.includes('properties'), 'Should mention properties');
    assert.ok(result.stdout.includes('requirement links'), 'Should mention requirement links');
  });
});

// ── Direct parser hardening (adversarial) ───────────────────────────────────

describe('parse functions reject non-string input', () => {
  test('parseTLA returns [] for null/undefined/number', () => {
    assert.deepStrictEqual(annotations.parseTLA(null), []);
    assert.deepStrictEqual(annotations.parseTLA(undefined), []);
    assert.deepStrictEqual(annotations.parseTLA(42), []);
  });

  test('parseAlloy / parsePRISM / parseTestFile reject non-string input', () => {
    assert.deepStrictEqual(annotations.parseAlloy(null), []);
    assert.deepStrictEqual(annotations.parsePRISM(undefined), []);
    assert.deepStrictEqual(annotations.parseTestFile({}), []);
  });
});

describe('parseTestFile annotation association', () => {
  test('does not bind annotation across unrelated code lines', () => {
    const content = [
      '// @requirement REQ-X',
      'const foo = 1;',
      'function bar() { return 2; }',
      "test('unrelated test', () => {});"
    ].join('\n');
    const result = annotations.parseTestFile(content);
    assert.deepStrictEqual(result, [], 'intervening code must break the annotation association');
  });

  test('still binds annotation immediately before a test', () => {
    const content = [
      '// @requirement REQ-Y',
      "test('adjacent test', () => {});"
    ].join('\n');
    const result = annotations.parseTestFile(content);
    assert.deepStrictEqual(result, [{ test_name: 'adjacent test', requirement_ids: ['REQ-Y'] }]);
  });
});
