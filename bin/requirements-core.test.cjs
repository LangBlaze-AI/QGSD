'use strict';
// Test suite for bin/requirements-core.cjs
// node --test bin/requirements-core.test.cjs

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

const rc = require('./requirements-core.cjs');

// ─── Temp dir helpers ─────────────────────────────────────────────────────────
function makeTmp() {
  const dir = path.join(os.tmpdir(), 'nf-reqcore-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
  return dir;
}
function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Fixture builders ──────────────────────────────────────────────────────────
function writeFixture(dir, relPath, data) {
  const p = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
}

function makeRequirements(reqs, extra) {
  return {
    aggregated_at: '2026-03-03T00:00:00Z',
    content_hash: 'sha256:abc123',
    frozen_at: '2026-03-03T00:00:00Z',
    requirements: reqs,
    ...extra,
  };
}

function makeReq(id, overrides) {
  return { id, text: `Requirement ${id}`, category: 'Core', status: 'Complete', phase: 'v0.1', ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. readRequirementsJson
// ─────────────────────────────────────────────────────────────────────────────

test('readRequirementsJson: returns fallback when file missing', () => {
  const dir = makeTmp();
  try {
    const result = rc.readRequirementsJson(dir);
    assert.deepStrictEqual(result, { envelope: null, requirements: [] });
  } finally { rmTmp(dir); }
});

test('readRequirementsJson: parses envelope and requirements', () => {
  const dir = makeTmp();
  const data = makeRequirements([makeReq('REQ-01'), makeReq('REQ-02')]);
  writeFixture(dir, '.planning/formal/requirements.json', data);
  try {
    const result = rc.readRequirementsJson(dir);
    assert.strictEqual(result.requirements.length, 2);
    assert.strictEqual(result.envelope.aggregated_at, '2026-03-03T00:00:00Z');
    assert.strictEqual(result.envelope.content_hash, 'sha256:abc123');
    assert.strictEqual(result.envelope.frozen_at, '2026-03-03T00:00:00Z');
  } finally { rmTmp(dir); }
});

test('readRequirementsJson: returns fallback on malformed JSON', () => {
  const dir = makeTmp();
  writeFixture(dir, '.planning/formal/requirements.json', 'NOT_JSON');
  try {
    const result = rc.readRequirementsJson(dir);
    assert.deepStrictEqual(result, { envelope: null, requirements: [] });
  } finally { rmTmp(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. readModelRegistry
// ─────────────────────────────────────────────────────────────────────────────

test('readModelRegistry: returns fallback when file missing', () => {
  const dir = makeTmp();
  try {
    const result = rc.readModelRegistry(dir);
    assert.deepStrictEqual(result, { version: null, last_sync: null, models: {} });
  } finally { rmTmp(dir); }
});

test('readModelRegistry: parses models correctly', () => {
  const dir = makeTmp();
  writeFixture(dir, '.planning/formal/model-registry.json', {
    version: '1.0',
    last_sync: '2026-03-03T00:00:00Z',
    models: {
      '.planning/formal/tla/Foo.tla': { version: 1, requirements: ['REQ-01'] },
    },
  });
  try {
    const result = rc.readModelRegistry(dir);
    assert.strictEqual(result.version, '1.0');
    assert.ok(result.models['.planning/formal/tla/Foo.tla']);
    assert.deepStrictEqual(result.models['.planning/formal/tla/Foo.tla'].requirements, ['REQ-01']);
  } finally { rmTmp(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. readCheckResults
// ─────────────────────────────────────────────────────────────────────────────

test('readCheckResults: returns empty array when file missing', () => {
  const dir = makeTmp();
  try {
    assert.deepStrictEqual(rc.readCheckResults(dir), []);
  } finally { rmTmp(dir); }
});

test('readCheckResults: parses NDJSON lines', () => {
  const dir = makeTmp();
  const lines = [
    JSON.stringify({ check_id: 'tla:foo', result: 'pass', runtime_ms: 10 }),
    JSON.stringify({ check_id: 'ci:bar', result: 'fail', runtime_ms: 50 }),
  ].join('\n') + '\n';
  writeFixture(dir, '.planning/formal/check-results.ndjson', lines);
  try {
    const results = rc.readCheckResults(dir);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].check_id, 'tla:foo');
    assert.strictEqual(results[1].result, 'fail');
  } finally { rmTmp(dir); }
});

test('readCheckResults: skips malformed lines gracefully', () => {
  const dir = makeTmp();
  const lines = [
    JSON.stringify({ check_id: 'ok', result: 'pass' }),
    'NOT_JSON',
    JSON.stringify({ check_id: 'ok2', result: 'fail' }),
  ].join('\n') + '\n';
  writeFixture(dir, '.planning/formal/check-results.ndjson', lines);
  try {
    const results = rc.readCheckResults(dir);
    assert.strictEqual(results.length, 2);
  } finally { rmTmp(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. computeCoverage
// ─────────────────────────────────────────────────────────────────────────────

test('computeCoverage: correct totals and status breakdown', () => {
  const reqs = [
    makeReq('A', { status: 'Complete', category: 'Core' }),
    makeReq('B', { status: 'Complete', category: 'Core' }),
    makeReq('C', { status: 'Pending',  category: 'Safety' }),
    makeReq('D', { status: 'Pending',  category: 'Safety' }),
    makeReq('E', { status: 'Pending',  category: 'Core' }),
  ];
  const registry = { models: {
    'foo.tla': { requirements: ['A', 'C'] },
  }};
  const checks = [
    { check_id: 'tla:quorum-safety', result: 'pass', requirement_ids: ['A'] },
    { check_id: 'ci:unknown', result: 'fail' },
  ];

  const cov = rc.computeCoverage(reqs, registry, checks);
  assert.strictEqual(cov.total, 5);
  assert.strictEqual(cov.byStatus.Complete, 2);
  assert.strictEqual(cov.byStatus.Pending, 3);
  assert.strictEqual(cov.byCategory.Core.total, 3);
  assert.strictEqual(cov.byCategory.Core.complete, 2);
  assert.strictEqual(cov.byCategory.Safety.total, 2);
  assert.strictEqual(cov.byCategory.Safety.complete, 0);
  assert.strictEqual(cov.withFormalModels, 2); // A, C
  assert.strictEqual(cov.totalModels, 1);
  assert.strictEqual(cov.checksByResult.pass, 1);
  assert.strictEqual(cov.checksByResult.fail, 1);
});

test('computeCoverage: empty inputs return zero counts', () => {
  const cov = rc.computeCoverage([], { models: {} }, []);
  assert.strictEqual(cov.total, 0);
  assert.deepStrictEqual(cov.byStatus, {});
  assert.deepStrictEqual(cov.byCategory, {});
  assert.strictEqual(cov.withFormalModels, 0);
  assert.strictEqual(cov.withCheckResults, 0);
});

test('computeCoverage: withCheckResults counts requirements linked via requirement-map', () => {
  // tla:quorum-safety maps to QUORUM-01, QUORUM-02, etc via requirement-map
  const reqs = [
    makeReq('QUORUM-01'),
    makeReq('QUORUM-02'),
    makeReq('UNLINKED'),
  ];
  const checks = [{ check_id: 'tla:quorum-safety', result: 'pass' }];
  const cov = rc.computeCoverage(reqs, { models: {} }, checks);
  assert.strictEqual(cov.withCheckResults, 2); // QUORUM-01, QUORUM-02
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildTraceability
// ─────────────────────────────────────────────────────────────────────────────

test('buildTraceability: returns null for unknown reqId', () => {
  assert.strictEqual(rc.buildTraceability('NOPE', [], { models: {} }, []), null);
});

test('buildTraceability: joins all three sources correctly', () => {
  const reqs = [makeReq('CALIB-01', { category: 'Calibration' })];
  const registry = { models: {
    '.planning/formal/alloy/availability-parsing.als': {
      description: 'Availability model',
      version: 1,
      requirements: ['CALIB-01', 'CALIB-02'],
    },
  }};
  const checks = [
    { check_id: 'alloy:availability', result: 'pass', runtime_ms: 42, summary: 'ok' },
  ];

  const trace = rc.buildTraceability('CALIB-01', reqs, registry, checks);
  assert.ok(trace);
  assert.strictEqual(trace.requirement.id, 'CALIB-01');
  assert.strictEqual(trace.formalModels.length, 1);
  assert.strictEqual(trace.formalModels[0].path, '.planning/formal/alloy/availability-parsing.als');
  assert.strictEqual(trace.checkResults.length, 1);
  assert.strictEqual(trace.checkResults[0].result, 'pass');
});

test('buildTraceability: finds unmapped check_ids', () => {
  const reqs = [makeReq('QUORUM-01')];
  // No check results at all — tla:quorum-safety should be listed as unmapped
  const trace = rc.buildTraceability('QUORUM-01', reqs, { models: {} }, []);
  assert.ok(trace.unmappedCheckIds.includes('tla:quorum-safety'));
});

test('buildTraceability: direct requirement_ids take precedence', () => {
  const reqs = [makeReq('SCHEMA-01')];
  const checks = [
    { check_id: 'test:schema', result: 'pass', requirement_ids: ['SCHEMA-01'] },
  ];
  const trace = rc.buildTraceability('SCHEMA-01', reqs, { models: {} }, checks);
  assert.strictEqual(trace.checkResults.length, 1);
  assert.strictEqual(trace.checkResults[0].check_id, 'test:schema');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. filterRequirements
// ─────────────────────────────────────────────────────────────────────────────

test('filterRequirements: no filters returns all', () => {
  const reqs = [makeReq('A'), makeReq('B'), makeReq('C')];
  assert.strictEqual(rc.filterRequirements(reqs).length, 3);
});

test('filterRequirements: by category', () => {
  const reqs = [
    makeReq('A', { category: 'Safety' }),
    makeReq('B', { category: 'Core' }),
    makeReq('C', { category: 'Safety' }),
  ];
  const filtered = rc.filterRequirements(reqs, { category: 'Safety' });
  assert.strictEqual(filtered.length, 2);
  assert.ok(filtered.every(r => r.category === 'Safety'));
});

test('filterRequirements: by status', () => {
  const reqs = [
    makeReq('A', { status: 'Complete' }),
    makeReq('B', { status: 'Pending' }),
  ];
  assert.strictEqual(rc.filterRequirements(reqs, { status: 'Pending' }).length, 1);
});

test('filterRequirements: by search (case-insensitive)', () => {
  const reqs = [
    makeReq('QUORUM-01', { text: 'Quorum safety invariant' }),
    makeReq('SAFE-01',   { text: 'Safety property holds' }),
  ];
  assert.strictEqual(rc.filterRequirements(reqs, { search: 'quorum' }).length, 1);
  // "SAFE" matches both SAFE-01 (id) and "safety" in QUORUM-01's text
  assert.strictEqual(rc.filterRequirements(reqs, { search: 'SAFE' }).length, 2);
  // Exact id prefix narrows it down
  assert.strictEqual(rc.filterRequirements(reqs, { search: 'SAFE-01' }).length, 1);
});

test('filterRequirements: search matches on id too', () => {
  const reqs = [makeReq('QUORUM-01', { text: 'Something' })];
  assert.strictEqual(rc.filterRequirements(reqs, { search: 'quorum' }).length, 1);
});

test('filterRequirements: combined filters are AND', () => {
  const reqs = [
    makeReq('A', { category: 'Safety', status: 'Complete' }),
    makeReq('B', { category: 'Safety', status: 'Pending' }),
    makeReq('C', { category: 'Core',   status: 'Complete' }),
  ];
  const filtered = rc.filterRequirements(reqs, { category: 'Safety', status: 'Complete' });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 'A');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. getUniqueCategories
// ─────────────────────────────────────────────────────────────────────────────

test('getUniqueCategories: returns sorted deduplicated list', () => {
  const reqs = [
    makeReq('A', { category: 'Safety' }),
    makeReq('B', { category: 'Core' }),
    makeReq('C', { category: 'Safety' }),
    makeReq('D', { category: 'Calibration' }),
  ];
  assert.deepStrictEqual(rc.getUniqueCategories(reqs), ['Calibration', 'Core', 'Safety']);
});

test('getUniqueCategories: missing category becomes Uncategorized', () => {
  const reqs = [makeReq('A', { category: undefined })];
  assert.deepStrictEqual(rc.getUniqueCategories(reqs), ['Uncategorized']);
});

test('getUniqueCategories: empty input returns empty array', () => {
  assert.deepStrictEqual(rc.getUniqueCategories([]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. formal_models integration
// ─────────────────────────────────────────────────────────────────────────────

test('computeCoverage: formal_models field adds to withFormalModels count', () => {
  const reqs = [
    makeReq('FM-01', { formal_models: ['.planning/formal/tla/Foo.tla'], status: 'Complete' }),
    makeReq('FM-02', { status: 'Complete' }),
  ];
  // No registry entry for FM-01, only the direct formal_models field
  const registry = { models: {} };
  const cov = rc.computeCoverage(reqs, registry, []);
  assert.strictEqual(cov.withFormalModels, 1); // FM-01 counted via direct field
});

test('computeCoverage: formal_models + registry union is deduplicated', () => {
  const reqs = [
    makeReq('FM-03', { formal_models: ['.planning/formal/tla/Foo.tla'], status: 'Complete' }),
  ];
  // Registry also lists FM-03 as having models
  const registry = { models: {
    '.planning/formal/tla/Foo.tla': { requirements: ['FM-03'] },
  }};
  const cov = rc.computeCoverage(reqs, registry, []);
  // Set deduplicates, so FM-03 appears once
  assert.strictEqual(cov.withFormalModels, 1);
});

test('buildTraceability: includes models from requirement formal_models field', () => {
  const reqs = [makeReq('FM-04', { formal_models: ['.planning/formal/alloy/bar.als'] })];
  // No registry entry for this model
  const trace = rc.buildTraceability('FM-04', reqs, { models: {} }, []);
  assert.ok(trace);
  assert.strictEqual(trace.formalModels.length, 1);
  assert.strictEqual(trace.formalModels[0].path, '.planning/formal/alloy/bar.als');
  assert.strictEqual(trace.formalModels[0].description, '');
  assert.strictEqual(trace.formalModels[0].version, null);
});

test('buildTraceability: deduplicates models from formal_models and registry', () => {
  const reqs = [makeReq('FM-05', { formal_models: ['.planning/formal/tla/X.tla'] })];
  const registry = { models: {
    '.planning/formal/tla/X.tla': {
      description: 'X model',
      version: 2,
      requirements: ['FM-05'],
    },
  }};
  const trace = rc.buildTraceability('FM-05', reqs, registry, []);
  assert.ok(trace);
  // Registry found it first, so dedup avoids adding duplicate
  assert.strictEqual(trace.formalModels.length, 1);
  assert.strictEqual(trace.formalModels[0].path, '.planning/formal/tla/X.tla');
  assert.strictEqual(trace.formalModels[0].description, 'X model');
  assert.strictEqual(trace.formalModels[0].version, 2);
});

test('buildTraceability: formal_models enriches with registry metadata when available', () => {
  const reqs = [makeReq('FM-06', { formal_models: ['.planning/formal/tla/Y.tla'] })];
  // Registry has metadata for Y.tla but does NOT list FM-06 in requirements
  const registry = { models: {
    '.planning/formal/tla/Y.tla': {
      description: 'Y model',
      version: 3,
      requirements: [], // Does not list FM-06
    },
  }};
  const trace = rc.buildTraceability('FM-06', reqs, registry, []);
  assert.ok(trace);
  // Should add from formal_models field and pull metadata from registry
  assert.strictEqual(trace.formalModels.length, 1);
  assert.strictEqual(trace.formalModels[0].path, '.planning/formal/tla/Y.tla');
  assert.strictEqual(trace.formalModels[0].description, 'Y model');
  assert.strictEqual(trace.formalModels[0].version, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Adversarial hardening — prototype-pollution & corrupt-array shape
// ─────────────────────────────────────────────────────────────────────────────

test('computeCoverage: category "__proto__" does not pollute Object.prototype', () => {
  try {
    const reqs = [makeReq('A', { category: '__proto__', status: 'Complete' })];
    const cov = rc.computeCoverage(reqs, { models: {} }, []);
    // Object.prototype must NOT be polluted by the __proto__ category key
    assert.strictEqual(({}).total, undefined, 'Object.prototype.total was polluted');
    // and the category must still be counted as ordinary data
    assert.strictEqual(cov.byCategory['__proto__'].total, 1);
  } finally {
    delete Object.prototype.total; // clean up if the (buggy) code polluted it
  }
});

test('groupByPrinciple: prototype-named category does not crash and falls back', () => {
  for (const cat of ['constructor', '__proto__', 'toString']) {
    const reqs = [makeReq('A', { category: cat })];
    let grouped;
    assert.doesNotThrow(() => { grouped = rc.groupByPrinciple(reqs); }, `crashed on category=${cat}`);
    assert.strictEqual(grouped['Planning Discipline'].count, 1, `category=${cat} not bucketed into fallback`);
  }
});

test('getUniqueCategories: null/non-object entries are skipped, not crash', () => {
  const reqs = [makeReq('A', { category: 'Core' }), null, 'oops', makeReq('B', { category: 'Safety' })];
  let cats;
  assert.doesNotThrow(() => { cats = rc.getUniqueCategories(reqs); });
  assert.deepStrictEqual(cats, ['Core', 'Safety']);
});
