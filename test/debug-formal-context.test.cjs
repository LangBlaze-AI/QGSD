'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const {
  assembleFormalContext,
  formatConstraintBlock,
  formatVerdictSummary,
  _setDeps
} = require('../bin/debug-formal-context.cjs');

// Mock helpers
function createMockFSS(opts = {}) {
  return {
    runBugModeMatching: opts.runBugModeMatching || (() => null),
    runModelCheckers: opts.runModelCheckers || (() => [])
  };
}

function createMockMCF(opts = {}) {
  return {
    extractTlaConstraints: opts.extractTlaConstraints || (() => []),
    extractAlloyConstraints: opts.extractAlloyConstraints || (() => []),
    renderConstraintSummary: opts.renderConstraintSummary || ((constraints) => ({
      model_path: '',
      formalism: 'tla',
      constraint_count: constraints.length,
      constraints: constraints.map(c => ({
        type: c.type,
        name: c.name,
        english: c.formal || c.name,
        formal: c.formal,
        requirement_id: c.requirement_id,
        confidence: c.confidence
      }))
    }))
  };
}

describe('assembleFormalContext', () => {
  beforeEach(() => {
    _setDeps(null, null); // reset
  });

  it('returns no-model when no models match', async () => {
    _setDeps(createMockFSS({
      runBugModeMatching: () => []
    }), createMockMCF());

    const result = await assembleFormalContext('no matching bug');
    assert.deepEqual(result, { verdict: 'no-model', constraints: [], models: [] });
  });

  it('returns no-model when runBugModeMatching returns null', async () => {
    _setDeps(createMockFSS({
      runBugModeMatching: () => null
    }), createMockMCF());

    const result = await assembleFormalContext('no registry');
    assert.deepEqual(result, { verdict: 'no-model', constraints: [], models: [] });
  });

  it('returns reproduced when a model checker fails', async () => {
    _setDeps(createMockFSS({
      runBugModeMatching: () => [
        { model: 'QuorumModel', formalism: 'tla', bug_relevance_score: 0.8 }
      ],
      runModelCheckers: () => [
        { model: 'QuorumModel', formalism: 'tla', result: 'fail', trace: 'violation' }
      ]
    }), createMockMCF());

    const result = await assembleFormalContext('quorum timeout');
    assert.equal(result.verdict, 'reproduced');
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].name, 'QuorumModel');
    assert.equal(result.models[0].reproduced, true);
  });

  it('returns not-reproduced when models exist but all pass', async () => {
    _setDeps(createMockFSS({
      runBugModeMatching: () => [
        { model: 'TestModel', formalism: 'tla', bug_relevance_score: 0.5 }
      ],
      runModelCheckers: () => [
        { model: 'TestModel', formalism: 'tla', result: 'pass', trace: null }
      ]
    }), createMockMCF());

    const result = await assembleFormalContext('some bug');
    assert.equal(result.verdict, 'not-reproduced');
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].reproduced, false);
  });

  it('limits constraints to max 3 entries', async () => {
    _setDeps(createMockFSS({
      runBugModeMatching: () => [
        { model: 'BigModel', formalism: 'tla', bug_relevance_score: 0.9 }
      ],
      runModelCheckers: () => [
        { model: 'BigModel', formalism: 'tla', result: 'fail', trace: 'err' }
      ]
    }), createMockMCF({
      extractTlaConstraints: () => [
        { type: 'invariant', name: 'Inv1', formal: 'F1', confidence: 0.9, spec_path: 'a.tla' },
        { type: 'invariant', name: 'Inv2', formal: 'F2', confidence: 0.8, spec_path: 'a.tla' },
        { type: 'invariant', name: 'Inv3', formal: 'F3', confidence: 0.7, spec_path: 'a.tla' },
        { type: 'invariant', name: 'Inv4', formal: 'F4', confidence: 0.6, spec_path: 'a.tla' },
        { type: 'invariant', name: 'Inv5', formal: 'F5', confidence: 0.5, spec_path: 'a.tla' }
      ],
      renderConstraintSummary: (constraints, max) => ({
        model_path: 'a.tla',
        formalism: 'tla',
        constraint_count: Math.min(constraints.length, max || 5),
        constraints: constraints.slice(0, max || 5).map(c => ({
          type: c.type, name: c.name, english: c.formal,
          formal: c.formal, requirement_id: c.requirement_id, confidence: c.confidence
        }))
      })
    }));

    // assembleFormalContext reads spec file — it will fail-open since file doesn't exist
    // but the constraints come from the mock, which won't be called without a spec read
    // So let's test formatConstraintBlock directly for the limit
    const fiveConstraints = [
      { text: 'C1', source_model: 'M', formalism: 'tla' },
      { text: 'C2', source_model: 'M', formalism: 'tla' },
      { text: 'C3', source_model: 'M', formalism: 'tla' },
      { text: 'C4', source_model: 'M', formalism: 'tla' },
      { text: 'C5', source_model: 'M', formalism: 'tla' }
    ];
    const block = formatConstraintBlock(fiveConstraints);
    const lines = block.split('\n').filter(l => l.startsWith('- '));
    assert.equal(lines.length, 3, 'should limit to 3 constraint lines');
  });

  it('fail-open: returns default context when formal-scope-scan throws', async () => {
    _setDeps({
      runBugModeMatching: () => { throw new Error('Registry corrupted'); },
      runModelCheckers: () => []
    }, createMockMCF());

    const result = await assembleFormalContext('will throw');
    assert.deepEqual(result, { verdict: 'no-model', constraints: [], models: [] });
  });
});

describe('formatConstraintBlock', () => {
  it('returns empty string for empty constraints', () => {
    assert.equal(formatConstraintBlock([]), '');
    assert.equal(formatConstraintBlock(null), '');
    assert.equal(formatConstraintBlock(undefined), '');
  });

  it('wraps constraints in [FORMAL CONSTRAINTS]...[END FORMAL CONSTRAINTS] block', () => {
    const constraints = [
      { text: 'Quorum must reach consensus', source_model: 'QModel', formalism: 'tla' },
      { text: 'State transitions are atomic', source_model: 'QModel', formalism: 'tla' }
    ];
    const block = formatConstraintBlock(constraints);
    assert.ok(block.startsWith('[FORMAL CONSTRAINTS]'));
    assert.ok(block.includes('[END FORMAL CONSTRAINTS]'));
    assert.ok(block.includes('- Quorum must reach consensus'));
    assert.ok(block.includes('- State transitions are atomic'));
    assert.ok(block.includes('Do NOT propose fixes that violate these constraints'));
  });

  it('does not crash when a constraint entry is null', () => {
    const block = formatConstraintBlock([
      { text: 'valid', source_model: 'M', formalism: 'tla' },
      null
    ]);
    assert.ok(block.startsWith('[FORMAL CONSTRAINTS]'));
    assert.ok(block.includes('- valid'));
  });
});

describe('formatVerdictSummary', () => {
  it('returns correct string for reproduced verdict', () => {
    const result = formatVerdictSummary('reproduced', [
      { name: 'QGSDQuorum', reproduced: true }
    ]);
    assert.ok(result.includes('FORMAL:'));
    assert.ok(result.includes('reproduced'));
    assert.ok(result.includes('QGSDQuorum'));
  });

  it('returns correct string for not-reproduced verdict', () => {
    const result = formatVerdictSummary('not-reproduced', [
      { name: 'Model1', reproduced: false },
      { name: 'Model2', reproduced: false }
    ]);
    assert.ok(result.includes('FORMAL:'));
    assert.ok(result.includes('2 models'));
    assert.ok(result.includes('none reproduced'));
  });

  it('returns correct string for no-model verdict', () => {
    const result = formatVerdictSummary('no-model', []);
    assert.ok(result.includes('FORMAL:'));
    assert.ok(result.includes('No formal model'));
  });

  it('does not crash when a model entry is null in reproduced verdict', () => {
    const result = formatVerdictSummary('reproduced', [null, { name: 'Real', reproduced: true }]);
    assert.ok(result.includes('FORMAL:'));
    assert.ok(result.includes('Real'));
  });
});

describe('CLI mode', () => {
  it('outputs valid JSON to stdout', () => {
    const result = spawnSync('node', [
      path.join(__dirname, '..', 'bin', 'debug-formal-context.cjs'),
      '--description', 'test failure',
      '--format', 'json'
    ], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
      cwd: path.join(__dirname, '..')
    });

    // Should exit cleanly (0) even if no models match
    assert.equal(result.status, 0, 'CLI should exit 0. stderr: ' + (result.stderr || ''));

    const output = JSON.parse(result.stdout.trim());
    assert.ok('verdict' in output, 'output should have verdict');
    assert.ok('constraints' in output, 'output should have constraints');
    assert.ok('models' in output, 'output should have models');
    assert.ok(['reproduced', 'not-reproduced', 'no-model'].includes(output.verdict));
    assert.ok(Array.isArray(output.constraints));
    assert.ok(Array.isArray(output.models));
  });
});
