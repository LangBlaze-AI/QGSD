#!/usr/bin/env node
/**
 * Tests for model state extractor module.
 * Tests state extraction from ITF JSON traces with various scenarios.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { extractFinalStates, analyzeStateSpace } = require('./model-state-extractor.cjs');

/**
 * Helper: Create a temporary ITF JSON fixture for testing.
 * @param {Object} fixtureData - Fixture data with { states, loop }
 * @returns {string} Path to temporary file
 */
function createTempFixture(fixtureData) {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `itf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(fixtureData, null, 2));
  return tmpFile;
}

/**
 * Helper: Clean up temporary file.
 * @param {string} filePath - Path to file to remove
 */
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Test: extractFinalStates returns last state for linear trace (no loop)
test('extractFinalStates returns last state for linear trace', (t) => {
  const fixture = {
    states: [
      { pc: 'Init', x: 0 },
      { pc: 'Step', x: 1 },
      { pc: 'Step', x: 2 },
      { pc: 'Done', x: 3 }
    ],
    loop: null
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = extractFinalStates(tmpFile);
    assert.equal(result.length, 1, 'Should return single state');
    assert.deepEqual(result[0], { pc: 'Done', x: 3 }, 'Should return last state');
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: extractFinalStates returns cycle states for lasso trace (with loopPoint)
test('extractFinalStates returns cycle states for lasso trace', (t) => {
  const fixture = {
    states: [
      { pc: 'Init', counter: 0 },
      { pc: 'Check', counter: 1 },
      { pc: 'Reset', counter: 0 },  // loopPoint = 2, so cycle from here
      { pc: 'Check', counter: 1 }
    ],
    loop: 2  // Loop starts at state index 2
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = extractFinalStates(tmpFile);
    assert.equal(result.length, 2, 'Should return cycle states');
    assert.deepEqual(result[0], { pc: 'Reset', counter: 0 });
    assert.deepEqual(result[1], { pc: 'Check', counter: 1 });
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: extractFinalStates returns empty array for empty trace
test('extractFinalStates returns empty array for empty trace', (t) => {
  const fixture = {
    states: [],
    loop: null
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = extractFinalStates(tmpFile);
    assert.equal(result.length, 0, 'Should return empty array');
    assert.deepEqual(result, []);
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: extractFinalStates returns empty array on file read error (fail-open)
test('extractFinalStates returns empty array on file read error', (t) => {
  const nonexistentFile = '/tmp/nonexistent-itf-file-does-not-exist-' + Date.now() + '.json';
  const result = extractFinalStates(nonexistentFile);
  assert.equal(result.length, 0, 'Should return empty array on error');
  assert.deepEqual(result, []);
});

// Test: analyzeStateSpace returns correct structure for 3-state trace
test('analyzeStateSpace returns correct structure for 3-state trace', (t) => {
  const fixture = {
    states: [
      { phase: 'START', count: 0 },
      { phase: 'ACTIVE', count: 1 },
      { phase: 'DONE', count: 2 }
    ],
    loop: null
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = analyzeStateSpace(tmpFile);

    assert.ok(result.initial_state, 'Should have initial_state');
    assert.deepEqual(result.initial_state, { phase: 'START', count: 0 });

    assert.ok(Array.isArray(result.final_states), 'Should have final_states array');
    assert.equal(result.final_states.length, 1);

    assert.ok(Array.isArray(result.all_states), 'Should have all_states array');
    assert.equal(result.all_states.length, 3, 'Should have 3 unique states');

    assert.equal(result.state_count, 3, 'Should have correct state_count');
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: analyzeStateSpace deduplicates repeated states in all_states
test('analyzeStateSpace deduplicates repeated states in all_states', (t) => {
  const fixture = {
    states: [
      { status: 'IDLE', val: 0 },
      { status: 'WORKING', val: 1 },
      { status: 'IDLE', val: 0 },  // Repeat of first
      { status: 'WORKING', val: 1 } // Repeat of second
    ],
    loop: null
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = analyzeStateSpace(tmpFile);

    assert.equal(result.state_count, 4, 'state_count should be 4 (raw count)');
    assert.equal(result.all_states.length, 2, 'all_states should have 2 unique states after deduplication');

    // Verify unique states are preserved in order of first occurrence
    const stringified = result.all_states.map(s => JSON.stringify(s));
    assert.ok(stringified.includes(JSON.stringify({ status: 'IDLE', val: 0 })));
    assert.ok(stringified.includes(JSON.stringify({ status: 'WORKING', val: 1 })));
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: analyzeStateSpace handles empty state array gracefully
test('analyzeStateSpace handles empty state array gracefully', (t) => {
  const fixture = {
    states: [],
    loop: null
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = analyzeStateSpace(tmpFile);

    assert.equal(result.initial_state, null, 'initial_state should be null');
    assert.deepEqual(result.final_states, [], 'final_states should be empty');
    assert.deepEqual(result.all_states, [], 'all_states should be empty');
    assert.equal(result.state_count, 0, 'state_count should be 0');
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: analyzeStateSpace handles file read error gracefully (fail-open)
test('analyzeStateSpace handles file read error gracefully', (t) => {
  const nonexistentFile = '/tmp/nonexistent-analyze-' + Date.now() + '.json';
  const result = analyzeStateSpace(nonexistentFile);

  assert.equal(result.initial_state, null, 'Should have null initial_state on error');
  assert.deepEqual(result.final_states, [], 'Should have empty final_states on error');
  assert.deepEqual(result.all_states, [], 'Should have empty all_states on error');
  assert.equal(result.state_count, 0, 'Should have state_count=0 on error');
});

// Test: extractFinalStates correctly uses loopPoint boundary
test('extractFinalStates correctly uses loopPoint boundary', (t) => {
  const fixture = {
    states: [
      { iteration: 1 },
      { iteration: 2 },
      { iteration: 3 },
      { iteration: 4 }
    ],
    loop: 1  // Cycle starts at index 1
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = extractFinalStates(tmpFile);
    assert.equal(result.length, 3, 'Should return 3 states from loopPoint onward');
    assert.deepEqual(result[0], { iteration: 2 });
    assert.deepEqual(result[1], { iteration: 3 });
    assert.deepEqual(result[2], { iteration: 4 });
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: extractFinalStates treats boolean loop:false as no loop (returns last state only)
test('extractFinalStates treats boolean loop:false as no loop', (t) => {
  const fixture = {
    states: [
      { pc: 'Init', x: 0 },
      { pc: 'Step', x: 1 },
      { pc: 'Step', x: 2 },
      { pc: 'Done', x: 3 }
    ],
    loop: false  // boolean 'has-loop' flag, NOT a cycle index
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = extractFinalStates(tmpFile);
    assert.equal(result.length, 1, 'Boolean loop:false must not be treated as a cycle start');
    assert.deepEqual(result[0], { pc: 'Done', x: 3 }, 'Should return only the last state');
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: extractFinalStates ignores a fractional (non-integer) loop value
test('extractFinalStates ignores fractional loop index', (t) => {
  const fixture = {
    states: [
      { iteration: 1 },
      { iteration: 2 },
      { iteration: 3 },
      { iteration: 4 }
    ],
    loop: 1.5  // non-integer index is invalid
  };

  const tmpFile = createTempFixture(fixture);
  try {
    const result = extractFinalStates(tmpFile);
    assert.equal(result.length, 1, 'Fractional loop must fall through to last-state behavior');
    assert.deepEqual(result[0], { iteration: 4 });
  } finally {
    cleanupTempFile(tmpFile);
  }
});

// Test: Verify import chain by checking exports exist
test('module exports extractFinalStates and analyzeStateSpace', (t) => {
  assert.ok(typeof extractFinalStates === 'function', 'extractFinalStates should be exported');
  assert.ok(typeof analyzeStateSpace === 'function', 'analyzeStateSpace should be exported');
});
