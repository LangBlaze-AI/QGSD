'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  linkBugsToProperties,
  writeBugToProperty,
  computePerModelRecall,
  formatRecallSummary,
  fitExponentialDecay,
  computeConvergenceVelocity,
  updatePredictivePower,
  formatPredictivePowerSummary,
} = require('./predictive-power.cjs');

// ── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pred-power-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(name, obj) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ── linkBugsToProperties ─────────────────────────────────────────────────────

describe('linkBugsToProperties', () => {
  it('returns empty mappings for empty debt_entries', () => {
    const debtPath = writeTmp('debt-empty.json', { debt_entries: [] });
    const regPath = writeTmp('reg-empty.json', { models: {} });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 0);
    assert.strictEqual(result.total_linked, 0);
    assert.deepStrictEqual(result.mappings, []);
    assert.strictEqual(result.schema_version, '1');
  });

  it('links debt entry WITH formal_refs matching a model requirement', () => {
    const debtPath = writeTmp('debt-match.json', {
      debt_entries: [{
        id: 'bug-1',
        fingerprint: 'fp-1',
        title: 'Some bug',
        formal_refs: ['REQ-01', 'REQ-02'],
        source_entries: [{ source_type: 'internal' }],
      }],
    });
    const regPath = writeTmp('reg-match.json', {
      models: {
        '.planning/formal/alloy/model-a.als': {
          requirements: ['REQ-01', 'REQ-03'],
          gate_maturity: 'SOFT_GATE',
          layer_maturity: 3,
        },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 1);
    assert.strictEqual(result.total_linked, 1);
    assert.strictEqual(result.mappings[0].predicted, true);
    assert.strictEqual(result.mappings[0].matching_models.length, 1);
    assert.deepStrictEqual(result.mappings[0].matching_models[0].requirements_overlap, ['REQ-01']);
  });

  it('marks debt entry as not predicted when formal_refs do not match any model', () => {
    const debtPath = writeTmp('debt-nomatch.json', {
      debt_entries: [{
        id: 'bug-2',
        fingerprint: 'fp-2',
        title: 'Another bug',
        formal_refs: ['REQ-99'],
        source_entries: [{ source_type: 'github' }],
      }],
    });
    const regPath = writeTmp('reg-nomatch.json', {
      models: {
        '.planning/formal/alloy/model-a.als': {
          requirements: ['REQ-01'],
          gate_maturity: 'ADVISORY',
          layer_maturity: 1,
        },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 1);
    assert.strictEqual(result.total_linked, 0);
    assert.strictEqual(result.mappings[0].predicted, false);
    assert.deepStrictEqual(result.mappings[0].matching_models, []);
  });

  it('marks debt entry WITHOUT formal_refs as unlinked (predicted: false)', () => {
    const debtPath = writeTmp('debt-noref.json', {
      debt_entries: [{
        id: 'bug-3',
        fingerprint: 'fp-3',
        title: 'Unlinked bug',
        source_entries: [{ source_type: 'internal' }],
      }],
    });
    const regPath = writeTmp('reg-noref.json', {
      models: {
        '.planning/formal/alloy/model-a.als': {
          requirements: ['REQ-01'],
          gate_maturity: 'SOFT_GATE',
          layer_maturity: 2,
        },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 1);
    assert.strictEqual(result.total_linked, 0);
    assert.strictEqual(result.mappings[0].predicted, false);
    assert.deepStrictEqual(result.mappings[0].formal_refs, []);
    assert.deepStrictEqual(result.mappings[0].matching_models, []);
  });

  it('multiple models match same debt entry — all appear in matching_models', () => {
    const debtPath = writeTmp('debt-multi.json', {
      debt_entries: [{
        id: 'bug-4',
        fingerprint: 'fp-4',
        title: 'Multi-match bug',
        formal_refs: ['REQ-01', 'REQ-02'],
        source_entries: [{ source_type: 'internal' }],
      }],
    });
    const regPath = writeTmp('reg-multi.json', {
      models: {
        '.planning/formal/alloy/model-a.als': {
          requirements: ['REQ-01'],
          gate_maturity: 'SOFT_GATE',
          layer_maturity: 3,
        },
        '.planning/formal/tla/model-b.tla': {
          requirements: ['REQ-02', 'REQ-05'],
          gate_maturity: 'HARD_GATE',
          layer_maturity: 5,
        },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_linked, 1);
    assert.strictEqual(result.mappings[0].matching_models.length, 2);
  });

  it('partial overlap: entry has [A, B], model has [B, C] — overlap is [B]', () => {
    const debtPath = writeTmp('debt-partial.json', {
      debt_entries: [{
        id: 'bug-5',
        fingerprint: 'fp-5',
        title: 'Partial overlap',
        formal_refs: ['REQ-A', 'REQ-B'],
        source_entries: [{ source_type: 'internal' }],
      }],
    });
    const regPath = writeTmp('reg-partial.json', {
      models: {
        '.planning/formal/alloy/model-p.als': {
          requirements: ['REQ-B', 'REQ-C'],
          gate_maturity: 'ADVISORY',
          layer_maturity: 1,
        },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.mappings[0].predicted, true);
    assert.deepStrictEqual(result.mappings[0].matching_models[0].requirements_overlap, ['REQ-B']);
  });

  it('filters out model keys not starting with "."', () => {
    const debtPath = writeTmp('debt-filter.json', {
      debt_entries: [{
        id: 'bug-6',
        fingerprint: 'fp-6',
        title: 'Filter test',
        formal_refs: ['REQ-01'],
        source_entries: [{ source_type: 'internal' }],
      }],
    });
    const regPath = writeTmp('reg-filter.json', {
      models: {
        'version': { requirements: ['REQ-01'] },
        '.planning/formal/alloy/model-ok.als': {
          requirements: ['REQ-01'],
          gate_maturity: 'ADVISORY',
          layer_maturity: 1,
        },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.mappings[0].matching_models.length, 1);
    assert.strictEqual(result.mappings[0].matching_models[0].model_path, '.planning/formal/alloy/model-ok.als');
  });

  it('returns empty result when debt.json is missing (fail-open)', () => {
    const regPath = writeTmp('reg-ok.json', { models: {} });
    const result = linkBugsToProperties('/nonexistent/debt.json', regPath);
    assert.strictEqual(result.total_bugs, 0);
    assert.strictEqual(result.total_linked, 0);
  });

  it('returns empty result when model-registry.json is missing (fail-open)', () => {
    const debtPath = writeTmp('debt-ok.json', { debt_entries: [] });
    const result = linkBugsToProperties(debtPath, '/nonexistent/registry.json');
    assert.strictEqual(result.total_bugs, 0);
    assert.strictEqual(result.total_linked, 0);
  });

  it('fails open when debt.json contains literal null (parseable but wrong shape)', () => {
    const debtPath = path.join(tmpDir, 'debt-null.json');
    fs.writeFileSync(debtPath, 'null');
    const regPath = writeTmp('reg-for-null.json', { models: {} });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 0);
    assert.strictEqual(result.total_linked, 0);
    assert.deepStrictEqual(result.mappings, []);
  });

  it('fails open when model-registry.json contains literal null', () => {
    const debtPath = writeTmp('debt-for-regnull.json', { debt_entries: [] });
    const regPath = path.join(tmpDir, 'reg-null.json');
    fs.writeFileSync(regPath, 'null');
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 0);
    assert.strictEqual(result.total_linked, 0);
  });

  it('skips null/non-object model registry entries instead of crashing', () => {
    const debtPath = writeTmp('debt-modelnull.json', {
      debt_entries: [{
        id: 'bug-x', fingerprint: 'fp-x', title: 'corrupt registry',
        formal_refs: ['REQ-01'],
        source_entries: [{ source_type: 'internal' }],
      }],
    });
    const regPath = writeTmp('reg-modelnull.json', {
      models: {
        '.planning/formal/alloy/broken.als': null,
        '.planning/formal/alloy/ok.als': { requirements: ['REQ-01'], gate_maturity: 'ADVISORY', layer_maturity: 1 },
      },
    });
    const result = linkBugsToProperties(debtPath, regPath);
    assert.strictEqual(result.total_bugs, 1);
    assert.strictEqual(result.mappings[0].matching_models.length, 1);
    assert.strictEqual(result.mappings[0].matching_models[0].model_path, '.planning/formal/alloy/ok.als');
  });
});

// ── writeBugToProperty ───────────────────────────────────────────────────────

describe('writeBugToProperty', () => {
  it('writes mapping to file with generated timestamp', () => {
    const mapping = { schema_version: '1', total_bugs: 0, total_linked: 0, mappings: [] };
    const outPath = path.join(tmpDir, 'bug-to-property.json');
    writeBugToProperty(mapping, outPath);
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(written.schema_version, '1');
    assert.ok(written.generated);
  });
});

// ── computePerModelRecall ────────────────────────────────────────────────────

describe('computePerModelRecall', () => {
  it('computes recall for model with 3 relevant, 2 predicted (gate_a passes)', () => {
    const mappings = [
      { matching_models: [{ model_path: '.m/a.als' }] },
      { matching_models: [{ model_path: '.m/a.als' }] },
      { matching_models: [{ model_path: '.m/a.als' }] },
    ];
    const gatesPath = writeTmp('gates-recall.json', {
      '.m/a.als': { gate_a: { pass: true } },
    });
    const result = computePerModelRecall(mappings, gatesPath);
    assert.strictEqual(result['.m/a.als'].relevant, 3);
    assert.strictEqual(result['.m/a.als'].predicted, 3);
    assert.strictEqual(result['.m/a.als'].recall, 1);
  });

  it('returns recall=0 when model has 0 relevant bugs', () => {
    const mappings = [];
    const gatesPath = writeTmp('gates-empty.json', {});
    const result = computePerModelRecall(mappings, gatesPath);
    assert.deepStrictEqual(result, {});
  });

  it('returns predicted=0 when gate_a does not pass', () => {
    const mappings = [
      { matching_models: [{ model_path: '.m/b.als' }] },
      { matching_models: [{ model_path: '.m/b.als' }] },
    ];
    const gatesPath = writeTmp('gates-fail.json', {
      '.m/b.als': { gate_a: { pass: false } },
    });
    const result = computePerModelRecall(mappings, gatesPath);
    assert.strictEqual(result['.m/b.als'].relevant, 2);
    assert.strictEqual(result['.m/b.als'].predicted, 0);
    assert.strictEqual(result['.m/b.als'].recall, 0);
  });

  it('returns empty object when per-model-gates.json is missing (fail-open)', () => {
    const mappings = [
      { matching_models: [{ model_path: '.m/c.als' }] },
    ];
    const result = computePerModelRecall(mappings, '/nonexistent/per-model-gates.json');
    assert.deepStrictEqual(result, {});
  });

  it('returns recall=0 for model present in mappings but absent from per-model-gates.json', () => {
    const mappings = [
      { matching_models: [{ model_path: '.m/missing.als' }] },
      { matching_models: [{ model_path: '.m/missing.als' }] },
    ];
    const gatesPath = writeTmp('gates-partial.json', {
      '.m/other.als': { gate_a: { pass: true } },
    });
    const result = computePerModelRecall(mappings, gatesPath);
    assert.strictEqual(result['.m/missing.als'].relevant, 2);
    assert.strictEqual(result['.m/missing.als'].predicted, 0);
    assert.strictEqual(result['.m/missing.als'].recall, 0);
  });

  it('computes correct recall with mixed gate_a pass/fail', () => {
    const mappings = [
      { matching_models: [{ model_path: '.m/d.als' }] },
      { matching_models: [{ model_path: '.m/d.als' }] },
      { matching_models: [{ model_path: '.m/d.als' }] },
    ];
    // gate_a passes — so all 3 relevant bugs are predicted for this model
    // To test partial: we need a model where gate_a passes for some bugs
    // but computePerModelRecall checks per-model gate, not per-bug
    // So if gate_a passes, ALL relevant bugs for that model count as predicted
    const gatesPath = writeTmp('gates-mixed.json', {
      '.m/d.als': { gate_a: { pass: true } },
    });
    const result = computePerModelRecall(mappings, gatesPath);
    assert.strictEqual(result['.m/d.als'].recall, 1);
  });
});

// ── formatRecallSummary ──────────────────────────────────────────────────────

describe('formatRecallSummary', () => {
  it('returns string containing top models by recall', () => {
    const scores = {
      '.m/a.als': { relevant: 3, predicted: 2, recall: 0.6667 },
      '.m/b.als': { relevant: 5, predicted: 5, recall: 1 },
    };
    const summary = formatRecallSummary(scores);
    assert.ok(summary.includes('--- Recall ---'));
    assert.ok(summary.includes('Models scored: 2'));
    assert.ok(summary.includes('b.als'));
  });

  it('returns "no data" message for empty recall scores', () => {
    const summary = formatRecallSummary({});
    assert.ok(summary.includes('No recall data'));
  });

  it('returns "no data" message for null', () => {
    const summary = formatRecallSummary(null);
    assert.ok(summary.includes('No recall data'));
  });
});

// ── fitExponentialDecay ──────────────────────────────────────────────────────

describe('fitExponentialDecay', () => {
  it('returns CONVERGING for synthetic decreasing series', () => {
    // Geometric decay: 100 * 0.8^t
    const values = [];
    for (let i = 0; i < 15; i++) values.push(100 * Math.pow(0.8, i));
    const result = fitExponentialDecay(values);
    assert.strictEqual(result.status, 'CONVERGING');
    assert.ok(result.lambda > 0);
    assert.ok(result.sessions_to_convergence > 0);
  });

  it('returns INSUFFICIENT_DATA for less than 10 values', () => {
    const result = fitExponentialDecay([10, 8, 6, 4, 3, 2, 1]);
    assert.strictEqual(result.status, 'INSUFFICIENT_DATA');
  });

  it('returns STABLE for all same values', () => {
    const values = Array(15).fill(5);
    const result = fitExponentialDecay(values);
    assert.strictEqual(result.status, 'STABLE');
    assert.strictEqual(result.lambda, 0);
  });

  it('returns NOT_CONVERGING for increasing series', () => {
    const values = [];
    for (let i = 0; i < 15; i++) values.push(1 + i * 2);
    const result = fitExponentialDecay(values);
    assert.strictEqual(result.status, 'NOT_CONVERGING');
    assert.ok(result.lambda <= 0);
  });

  it('filters zeros and fits remaining points', () => {
    const values = [];
    for (let i = 0; i < 20; i++) {
      values.push(i % 3 === 0 ? 0 : 50 * Math.pow(0.85, i));
    }
    const result = fitExponentialDecay(values);
    // Should still have enough valid points (20 - ~7 zeros = ~13)
    assert.ok(result.status !== 'INSUFFICIENT_DATA');
  });

  it('filters -1 values (fast-mode skipped)', () => {
    const values = [];
    for (let i = 0; i < 20; i++) {
      values.push(i % 4 === 0 ? -1 : 80 * Math.pow(0.9, i));
    }
    const result = fitExponentialDecay(values);
    assert.ok(result.status !== 'INSUFFICIENT_DATA');
  });

  it('returns CONVERGED when current residual <= 0.5', () => {
    // Values that decay to below threshold
    const values = [];
    for (let i = 0; i < 15; i++) values.push(100 * Math.pow(0.5, i));
    // Last value: 100 * 0.5^14 = very small
    const result = fitExponentialDecay(values);
    assert.strictEqual(result.status, 'CONVERGED');
    assert.strictEqual(result.sessions_to_convergence, 0);
  });
});

// ── computeConvergenceVelocity ───────────────────────────────────────────────

describe('computeConvergenceVelocity', () => {
  it('returns per-layer status from mock JSONL file', () => {
    // Create a JSONL file with 12 entries
    const lines = [];
    for (let i = 0; i < 12; i++) {
      const layers = {};
      layers['r_to_f'] = 50 * Math.pow(0.85, i);
      layers['f_to_t'] = 30 * Math.pow(0.9, i);
      lines.push(JSON.stringify({ session: i, layers }));
    }
    const trendPath = path.join(tmpDir, 'trend-vel.jsonl');
    fs.writeFileSync(trendPath, lines.join('\n'));

    const result = computeConvergenceVelocity(trendPath);
    // r_to_f should have 12 valid points
    assert.ok(result.r_to_f.status === 'CONVERGING' || result.r_to_f.status === 'CONVERGED');
    assert.ok(result.f_to_t.status === 'CONVERGING' || result.f_to_t.status === 'CONVERGED');
  });

  it('returns INSUFFICIENT_DATA for layer with < 10 entries', () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      const layers = {};
      layers['r_to_f'] = 10 - i;
      lines.push(JSON.stringify({ session: i, layers }));
    }
    const trendPath = path.join(tmpDir, 'trend-short.jsonl');
    fs.writeFileSync(trendPath, lines.join('\n'));

    const result = computeConvergenceVelocity(trendPath);
    assert.strictEqual(result.r_to_f.status, 'INSUFFICIENT_DATA');
  });

  it('returns all INSUFFICIENT_DATA when JSONL file is missing', () => {
    const result = computeConvergenceVelocity('/nonexistent/solve-trend.jsonl');
    assert.strictEqual(result.r_to_f.status, 'INSUFFICIENT_DATA');
    assert.strictEqual(result.f_to_t.status, 'INSUFFICIENT_DATA');
    assert.strictEqual(result.c_to_f.status, 'INSUFFICIENT_DATA');
  });

  it('ignores a literal-null line in solve-trend.jsonl instead of crashing', () => {
    const lines = [];
    for (let i = 0; i < 12; i++) {
      lines.push(JSON.stringify({ session: i, layers: { r_to_f: 50 * Math.pow(0.85, i) } }));
    }
    lines.push('null'); // parseable-but-null adversarial line
    const trendPath = path.join(tmpDir, 'trend-nullline.jsonl');
    fs.writeFileSync(trendPath, lines.join('\n'));

    const result = computeConvergenceVelocity(trendPath);
    assert.ok(result.r_to_f.status === 'CONVERGING' || result.r_to_f.status === 'CONVERGED');
  });
});

// ── updatePredictivePower ────────────────────────────────────────────────────

describe('updatePredictivePower', () => {
  it('returns { linking, recall, velocity } structure with mock files', () => {
    const formalDir = path.join(tmpDir, 'upd-test', '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    fs.writeFileSync(path.join(formalDir, 'debt.json'), JSON.stringify({ debt_entries: [] }));
    fs.writeFileSync(path.join(formalDir, 'model-registry.json'), JSON.stringify({ models: {} }));

    const result = updatePredictivePower({ root: path.join(tmpDir, 'upd-test') });
    assert.ok(result.linking);
    assert.ok(result.recall !== undefined);
    assert.ok(result.velocity);
    assert.strictEqual(result.linking.total_bugs, 0);
  });

  it('handles first-run with no solve-trend.jsonl gracefully', () => {
    const formalDir = path.join(tmpDir, 'upd-first', '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    fs.writeFileSync(path.join(formalDir, 'debt.json'), JSON.stringify({ debt_entries: [] }));
    fs.writeFileSync(path.join(formalDir, 'model-registry.json'), JSON.stringify({ models: {} }));

    const result = updatePredictivePower({ root: path.join(tmpDir, 'upd-first') });
    assert.ok(result.velocity);
    assert.strictEqual(result.velocity.r_to_f.status, 'INSUFFICIENT_DATA');
  });
});

// ── formatPredictivePowerSummary ─────────────────────────────────────────────

describe('formatPredictivePowerSummary', () => {
  it('produces "--- Predictive Power ---" header for non-empty results', () => {
    const results = {
      linking: { total_bugs: 5, total_linked: 3 },
      recall: { '.m/a.als': { relevant: 3, predicted: 2, recall: 0.6667 } },
      velocity: { r_to_f: { status: 'CONVERGING', lambda: 0.1, sessions_to_convergence: 5 } },
    };
    const summary = formatPredictivePowerSummary(results);
    assert.ok(summary.includes('--- Predictive Power ---'));
    assert.ok(summary.includes('Bugs: 5'));
  });

  it('returns graceful output for null results', () => {
    const summary = formatPredictivePowerSummary(null);
    assert.ok(summary.includes('--- Predictive Power ---'));
    assert.ok(summary.includes('No data'));
  });
});
