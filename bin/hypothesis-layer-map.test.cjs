#!/usr/bin/env node
'use strict';
// bin/hypothesis-layer-map.test.cjs
// Tests for hypothesis-layer-map.cjs
// Requirements: HTARGET-01

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let mod;

describe('hypothesis-layer-map module', () => {
  before(() => {
    mod = require('./hypothesis-layer-map.cjs');
  });

  describe('Module exports', () => {
    it('exports mapSourceToLayer as a function', () => {
      assert.equal(typeof mod.mapSourceToLayer, 'function');
    });

    it('exports loadHypothesisTransitions as a function', () => {
      assert.equal(typeof mod.loadHypothesisTransitions, 'function');
    });

    it('exports computeLayerPriorityWeights as a function', () => {
      assert.equal(typeof mod.computeLayerPriorityWeights, 'function');
    });
  });

  describe('mapSourceToLayer', () => {
    it('maps path containing "oscillation" to ["c_to_r"]', () => {
      const result = mod.mapSourceToLayer('/path/to/NFOscillation.tla');
      assert.deepStrictEqual(result, ['c_to_r']);
    });

    it('maps path containing "safety" to ["hazard_model"]', () => {
      const result = mod.mapSourceToLayer('/path/to/NFSafety.tla');
      assert.deepStrictEqual(result, ['hazard_model']);
    });

    it('maps path containing "solve" to ["l1_to_l3"]', () => {
      const result = mod.mapSourceToLayer('/path/to/NFSolveConvergence.tla');
      assert.ok(result.includes('l1_to_l3'));
    });

    it('returns empty array for unmappable model path', () => {
      const result = mod.mapSourceToLayer('/path/to/NFDeliberation.tla');
      assert.deepStrictEqual(result, []);
    });

    it('is case-insensitive', () => {
      const result = mod.mapSourceToLayer('/path/to/NFOSCILLATION.tla');
      assert.deepStrictEqual(result, ['c_to_r']);
    });

    it('returns empty array for null input', () => {
      assert.deepStrictEqual(mod.mapSourceToLayer(null), []);
    });

    it('returns empty array for empty string', () => {
      assert.deepStrictEqual(mod.mapSourceToLayer(''), []);
    });

    it('returns empty array (does not throw) for non-string source_model', () => {
      assert.deepStrictEqual(mod.mapSourceToLayer(12345), []);
      assert.deepStrictEqual(mod.mapSourceToLayer({ path: '/x.tla' }), []);
      assert.deepStrictEqual(mod.mapSourceToLayer(['/x.tla']), []);
      assert.deepStrictEqual(mod.mapSourceToLayer(true), []);
    });
  });

  describe('loadHypothesisTransitions', () => {
    let tmpDir;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-test-'));
      fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'evidence'), { recursive: true });
    });

    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when current measurements file is missing', () => {
      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array when previous measurements file is missing', () => {
      const currentPath = path.join(tmpDir, '.planning', 'formal', 'evidence', 'hypothesis-measurements.json');
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [{ assumption_name: 'A', verdict: 'CONFIRMED', source_model: 'test.tla' }]
      }));
      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.deepStrictEqual(result, []);
    });

    it('detects UNMEASURABLE -> CONFIRMED transition', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      const currentPath = path.join(evidenceDir, 'hypothesis-measurements.json');
      const prevPath = path.join(evidenceDir, 'hypothesis-measurements.prev.json');

      fs.writeFileSync(prevPath, JSON.stringify({
        measurements: [{ assumption_name: 'MaxRounds', verdict: 'UNMEASURABLE', source_model: '/path/NFOscillation.tla' }]
      }));
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [{ assumption_name: 'MaxRounds', verdict: 'CONFIRMED', source_model: '/path/NFOscillation.tla' }]
      }));

      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].from_verdict, 'UNMEASURABLE');
      assert.equal(result[0].to_verdict, 'CONFIRMED');
    });

    it('detects UNMEASURABLE -> VIOLATED transition', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      const prevPath = path.join(evidenceDir, 'hypothesis-measurements.prev.json');
      const currentPath = path.join(evidenceDir, 'hypothesis-measurements.json');

      fs.writeFileSync(prevPath, JSON.stringify({
        measurements: [{ assumption_name: 'BreakerLimit', verdict: 'UNMEASURABLE', source_model: '/path/NFSafety.tla' }]
      }));
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [{ assumption_name: 'BreakerLimit', verdict: 'VIOLATED', source_model: '/path/NFSafety.tla' }]
      }));

      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].to_verdict, 'VIOLATED');
    });

    it('does NOT flag CONFIRMED -> CONFIRMED as a transition', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      const prevPath = path.join(evidenceDir, 'hypothesis-measurements.prev.json');
      const currentPath = path.join(evidenceDir, 'hypothesis-measurements.json');

      fs.writeFileSync(prevPath, JSON.stringify({
        measurements: [{ assumption_name: 'Stable', verdict: 'CONFIRMED', source_model: '/path/test.tla' }]
      }));
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [{ assumption_name: 'Stable', verdict: 'CONFIRMED', source_model: '/path/test.tla' }]
      }));

      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.equal(result.length, 0);
    });

    it('does NOT flag CONFIRMED -> VIOLATED as a transition', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      const prevPath = path.join(evidenceDir, 'hypothesis-measurements.prev.json');
      const currentPath = path.join(evidenceDir, 'hypothesis-measurements.json');

      fs.writeFileSync(prevPath, JSON.stringify({
        measurements: [{ assumption_name: 'Drifted', verdict: 'CONFIRMED', source_model: '/path/test.tla' }]
      }));
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [{ assumption_name: 'Drifted', verdict: 'VIOLATED', source_model: '/path/test.tla' }]
      }));

      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.equal(result.length, 0);
    });

    it('includes correct layer_keys in transition objects', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      const prevPath = path.join(evidenceDir, 'hypothesis-measurements.prev.json');
      const currentPath = path.join(evidenceDir, 'hypothesis-measurements.json');

      fs.writeFileSync(prevPath, JSON.stringify({
        measurements: [{ assumption_name: 'OscLimit', verdict: 'UNMEASURABLE', source_model: '/path/NFOscillation.tla' }]
      }));
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [{ assumption_name: 'OscLimit', verdict: 'CONFIRMED', source_model: '/path/NFOscillation.tla' }]
      }));

      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.equal(result.length, 1);
      assert.deepStrictEqual(result[0].layer_keys, ['c_to_r']);
    });

    it('returns empty array when current file parses to a non-object (corrupt-but-valid JSON)', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      fs.writeFileSync(path.join(evidenceDir, 'hypothesis-measurements.json'), 'null');
      fs.writeFileSync(path.join(evidenceDir, 'hypothesis-measurements.prev.json'), JSON.stringify({ measurements: [] }));
      assert.deepStrictEqual(mod.loadHypothesisTransitions(tmpDir), []);
    });

    it('skips null/non-object measurement entries without throwing', () => {
      const evidenceDir = path.join(tmpDir, '.planning', 'formal', 'evidence');
      const prevPath = path.join(evidenceDir, 'hypothesis-measurements.prev.json');
      const currentPath = path.join(evidenceDir, 'hypothesis-measurements.json');
      fs.writeFileSync(prevPath, JSON.stringify({
        measurements: [null, { assumption_name: 'X', verdict: 'UNMEASURABLE', source_model: '/p/NFOscillation.tla' }]
      }));
      fs.writeFileSync(currentPath, JSON.stringify({
        measurements: [null, { assumption_name: 'X', verdict: 'CONFIRMED', source_model: '/p/NFOscillation.tla' }]
      }));
      const result = mod.loadHypothesisTransitions(tmpDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].assumption_name, 'X');
    });
  });

  describe('computeLayerPriorityWeights', () => {
    it('returns empty object for empty transitions array', () => {
      assert.deepStrictEqual(mod.computeLayerPriorityWeights([]), {});
    });

    it('returns +1 for single transition to single layer', () => {
      const transitions = [{ layer_keys: ['c_to_r'] }];
      assert.deepStrictEqual(mod.computeLayerPriorityWeights(transitions), { c_to_r: 1 });
    });

    it('returns +2 when two transitions map to the same layer', () => {
      const transitions = [
        { layer_keys: ['c_to_r'] },
        { layer_keys: ['c_to_r'] },
      ];
      assert.deepStrictEqual(mod.computeLayerPriorityWeights(transitions), { c_to_r: 2 });
    });

    it('returns separate keys for transitions mapping to different layers', () => {
      const transitions = [
        { layer_keys: ['c_to_r'] },
        { layer_keys: ['hazard_model'] },
      ];
      const result = mod.computeLayerPriorityWeights(transitions);
      assert.equal(result.c_to_r, 1);
      assert.equal(result.hazard_model, 1);
    });

    it('returns empty object for null input', () => {
      assert.deepStrictEqual(mod.computeLayerPriorityWeights(null), {});
    });
  });
});
