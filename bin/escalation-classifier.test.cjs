#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyEscalation,
  buildClassificationPrompt,
  parseClassificationResponse,
  detectNewlyBlocked,
  getLayerGitDiff,
} = require('./escalation-classifier.cjs');

// ── buildClassificationPrompt tests ─────────────────────────────────────────

describe('buildClassificationPrompt', () => {
  it('includes layer name in prompt', () => {
    const prompt = buildClassificationPrompt({
      layer: 'r_to_f',
      deltas: [1, -2, 3],
      gitDiffSummary: '',
      oscillationCount: 2,
      currentResidual: 5,
      previousResidual: 3,
    });
    assert.ok(prompt.includes('r_to_f'));
  });

  it('includes delta series as comma-separated list', () => {
    const prompt = buildClassificationPrompt({
      layer: 'f_to_t',
      deltas: [1, -2, 3],
      gitDiffSummary: '',
      oscillationCount: 1,
      currentResidual: 4,
      previousResidual: 2,
    });
    assert.ok(prompt.includes('1, -2, 3'));
  });

  it('includes git diff summary', () => {
    const prompt = buildClassificationPrompt({
      layer: 'c_to_f',
      deltas: [],
      gitDiffSummary: 'diff --git a/bin/test.cjs',
      oscillationCount: 0,
      currentResidual: 1,
      previousResidual: 0,
    });
    assert.ok(prompt.includes('diff --git a/bin/test.cjs'));
  });

  it('contains all 3 classification options', () => {
    const prompt = buildClassificationPrompt({
      layer: 'r_to_f',
      deltas: [],
      gitDiffSummary: '',
      oscillationCount: 0,
      currentResidual: 0,
      previousResidual: 0,
    });
    assert.ok(prompt.includes('GENUINE_REGRESSION'));
    assert.ok(prompt.includes('MEASUREMENT_NOISE'));
    assert.ok(prompt.includes('INSUFFICIENT_EVIDENCE'));
  });
});

// ── parseClassificationResponse tests ───────────────────────────────────────

describe('parseClassificationResponse', () => {
  it('parses valid JSON response', () => {
    const result = parseClassificationResponse(
      '{"classification":"GENUINE_REGRESSION","confidence":0.85,"reasoning":"Tests were removed"}'
    );
    assert.equal(result.classification, 'GENUINE_REGRESSION');
    assert.equal(result.confidence, 0.85);
    assert.equal(result.reasoning, 'Tests were removed');
  });

  it('handles JSON wrapped in markdown code blocks', () => {
    const result = parseClassificationResponse(
      '```json\n{"classification":"MEASUREMENT_NOISE","confidence":0.7,"reasoning":"Scope growth"}\n```'
    );
    assert.equal(result.classification, 'MEASUREMENT_NOISE');
    assert.equal(result.confidence, 0.7);
  });

  it('defaults to INSUFFICIENT_EVIDENCE on invalid JSON', () => {
    const result = parseClassificationResponse('not json at all');
    assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.confidence, 0);
  });

  it('defaults to INSUFFICIENT_EVIDENCE on unknown classification', () => {
    const result = parseClassificationResponse(
      '{"classification":"UNKNOWN_TYPE","confidence":0.5,"reasoning":"test"}'
    );
    assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  });

  it('defaults to INSUFFICIENT_EVIDENCE on null input', () => {
    const result = parseClassificationResponse(null);
    assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.confidence, 0);
  });

  it('defaults to INSUFFICIENT_EVIDENCE on empty string', () => {
    const result = parseClassificationResponse('');
    assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.confidence, 0);
  });

  it('clamps confidence to 0-1 range', () => {
    const result = parseClassificationResponse(
      '{"classification":"GENUINE_REGRESSION","confidence":1.5,"reasoning":"test"}'
    );
    assert.equal(result.confidence, 1);

    const result2 = parseClassificationResponse(
      '{"classification":"GENUINE_REGRESSION","confidence":-0.5,"reasoning":"test"}'
    );
    assert.equal(result2.confidence, 0);
  });
});

// ── detectNewlyBlocked tests ────────────────────────────────────────────────

describe('detectNewlyBlocked', () => {
  it('detects layer transitioning from unblocked to blocked', () => {
    const prev = { r_to_f: { blocked: false } };
    const curr = { r_to_f: { blocked: true } };
    const result = detectNewlyBlocked(prev, curr);
    assert.ok(result.includes('r_to_f'));
  });

  it('does not return already-blocked layers', () => {
    const prev = { r_to_f: { blocked: true } };
    const curr = { r_to_f: { blocked: true } };
    const result = detectNewlyBlocked(prev, curr);
    assert.equal(result.length, 0);
  });

  it('does not return unblocked layers', () => {
    const prev = { r_to_f: { blocked: false } };
    const curr = { r_to_f: { blocked: false } };
    const result = detectNewlyBlocked(prev, curr);
    assert.equal(result.length, 0);
  });

  it('detects multiple newly blocked layers', () => {
    const prev = { r_to_f: { blocked: false }, f_to_t: { blocked: false } };
    const curr = { r_to_f: { blocked: true }, f_to_t: { blocked: true } };
    const result = detectNewlyBlocked(prev, curr);
    assert.ok(result.includes('r_to_f'));
    assert.ok(result.includes('f_to_t'));
  });

  it('handles null prev verdicts (first run)', () => {
    const curr = { r_to_f: { blocked: true } };
    const result = detectNewlyBlocked(null, curr);
    assert.ok(result.includes('r_to_f'));
  });

  it('handles null curr verdicts gracefully', () => {
    const result = detectNewlyBlocked({}, null);
    assert.deepEqual(result, []);
  });
});

// ── getLayerGitDiff tests ───────────────────────────────────────────────────

describe('getLayerGitDiff', () => {
  it('returns string for known layer', () => {
    const result = getLayerGitDiff('r_to_f', process.cwd(), 5);
    assert.equal(typeof result, 'string');
  });

  it('returns empty string for unknown layer', () => {
    const result = getLayerGitDiff('nonexistent_layer', process.cwd(), 5);
    assert.equal(result, '');
  });

  it('truncates long diffs at 2000 chars', () => {
    // This test is best-effort; in practice diffs may be short
    const result = getLayerGitDiff('r_to_f', process.cwd(), 100);
    assert.ok(result.length <= 2020); // 2000 + truncation message
  });
});

// ── classifyEscalation corrupt trend entries ────────────────────────────────

describe('classifyEscalation corrupt trend entries', () => {
  it('does not crash when a trend line parses to null (fail-open)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-cls-'));
    const formalDir = path.join(dir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });

    const verdictsPath = path.join(formalDir, 'oscillation-verdicts.json');
    fs.writeFileSync(verdictsPath, JSON.stringify({ layers: { r_to_f: { oscillation_count: 2 } } }));

    const trendPath = path.join(formalDir, 'solve-trend.jsonl');
    // A literal `null` JSONL line (corrupt/truncated write) parses to null
    fs.writeFileSync(trendPath, 'null\n{"per_layer":{"r_to_f":3}}\n');

    delete process.env.ANTHROPIC_API_KEY; // force fail-open, no network call

    let result;
    assert.doesNotThrow(() => {
      result = classifyEscalation({ layer: 'r_to_f', root: dir, trendPath, verdictsPath });
    });
    assert.equal(result.layer, 'r_to_f');
    assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  });
});

// ── buildClassificationPrompt defensive input ───────────────────────────────

describe('buildClassificationPrompt defensive input', () => {
  it('does not throw on missing context', () => {
    assert.doesNotThrow(() => buildClassificationPrompt(undefined));
    const prompt = buildClassificationPrompt(undefined);
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.includes('GENUINE_REGRESSION'));
  });

  it('does not throw when deltas is a non-array', () => {
    assert.doesNotThrow(() => buildClassificationPrompt({ layer: 'r_to_f', deltas: '1,2,3' }));
    const prompt = buildClassificationPrompt({ layer: 'r_to_f', deltas: '1,2,3' });
    assert.equal(typeof prompt, 'string');
  });
});
