#!/usr/bin/env node
/**
 * Tests for diagnostic proposal generator module.
 * Tests evidence-based proposal generation, context-aware confidence scoring,
 * and priority ordering.
 */

const test = require('node:test');
const assert = require('node:assert');

const { generateCorrectionProposals } = require('./diagnostic-proposal-generator.cjs');

// Test: Returns empty array for identical traces (no changes)
test('Returns empty array for identical traces (no changes)', (t) => {
  const stateDiff = {
    summary: { changed_fields: [], first_divergence_index: null, total_changes: 0 },
    per_state_diffs: []
  };

  const proposals = generateCorrectionProposals(stateDiff, 'some bug context');
  assert.equal(proposals.length, 0, 'Should return empty array');
});

// Test: Generates add_state_variable proposals for diverged fields (one per field)
test('Generates add_state_variable proposals for diverged fields (one per field)', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['count', 'phase'], first_divergence_index: 1, total_changes: 2 },
    per_state_diffs: [{
      index: 1,
      changes: [
        { key: 'count', oldValue: 3, newValue: 10 },
        { key: 'phase', oldValue: 'IDLE', newValue: 'ACTIVE' }
      ]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'describe bug');
  const svProposals = proposals.filter(p => p.type === 'add_state_variable');

  assert.equal(svProposals.length, 2, 'Should generate 2 state variable proposals');
  assert.equal(svProposals[0].target, 'count');
  assert.equal(svProposals[1].target, 'phase');
});

// Test: add_state_variable reasoning includes concrete oldValue and newValue from per_state_diffs
test('add_state_variable reasoning includes concrete oldValue and newValue', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['count'], first_divergence_index: 1, total_changes: 1 },
    per_state_diffs: [{
      index: 1,
      changes: [
        { key: 'count', oldValue: 3, newValue: 10 }
      ]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'test');
  const svProposal = proposals.find(p => p.type === 'add_state_variable');

  assert.ok(svProposal.reasoning.includes('3'), 'Reasoning should include oldValue 3');
  assert.ok(svProposal.reasoning.includes('10'), 'Reasoning should include newValue 10');
  assert.ok(svProposal.reasoning.includes('model produces'), 'Should mention model produces');
  assert.ok(svProposal.reasoning.includes('bug trace shows'), 'Should mention bug trace shows');
});

// Test: add_state_variable confidence is 0.9 when field name appears in bugContext, 0.7 when not
test('add_state_variable confidence context-aware (0.9 in bugContext, 0.7 otherwise)', (t) => {
  // Test 1: field appears in bugContext
  const stateDiff1 = {
    summary: { changed_fields: ['timeout'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'timeout', oldValue: 5, newValue: 10 }]
    }]
  };

  const proposals1 = generateCorrectionProposals(stateDiff1, 'The timeout field is critical');
  const sv1 = proposals1.find(p => p.type === 'add_state_variable');
  assert.equal(sv1.confidence, 0.9, 'Confidence should be 0.9 when field in bugContext');

  // Test 2: field does NOT appear in bugContext
  const stateDiff2 = {
    summary: { changed_fields: ['xyzField'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'xyzField', oldValue: 1, newValue: 2 }]
    }]
  };

  const proposals2 = generateCorrectionProposals(stateDiff2, 'The timeout is broken');
  const sv2 = proposals2.find(p => p.type === 'add_state_variable');
  assert.equal(sv2.confidence, 0.7, 'Confidence should be 0.7 when field NOT in bugContext');
});

// Test: Generates add_invariant proposal when per_state_diffs is non-empty
test('Generates add_invariant proposal when per_state_diffs is non-empty', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['field1'], first_divergence_index: 2, total_changes: 1 },
    per_state_diffs: [{
      index: 2,
      changes: [{ key: 'field1', oldValue: 0, newValue: 1 }]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'bug');
  const invProposal = proposals.find(p => p.type === 'add_invariant');

  assert.ok(invProposal, 'Should generate invariant proposal');
  assert.equal(invProposal.target, 'Inv_StateConstraint_2');
  assert.equal(invProposal.priority, 2);
});

// Test: add_invariant reasoning lists specific field:oldValue->newValue pairs, not generic text
test('add_invariant reasoning lists specific field:oldValue->newValue pairs', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['count', 'status'], first_divergence_index: 1, total_changes: 2 },
    per_state_diffs: [{
      index: 1,
      changes: [
        { key: 'count', oldValue: 5, newValue: 10 },
        { key: 'status', oldValue: 'idle', newValue: 'active' }
      ]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'bug');
  const invProposal = proposals.find(p => p.type === 'add_invariant');

  assert.ok(invProposal.reasoning.includes('count:5->10'), 'Should include field:oldValue->newValue pair');
  assert.ok(invProposal.reasoning.includes('status'), 'Should include field name');
  assert.ok(invProposal.reasoning.includes('2 field'), 'Should mention field count');
});

// Test: add_invariant confidence is 0.8 for 1-2 changed fields, 0.6 for 3+ fields
test('add_invariant confidence is 0.8 for 1-2 fields, 0.6 for 3+', (t) => {
  // Test 1: 2 changed fields (focused) -> confidence 0.8
  const stateDiff1 = {
    summary: { changed_fields: ['a', 'b'], first_divergence_index: 0, total_changes: 2 },
    per_state_diffs: [{
      index: 0,
      changes: [
        { key: 'a', oldValue: 1, newValue: 2 },
        { key: 'b', oldValue: 3, newValue: 4 }
      ]
    }]
  };

  const proposals1 = generateCorrectionProposals(stateDiff1, 'bug');
  const inv1 = proposals1.find(p => p.type === 'add_invariant');
  assert.equal(inv1.confidence, 0.8, 'Confidence should be 0.8 for 2 changed fields');

  // Test 2: 4 changed fields (diffuse) -> confidence 0.6
  const stateDiff2 = {
    summary: { changed_fields: ['a', 'b', 'c', 'd'], first_divergence_index: 0, total_changes: 4 },
    per_state_diffs: [{
      index: 0,
      changes: [
        { key: 'a', oldValue: 1, newValue: 2 },
        { key: 'b', oldValue: 3, newValue: 4 },
        { key: 'c', oldValue: 5, newValue: 6 },
        { key: 'd', oldValue: 7, newValue: 8 }
      ]
    }]
  };

  const proposals2 = generateCorrectionProposals(stateDiff2, 'bug');
  const inv2 = proposals2.find(p => p.type === 'add_invariant');
  assert.equal(inv2.confidence, 0.6, 'Confidence should be 0.6 for 4+ changed fields');
});

// Test: Generates add_temporal_property proposal with concrete terminal values
test('Generates add_temporal_property proposal with concrete terminal values', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['finalCount'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [
        { key: 'finalCount', oldValue: 99, newValue: 100 }
      ]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'bug');
  const tempProposal = proposals.find(p => p.type === 'add_temporal_property');

  assert.ok(tempProposal, 'Should generate temporal property proposal');
  assert.equal(tempProposal.target, 'FinalStateCorrectness');
  assert.equal(tempProposal.priority, 3);
  assert.ok(tempProposal.reasoning.includes('99'), 'Should include oldValue 99');
  assert.ok(tempProposal.reasoning.includes('100'), 'Should include newValue 100');
  assert.ok(tempProposal.example.includes('100'), 'Example should use concrete value 100');
});

// Test: Proposals are sorted by priority ascending (1 before 2 before 3)
test('Proposals are sorted by priority ascending', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['field1'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'field1', oldValue: 0, newValue: 1 }]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'bug');

  // Should generate PROP-SV (priority 1), PROP-INV (priority 2), PROP-TEMP (priority 3)
  assert.equal(proposals[0].type, 'add_state_variable', 'First proposal should be state variable (priority 1)');
  assert.equal(proposals[1].type, 'add_invariant', 'Second proposal should be invariant (priority 2)');
  assert.equal(proposals[2].type, 'add_temporal_property', 'Third proposal should be temporal (priority 3)');
});

// Test: Each proposal has all required fields
test('Each proposal has all required fields', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['x'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'x', oldValue: 0, newValue: 1 }]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'bug');

  for (const proposal of proposals) {
    assert.ok(proposal.id, 'Proposal should have id');
    assert.ok(proposal.type, 'Proposal should have type');
    assert.ok(proposal.target, 'Proposal should have target');
    assert.ok(proposal.confidence >= 0 && proposal.confidence <= 1, 'Proposal should have valid confidence');
    assert.ok(proposal.reasoning, 'Proposal should have reasoning');
    assert.ok(proposal.example, 'Proposal should have example');
    assert.ok(proposal.priority, 'Proposal should have priority');
    assert.ok(['low', 'medium', 'high'].includes(proposal.effort), 'Proposal should have valid effort');
  }
});

// Test: Multiple changed fields produce multiple PROP-SV proposals with sequential IDs
test('Multiple changed fields produce multiple PROP-SV proposals with sequential IDs', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['count', 'phase', 'timeout'], first_divergence_index: 0, total_changes: 3 },
    per_state_diffs: [{
      index: 0,
      changes: [
        { key: 'count', oldValue: 0, newValue: 1 },
        { key: 'phase', oldValue: 'A', newValue: 'B' },
        { key: 'timeout', oldValue: 10, newValue: 20 }
      ]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, 'bug');
  const svProposals = proposals.filter(p => p.type === 'add_state_variable');

  assert.equal(svProposals.length, 3, 'Should have 3 state variable proposals');
  assert.equal(svProposals[0].id, 'PROP-SV-0');
  assert.equal(svProposals[1].id, 'PROP-SV-1');
  assert.equal(svProposals[2].id, 'PROP-SV-2');
});

// Test: Handles empty bugContext string gracefully
test('Handles empty bugContext string gracefully', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['field1'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'field1', oldValue: 0, newValue: 1 }]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, '');
  const svProposal = proposals.find(p => p.type === 'add_state_variable');

  assert.ok(svProposal, 'Should generate proposal even with empty bugContext');
  assert.equal(svProposal.confidence, 0.7, 'Confidence should default to 0.7 with empty context');
  assert.ok(svProposal.reasoning, 'Reasoning should still be meaningful');
});

// Test: Handles null bugContext gracefully
test('Handles null bugContext gracefully', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['field1'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'field1', oldValue: 0, newValue: 1 }]
    }]
  };

  const proposals = generateCorrectionProposals(stateDiff, null);
  const svProposal = proposals.find(p => p.type === 'add_state_variable');

  assert.ok(svProposal, 'Should generate proposal with null bugContext');
  assert.equal(svProposal.confidence, 0.7, 'Confidence should default to 0.7 with null context');
});

// Test: Infers correct types from field values (Nat, BOOLEAN, STRING)
test('Infers correct types from field values', (t) => {
  // Test numeric type
  const diff1 = {
    summary: { changed_fields: ['count'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'count', oldValue: 5, newValue: 10 }]
    }]
  };
  const proposals1 = generateCorrectionProposals(diff1, 'bug');
  const sv1 = proposals1.find(p => p.type === 'add_state_variable');
  assert.ok(sv1.example.includes('Nat'), 'Should infer Nat type for numeric values');

  // Test boolean type
  const diff2 = {
    summary: { changed_fields: ['flag'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'flag', oldValue: true, newValue: false }]
    }]
  };
  const proposals2 = generateCorrectionProposals(diff2, 'bug');
  const sv2 = proposals2.find(p => p.type === 'add_state_variable');
  assert.ok(sv2.example.includes('BOOLEAN'), 'Should infer BOOLEAN type for boolean values');

  // Test string type
  const diff3 = {
    summary: { changed_fields: ['name'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{
      index: 0,
      changes: [{ key: 'name', oldValue: 'alice', newValue: 'bob' }]
    }]
  };
  const proposals3 = generateCorrectionProposals(diff3, 'bug');
  const sv3 = proposals3.find(p => p.type === 'add_state_variable');
  assert.ok(sv3.example.includes('STRING'), 'Should infer STRING type for string values');
});

// Test: Handles missing or invalid stateDiff gracefully
test('Handles missing or invalid stateDiff gracefully', (t) => {
  assert.deepEqual(generateCorrectionProposals(null, 'bug'), [], 'Should handle null stateDiff');
  assert.deepEqual(generateCorrectionProposals(undefined, 'bug'), [], 'Should handle undefined stateDiff');
  assert.deepEqual(generateCorrectionProposals({}, 'bug'), [], 'Should handle empty object');
});

// Test: Handles null summary without crashing (fail-open)
test('Handles null summary without crashing', (t) => {
  assert.deepEqual(
    generateCorrectionProposals({ summary: null, per_state_diffs: [] }, 'bug'),
    [],
    'Should treat null summary as empty and return []'
  );
  assert.deepEqual(
    generateCorrectionProposals({ summary: 'oops', per_state_diffs: [] }, 'bug'),
    [],
    'Should treat string summary as empty and return []'
  );
});

// Test: Handles per_state_diffs entry missing a changes array
test('Handles per_state_diffs entry missing changes array', (t) => {
  const stateDiff = {
    summary: { changed_fields: ['x'], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{ index: 0 }] // no `changes` property
  };
  assert.doesNotThrow(
    () => generateCorrectionProposals(stateDiff, 'bug'),
    'Should not throw when a per_state_diffs entry lacks a changes array'
  );
});

// Test: Handles non-string entry in changed_fields without crashing
test('Handles non-string entry in changed_fields', (t) => {
  const stateDiff = {
    summary: { changed_fields: [123], first_divergence_index: 0, total_changes: 1 },
    per_state_diffs: [{ index: 0, changes: [{ key: 123, oldValue: 1, newValue: 2 }] }]
  };
  assert.doesNotThrow(
    () => generateCorrectionProposals(stateDiff, 'bug'),
    'Should not throw when changed_fields contains a non-string element'
  );
});

// Test: Export verification
test('module exports generateCorrectionProposals', (t) => {
  assert.ok(typeof generateCorrectionProposals === 'function', 'generateCorrectionProposals should be exported');
});
