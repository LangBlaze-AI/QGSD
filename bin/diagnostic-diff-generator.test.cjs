#!/usr/bin/env node
/**
 * Unit tests for diagnostic-diff-generator.cjs
 * Tests state sequence comparison and markdown formatting.
 */

const test = require('node:test');
const assert = require('node:assert');
const { generateStateDiff, formatDiffAsMarkdown } = require('./diagnostic-diff-generator.cjs');

test('generateStateDiff: identical states return empty diffs', () => {
  const statesA = [
    { x: 0, y: 5 },
    { x: 1, y: 4 }
  ];
  const statesB = [
    { x: 0, y: 5 },
    { x: 1, y: 4 }
  ];

  const result = generateStateDiff(statesA, statesB);
  assert.strictEqual(result.per_state_diffs.length, 0);
  assert.strictEqual(result.summary.total_changes, 0);
  assert.strictEqual(result.summary.first_divergence_index, null);
});

test('generateStateDiff: detects single field change', () => {
  const statesA = [
    { x: 0, y: 5 }
  ];
  const statesB = [
    { x: 0, y: 10 }  // y changed from 5 to 10
  ];

  const result = generateStateDiff(statesA, statesB);
  assert.strictEqual(result.per_state_diffs.length, 1);
  assert.strictEqual(result.per_state_diffs[0].index, 0);
  assert.strictEqual(result.per_state_diffs[0].changes.length, 1);
  assert.strictEqual(result.per_state_diffs[0].changes[0].key, 'y');
  assert.strictEqual(result.per_state_diffs[0].changes[0].oldValue, 5);
  assert.strictEqual(result.per_state_diffs[0].changes[0].newValue, 10);  // using newValue from our normalization
  assert.strictEqual(result.summary.total_changes, 1);
  assert.deepStrictEqual(result.summary.changed_fields, ['y']);
});

test('generateStateDiff: detects multiple field changes across states', () => {
  const statesA = [
    { timeout: 5000, phase: 'IDLE', count: 0 },
    { timeout: 5000, phase: 'ACTIVE', count: 1 }
  ];
  const statesB = [
    { timeout: 10000, phase: 'IDLE', count: 0 },   // timeout changed (1 change)
    { timeout: 10000, phase: 'DONE', count: 2 }    // timeout, phase, count changed (3 changes)
  ];

  const result = generateStateDiff(statesA, statesB);
  assert.strictEqual(result.per_state_diffs.length, 2);
  assert.strictEqual(result.summary.total_changes, 4);  // 1 + 3 = 4 total
  assert(result.summary.changed_fields.includes('timeout'));
  assert(result.summary.changed_fields.includes('phase'));
  assert(result.summary.changed_fields.includes('count'));
  assert.strictEqual(result.summary.first_divergence_index, 0);
});

test('generateStateDiff: handles length mismatch', () => {
  const statesA = [
    { x: 0 },
    { x: 1 },
    { x: 2 }
  ];
  const statesB = [
    { x: 0 },
    { x: 1 }
  ];

  const result = generateStateDiff(statesA, statesB);
  assert.strictEqual(result.length_mismatch, true);
  assert.strictEqual(result.aligned_length, 2);
});

test('generateStateDiff: respects fieldFilter option', () => {
  const statesA = [
    { x: 0, y: 5, z: 100 }
  ];
  const statesB = [
    { x: 0, y: 10, z: 200 }  // y and z changed
  ];

  const result = generateStateDiff(statesA, statesB, { fieldFilter: ['x', 'y'] });
  // Only comparing x and y, not z
  assert.strictEqual(result.per_state_diffs.length, 1);
  assert.strictEqual(result.per_state_diffs[0].changes.length, 1);  // Only y changed
  assert.strictEqual(result.per_state_diffs[0].changes[0].key, 'y');
});

test('formatDiffAsMarkdown: produces markdown table for changes', () => {
  const statesA = [
    { timeout: 5000, phase: 'IDLE' }
  ];
  const statesB = [
    { timeout: 10000, phase: 'IDLE' }
  ];

  const diff = generateStateDiff(statesA, statesB);
  const markdown = formatDiffAsMarkdown(diff);

  assert(markdown.includes('## State Divergence Report'));
  assert(markdown.includes('Traces diverge at state 0'));
  assert(markdown.includes('timeout'));
  assert(markdown.includes('5000'));  // Found in backtick format
  assert(markdown.includes('10000'));  // Found in backtick format
  assert(markdown.includes('| Field | Trace A | Trace B |'));
  assert(markdown.includes('### State 0'));
});

test('formatDiffAsMarkdown: produces "identical" message for empty diff', () => {
  const statesA = [{ x: 0 }];
  const statesB = [{ x: 0 }];

  const diff = generateStateDiff(statesA, statesB);
  const markdown = formatDiffAsMarkdown(diff);

  assert(markdown.includes('## State Divergence Report'));
  assert(markdown.includes('Traces are identical'));
  assert(!markdown.includes('diverge at state'));
});

test('formatDiffAsMarkdown: includes length mismatch warning', () => {
  const statesA = [
    { x: 0 },
    { x: 1 },
    { x: 2 }
  ];
  const statesB = [
    { x: 0 },
    { x: 1 }
  ];

  const diff = generateStateDiff(statesA, statesB);
  const markdown = formatDiffAsMarkdown(diff);

  // Note: If no divergence in aligned states, warning still appears
  // This test has identical states [0] and [1], so no per_state_diffs
  // The length_mismatch flag is set but markdown won't show warning without diffs
  // Let's test a case with both length mismatch AND divergence

  const statesA2 = [
    { x: 0 },
    { x: 1 },
    { x: 2 }
  ];
  const statesB2 = [
    { x: 99 },  // divergence
    { x: 1 }    // but only 2 states
  ];

  const diff2 = generateStateDiff(statesA2, statesB2);
  const markdown2 = formatDiffAsMarkdown(diff2);

  assert(markdown2.includes('Trace length mismatch'));
});

test('generateStateDiff: identifies first divergence index correctly', () => {
  const statesA = [
    { x: 0 },
    { x: 1 },
    { x: 2, y: 100 }  // divergence at index 2
  ];
  const statesB = [
    { x: 0 },
    { x: 1 },
    { x: 2, y: 200 }
  ];

  const result = generateStateDiff(statesA, statesB);
  assert.strictEqual(result.summary.first_divergence_index, 2);
});

test('generateStateDiff: fails open on null/undefined sequences (no fieldFilter)', () => {
  // No fieldFilter path must not crash on non-array inputs
  const r1 = generateStateDiff(null, [{ x: 0 }]);
  assert.strictEqual(r1.aligned_length, 0);
  assert.strictEqual(r1.per_state_diffs.length, 0);
  assert.strictEqual(r1.summary.first_divergence_index, null);
  assert.strictEqual(r1.length_mismatch, true);

  const r2 = generateStateDiff(undefined, undefined);
  assert.strictEqual(r2.aligned_length, 0);
  assert.strictEqual(r2.per_state_diffs.length, 0);

  const r3 = generateStateDiff([{ x: 0 }], null);
  assert.strictEqual(r3.aligned_length, 0);
  assert.strictEqual(r3.length_mismatch, true);
});

test('formatDiffAsMarkdown: tolerates diffResult missing summary', () => {
  const malformed = {
    per_state_diffs: [
      { index: 0, changes: [{ key: 'x', oldValue: 1, newValue: 2 }] }
    ]
    // no summary, no aligned_length, no length_mismatch
  };
  const markdown = formatDiffAsMarkdown(malformed);
  assert(markdown.includes('## State Divergence Report'));
  assert(markdown.includes('### State 0'));
  assert(markdown.includes('| x | `1` | `2` |'));
});
