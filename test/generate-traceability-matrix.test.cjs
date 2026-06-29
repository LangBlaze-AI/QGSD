'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'bin', 'generate-traceability-matrix.cjs');
const MATRIX_PATH = path.join(__dirname, '..', '.planning', 'formal', 'traceability-matrix.json');
const REQUIREMENTS_PATH = path.join(__dirname, '..', '.planning', 'formal', 'requirements.json');
const ANNOTATIONS_SCRIPT = path.join(__dirname, '..', 'bin', 'extract-annotations.cjs');

/**
 * Run generate-traceability-matrix.cjs with given args and return { stdout, stderr, status }.
 */
function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Run extract-annotations.cjs and return parsed JSON.
 */
function getAnnotations() {
  const result = spawnSync(process.execPath, [ANNOTATIONS_SCRIPT], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

/**
 * Get the matrix by running the generator and reading the output file.
 */
function getMatrix() {
  run(); // generate fresh
  delete require.cache[MATRIX_PATH]; // clear Node require cache
  return JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
}

// ── Basic Execution ─────────────────────────────────────────────────────────

describe('basic execution', () => {
  test('exits with code 0', () => {
    const result = run();
    assert.strictEqual(result.status, 0, 'Expected exit code 0, got ' + result.status);
  });

  test('produces .planning/formal/traceability-matrix.json', () => {
    run();
    assert.ok(fs.existsSync(MATRIX_PATH), 'traceability-matrix.json should exist after generation');
  });

  test('prints summary to stdout', () => {
    const result = run();
    assert.ok(result.stdout.includes('[generate-traceability-matrix]'), 'stdout should contain TAG prefix');
    assert.ok(result.stdout.includes('Generated .planning/formal/traceability-matrix.json'), 'stdout should confirm file generation');
    assert.ok(result.stdout.includes('Requirements:'), 'stdout should include requirements count');
    assert.ok(result.stdout.includes('Properties:'), 'stdout should include properties count');
  });
});

// ── JSON Structure ──────────────────────────────────────────────────────────

describe('JSON structure', () => {
  test('has all required top-level keys', () => {
    const matrix = getMatrix();
    assert.ok(matrix.metadata, 'matrix should have metadata');
    assert.ok(matrix.requirements, 'matrix should have requirements');
    assert.ok(matrix.properties, 'matrix should have properties');
    assert.ok(matrix.coverage_summary, 'matrix should have coverage_summary');
  });
});

// ── Metadata ────────────────────────────────────────────────────────────────

describe('metadata', () => {
  test('generated_at is ISO-8601', () => {
    const matrix = getMatrix();
    const ts = new Date(matrix.metadata.generated_at);
    assert.ok(!isNaN(ts.getTime()), 'generated_at should be a valid ISO-8601 date');
  });

  test('generator_version is 1.1', () => {
    const matrix = getMatrix();
    assert.strictEqual(matrix.metadata.generator_version, '1.1');
  });

  test('data_sources has expected sections', () => {
    const matrix = getMatrix();
    const ds = matrix.metadata.data_sources;
    assert.ok(ds.annotations, 'data_sources should have annotations');
    assert.ok(typeof ds.annotations.file_count === 'number', 'annotations.file_count should be a number');
    assert.ok(typeof ds.annotations.property_count === 'number', 'annotations.property_count should be a number');
    assert.ok(ds.model_registry, 'data_sources should have model_registry');
    assert.ok(typeof ds.model_registry.file_count === 'number', 'model_registry.file_count should be a number');
    assert.ok(typeof ds.model_registry.used_as_fallback === 'number', 'model_registry.used_as_fallback should be a number');
    assert.ok(ds.check_results, 'data_sources should have check_results');
    assert.ok(typeof ds.check_results.entry_count === 'number', 'check_results.entry_count should be a number');
  });
});

// ── Annotation-sourced Properties ───────────────────────────────────────────

describe('annotation-sourced properties', () => {
  test('NFStopHook TypeOK has source annotation and STOP-01', () => {
    const matrix = getMatrix();
    const key = '.planning/formal/tla/NFStopHook.tla::TypeOK';
    const prop = matrix.properties[key];
    assert.ok(prop, key + ' should exist in properties');
    assert.strictEqual(prop.source, 'annotation');
    assert.deepStrictEqual(prop.requirement_ids, ['STOP-01']);
    assert.strictEqual(prop.model_file, '.planning/formal/tla/NFStopHook.tla');
    assert.strictEqual(prop.property_name, 'TypeOK');
  });

  test('known multi-requirement property has all IDs', () => {
    const matrix = getMatrix();
    const key = '.planning/formal/alloy/quorum-composition.als::AllRulesHold';
    const prop = matrix.properties[key];
    assert.ok(prop, key + ' should exist');
    assert.ok(prop.requirement_ids.includes('SPEC-03'), 'should include SPEC-03');
    assert.ok(prop.requirement_ids.includes('COMP-01'), 'should include COMP-01');
    assert.strictEqual(prop.source, 'annotation');
  });

  test('multi-requirement property appears in both requirement entries', () => {
    const matrix = getMatrix();
    const spec03 = matrix.requirements['SPEC-03'];
    const comp01 = matrix.requirements['COMP-01'];
    assert.ok(spec03, 'SPEC-03 should exist in requirements index');
    assert.ok(comp01, 'COMP-01 should exist in requirements index');

    const spec03HasProp = spec03.properties.some(p =>
      p.model_file === '.planning/formal/alloy/quorum-composition.als' && p.property_name === 'AllRulesHold'
    );
    const comp01HasProp = comp01.properties.some(p =>
      p.model_file === '.planning/formal/alloy/quorum-composition.als' && p.property_name === 'AllRulesHold'
    );
    assert.ok(spec03HasProp, 'SPEC-03 should list AllRulesHold');
    assert.ok(comp01HasProp, 'COMP-01 should list AllRulesHold');
  });
});

// ── Bidirectional Consistency ───────────────────────────────────────────────

describe('bidirectional consistency', () => {
  test('every requirement property is in the properties index', () => {
    const matrix = getMatrix();
    for (const [reqId, reqEntry] of Object.entries(matrix.requirements)) {
      for (const prop of reqEntry.properties) {
        const key = prop.model_file + '::' + prop.property_name;
        assert.ok(matrix.properties[key],
          'Requirement ' + reqId + ' references ' + key + ' but it is not in the properties index');
      }
    }
  });

  test('every property requirement ID has a requirements entry', () => {
    const matrix = getMatrix();
    for (const [key, prop] of Object.entries(matrix.properties)) {
      for (const reqId of prop.requirement_ids) {
        assert.ok(matrix.requirements[reqId],
          'Property ' + key + ' references ' + reqId + ' but it is not in the requirements index');
      }
    }
  });
});

// ── Coverage Summary ────────────────────────────────────────────────────────

describe('coverage_summary', () => {
  test('total_requirements matches requirements.json count', () => {
    const matrix = getMatrix();
    const rj = JSON.parse(fs.readFileSync(REQUIREMENTS_PATH, 'utf8'));
    assert.strictEqual(matrix.coverage_summary.total_requirements, rj.requirements.length);
  });

  test('covered_count matches unique requirement IDs in requirements index that are also in requirements.json', () => {
    const matrix = getMatrix();
    const rj = JSON.parse(fs.readFileSync(REQUIREMENTS_PATH, 'utf8'));
    const allIds = new Set(rj.requirements.map(r => r.id));
    const matrixReqIds = Object.keys(matrix.requirements);
    const coveredInReqs = matrixReqIds.filter(id => allIds.has(id));
    assert.strictEqual(matrix.coverage_summary.covered_count, coveredInReqs.length);
  });

  test('coverage_percentage calculation is correct', () => {
    const matrix = getMatrix();
    const cs = matrix.coverage_summary;
    const expected = cs.total_requirements > 0
      ? Math.round((cs.covered_count / cs.total_requirements) * 1000) / 10
      : 0;
    assert.strictEqual(cs.coverage_percentage, expected);
  });

  test('uncovered_requirements is alphabetically sorted', () => {
    const matrix = getMatrix();
    const uncovered = matrix.coverage_summary.uncovered_requirements;
    const sorted = [...uncovered].sort();
    assert.deepStrictEqual(uncovered, sorted, 'uncovered_requirements should be sorted');
  });

  test('orphan_properties is an array', () => {
    const matrix = getMatrix();
    assert.ok(Array.isArray(matrix.coverage_summary.orphan_properties), 'orphan_properties should be an array');
  });

  test('no orphan properties in current annotations', () => {
    const matrix = getMatrix();
    assert.strictEqual(matrix.coverage_summary.orphan_properties.length, 0,
      'Should have 0 orphan properties given v0.25-02 annotations');
  });
});

// ── CLI Flags ───────────────────────────────────────────────────────────────

describe('CLI flags', () => {
  test('--json outputs valid JSON to stdout', () => {
    const result = run('--json');
    assert.strictEqual(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.ok(data.metadata, '--json output should have metadata');
    assert.ok(data.requirements, '--json output should have requirements');
    assert.ok(data.properties, '--json output should have properties');
    assert.ok(data.coverage_summary, '--json output should have coverage_summary');
  });

  test('--quiet suppresses stdout output', () => {
    const result = run('--quiet');
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), '', '--quiet should produce no stdout');
  });
});

// ── Property Count Matches Annotations ──────────────────────────────────────

describe('property counts', () => {
  test('annotation property count matches extract-annotations output', () => {
    const matrix = getMatrix();
    const annotations = getAnnotations();
    let totalProps = 0;
    for (const props of Object.values(annotations)) {
      totalProps += props.length;
    }
    assert.strictEqual(matrix.metadata.data_sources.annotations.property_count, totalProps,
      'annotations.property_count should match extract-annotations total');
  });

  test('annotation file count matches extract-annotations output', () => {
    const matrix = getMatrix();
    const annotations = getAnnotations();
    assert.strictEqual(matrix.metadata.data_sources.annotations.file_count, Object.keys(annotations).length,
      'annotations.file_count should match extract-annotations file count');
  });
});

// ── Bidirectional Validation (TRACE-04) ──────────────────────────────────────

describe('bidirectional validation', () => {
  test('bidirectional_validation section exists', () => {
    const matrix = getMatrix();
    assert.ok(matrix.bidirectional_validation, 'matrix should have bidirectional_validation');
    assert.ok(Array.isArray(matrix.bidirectional_validation.asymmetric_links), 'should have asymmetric_links array');
    assert.ok(Array.isArray(matrix.bidirectional_validation.stale_links), 'should have stale_links array');
    assert.ok(matrix.bidirectional_validation.summary, 'should have summary object');
  });

  test('summary has expected fields', () => {
    const matrix = getMatrix();
    const summary = matrix.bidirectional_validation.summary;
    assert.ok(typeof summary.total_checked === 'number', 'total_checked should be a number');
    assert.ok(typeof summary.asymmetric_count === 'number', 'asymmetric_count should be a number');
    assert.ok(typeof summary.stale_count === 'number', 'stale_count should be a number');
    assert.ok(typeof summary.clean === 'boolean', 'clean should be a boolean');
  });

  test('asymmetric_count matches array length', () => {
    const matrix = getMatrix();
    const bv = matrix.bidirectional_validation;
    assert.strictEqual(bv.summary.asymmetric_count, bv.asymmetric_links.length,
      'asymmetric_count should equal asymmetric_links.length');
  });

  test('stale_count matches array length', () => {
    const matrix = getMatrix();
    const bv = matrix.bidirectional_validation;
    assert.strictEqual(bv.summary.stale_count, bv.stale_links.length,
      'stale_count should equal stale_links.length');
  });

  test('asymmetric link entries have required fields', () => {
    const matrix = getMatrix();
    for (const link of matrix.bidirectional_validation.asymmetric_links) {
      assert.ok(typeof link.model_file === 'string', 'model_file should be a string');
      assert.ok(typeof link.requirement_id === 'string', 'requirement_id should be a string');
      assert.ok(
        link.direction === 'model_claims_requirement' || link.direction === 'requirement_claims_model',
        'direction should be one of the expected values, got: ' + link.direction
      );
      assert.ok(typeof link.detail === 'string', 'detail should be a string');
      assert.ok(link.detail.includes(link.model_file), 'detail should mention model file');
      assert.ok(link.detail.includes(link.requirement_id), 'detail should mention requirement ID');
    }
  });

  test('stale link entries have required fields', () => {
    const matrix = getMatrix();
    for (const link of matrix.bidirectional_validation.stale_links) {
      assert.ok(typeof link.type === 'string', 'type should be a string');
      assert.ok(typeof link.reference === 'string', 'reference should be a string');
      assert.ok(typeof link.referenced_by === 'string', 'referenced_by should be a string');
    }
  });

  test('clean flag is consistent with counts', () => {
    const matrix = getMatrix();
    const s = matrix.bidirectional_validation.summary;
    assert.strictEqual(s.clean, s.asymmetric_count === 0 && s.stale_count === 0,
      'clean should be true only when both counts are 0');
  });

  test('--json mode includes bidirectional validation', () => {
    const result = run('--json');
    const data = JSON.parse(result.stdout);
    assert.ok(data.bidirectional_validation, '--json output should have bidirectional_validation');
    assert.ok(data.bidirectional_validation.summary, '--json output should have summary');
  });

  test('stderr contains asymmetric/stale warnings when issues found', () => {
    const result = run();
    const bv = getMatrix().bidirectional_validation;
    if (bv.summary.asymmetric_count > 0) {
      assert.ok(result.stderr.includes('asymmetric link'), 'stderr should contain asymmetric link warnings');
    }
    if (bv.summary.stale_count > 0) {
      assert.ok(result.stderr.includes('stale link'), 'stderr should contain stale link warnings');
    }
  });

  test('summary output includes bidirectional validation line', () => {
    const result = run();
    assert.ok(result.stdout.includes('Bidirectional validation:'), 'stdout should include bidirectional validation summary');
    assert.ok(result.stdout.includes('pairs checked'), 'stdout should show pairs checked');
  });
});

// ── Fallback Detection ──────────────────────────────────────────────────────

describe('fallback detection', () => {
  test('model-registry fallback properties use source model-registry', () => {
    const matrix = getMatrix();
    const fallbackProps = Object.values(matrix.properties).filter(p => p.source === 'model-registry');
    // There should be fallback entries for .pm files not in annotations
    if (fallbackProps.length > 0) {
      for (const prop of fallbackProps) {
        assert.strictEqual(prop.source, 'model-registry');
        assert.strictEqual(prop.property_name, '(model-level)');
      }
    }
    // Verify the fallback count matches metadata
    assert.strictEqual(matrix.metadata.data_sources.model_registry.used_as_fallback, fallbackProps.length);
  });
});

// ── Coverage Preservation (DECOMP-03) ───────────────────────────────────────

describe('coverage preservation', () => {
  test('coverage_preservation section exists with required keys', () => {
    const matrix = getMatrix();
    const cp = matrix.coverage_preservation;
    assert.ok(cp, 'matrix should have coverage_preservation');
    assert.ok(typeof cp.baseline_found === 'boolean', 'should have boolean baseline_found');
    assert.ok(Array.isArray(cp.regressions), 'should have regressions array');
    assert.ok(cp.summary, 'should have summary object');
  });

  test('summary has required fields', () => {
    const matrix = getMatrix();
    const summary = matrix.coverage_preservation.summary;
    assert.strictEqual(typeof summary.total_regressions, 'number', 'total_regressions should be a number');
    assert.strictEqual(typeof summary.affected_requirements, 'number', 'affected_requirements should be a number');
    assert.strictEqual(typeof summary.clean, 'boolean', 'clean should be a boolean');
  });

  test('baseline detection — previous matrix exists', () => {
    // Since we just ran getMatrix() above, the file exists on disk
    const matrix = getMatrix();
    const cp = matrix.coverage_preservation;
    assert.strictEqual(cp.baseline_found, true, 'baseline should be found when previous matrix exists');
    if (cp.baseline_date) {
      const d = new Date(cp.baseline_date);
      assert.ok(!isNaN(d.getTime()), 'baseline_date should be valid ISO timestamp');
    }
  });

  test('regressions array entries have required fields (if any)', () => {
    const matrix = getMatrix();
    for (const reg of matrix.coverage_preservation.regressions) {
      assert.strictEqual(typeof reg.requirement_id, 'string', 'regression should have string requirement_id');
      assert.strictEqual(typeof reg.baseline_property_count, 'number', 'should have number baseline_property_count');
      assert.strictEqual(typeof reg.current_property_count, 'number', 'should have number current_property_count');
      assert.ok(reg.lost_count > 0, 'lost_count should be positive');
      assert.strictEqual(typeof reg.detail, 'string', 'should have string detail');
    }
  });

  test('clean flag consistency', () => {
    const matrix = getMatrix();
    const cp = matrix.coverage_preservation;
    assert.strictEqual(cp.summary.clean, cp.summary.total_regressions === 0,
      'clean should be true when total_regressions is 0');
  });

  test('total_regressions matches regressions array length', () => {
    const matrix = getMatrix();
    const cp = matrix.coverage_preservation;
    assert.strictEqual(cp.summary.total_regressions, cp.regressions.length,
      'total_regressions should equal regressions.length');
  });

  test('no false positives on stable codebase (run twice)', () => {
    // First run generates baseline
    run();
    // Second run compares against that baseline — nothing changed
    const result = run('--json');
    assert.strictEqual(result.status, 0);
    const data = JSON.parse(result.stdout);
    const cp = data.coverage_preservation;
    assert.strictEqual(cp.regressions.length, 0,
      'Running twice with no changes should produce 0 regressions');
    assert.strictEqual(cp.summary.clean, true);
  });

  test('--json mode includes coverage_preservation', () => {
    const result = run('--json');
    const data = JSON.parse(result.stdout);
    assert.ok(data.coverage_preservation, '--json output should have coverage_preservation');
    assert.ok(data.coverage_preservation.summary, '--json output should have summary');
  });

  test('first-run behavior — no baseline', () => {
    const backupPath = MATRIX_PATH + '.test-backup';
    let restored = false;
    try {
      // Temporarily move baseline away
      if (fs.existsSync(MATRIX_PATH)) {
        fs.renameSync(MATRIX_PATH, backupPath);
      }
      const result = run('--json');
      assert.strictEqual(result.status, 0);
      const data = JSON.parse(result.stdout);
      const cp = data.coverage_preservation;
      assert.strictEqual(cp.baseline_found, false, 'Should report no baseline when file is missing');
      assert.strictEqual(cp.regressions.length, 0, 'No regressions when no baseline');
      assert.strictEqual(cp.summary.clean, true, 'Should be clean when no baseline');
    } finally {
      // Restore baseline
      if (fs.existsSync(backupPath)) {
        // If the run created a new file, remove it first
        if (fs.existsSync(MATRIX_PATH)) {
          fs.unlinkSync(MATRIX_PATH);
        }
        fs.renameSync(backupPath, MATRIX_PATH);
        restored = true;
      }
    }
    assert.ok(restored || !fs.existsSync(backupPath), 'Backup should be restored');
  });

  test('summary output includes coverage preservation line', () => {
    const result = run();
    assert.ok(result.stdout.includes('Coverage preservation:'),
      'stdout should include coverage preservation line');
  });
});

// ── State-Space Integration (DECOMP-04) ─────────────────────────────────────

describe('state_space integration', () => {
  test('state_space section exists and is an object', () => {
    const matrix = getMatrix();
    assert.ok(matrix.state_space, 'matrix should have state_space');
    assert.strictEqual(typeof matrix.state_space, 'object');
  });

  test('state_space has model entries', () => {
    const matrix = getMatrix();
    const keys = Object.keys(matrix.state_space);
    assert.ok(keys.length > 0, 'state_space should have at least one model entry');
  });

  test('each entry has required fields', () => {
    const matrix = getMatrix();
    const validRisks = ['MINIMAL', 'LOW', 'MODERATE', 'HIGH'];
    for (const [file, entry] of Object.entries(matrix.state_space)) {
      assert.ok(validRisks.includes(entry.risk_level),
        file + ' should have valid risk_level, got: ' + entry.risk_level);
      assert.strictEqual(typeof entry.has_unbounded, 'boolean',
        file + ' should have boolean has_unbounded');
      assert.ok(Array.isArray(entry.unbounded_domains),
        file + ' should have array unbounded_domains');
      assert.ok(
        entry.estimated_states === null || typeof entry.estimated_states === 'number',
        file + ' estimated_states should be null or number'
      );
    }
  });

  test('QGSDQuorum_xstate is HIGH risk in matrix', () => {
    const matrix = getMatrix();
    const xstate = matrix.state_space['.planning/formal/tla/QGSDQuorum_xstate.tla'];
    assert.ok(xstate, 'QGSDQuorum_xstate.tla should be in state_space');
    assert.strictEqual(xstate.risk_level, 'HIGH');
    assert.strictEqual(xstate.has_unbounded, true);
  });

  test('--json mode includes state_space', () => {
    const result = run('--json');
    assert.strictEqual(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.ok(data.state_space, '--json output should have state_space');
    assert.ok(Object.keys(data.state_space).length > 0, 'state_space should not be empty');
  });
});

// ── Adversarial Hardening (fail-open / malformed inputs) ─────────────────────

describe('adversarial hardening', () => {
  test('NDJSON line that parses to bare null is skipped, not crashed (fail-open)', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-'));
    const fdir = path.join(dir, '.planning', 'formal');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'model-registry.json'), JSON.stringify({ models: {} }));
    fs.writeFileSync(
      path.join(fdir, 'check-results.ndjson'),
      JSON.stringify({ check_id: 'C1', result: 'PASS', requirement_ids: ['R-1'] }) + '\nnull\n'
    );
    const result = run('--json', '--project-root=' + dir);
    assert.strictEqual(result.status, 0,
      'A bare-null NDJSON line should be skipped, not crash. stderr: ' + result.stderr);
    const data = JSON.parse(result.stdout);
    assert.ok(data.metadata, 'should still produce a matrix');
  });

  test('null-valued model-registry entry is tolerated, not crashed', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-'));
    const fdir = path.join(dir, '.planning', 'formal');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(
      path.join(fdir, 'model-registry.json'),
      JSON.stringify({ models: { '.planning/formal/tla/Foo.tla': null } })
    );
    const result = run('--json', '--project-root=' + dir);
    assert.strictEqual(result.status, 0,
      'A null model entry should be tolerated. stderr: ' + result.stderr);
    const data = JSON.parse(result.stdout);
    assert.ok(data.metadata, 'should still produce a matrix');
  });

  test('requirements.json with object-valued requirements is treated as empty, not crashed', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-'));
    const fdir = path.join(dir, '.planning', 'formal');
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'model-registry.json'), JSON.stringify({ models: {} }));
    fs.writeFileSync(
      path.join(fdir, 'requirements.json'),
      JSON.stringify({ requirements: { 'R-1': { id: 'R-1' } } })
    );
    const result = run('--json', '--project-root=' + dir);
    assert.strictEqual(result.status, 0,
      'Non-array requirements should be treated as empty, not crash. stderr: ' + result.stderr);
    const data = JSON.parse(result.stdout);
    assert.strictEqual(data.coverage_summary.total_requirements, 0,
      'object-shaped requirements should yield 0 total');
  });
});
