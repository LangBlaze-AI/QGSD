'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveNeighbors, buildReverseEdges } = require('../bin/resolve-proximity-neighbors.cjs');

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeIndex(nodes) {
  return { schema_version: '1', nodes };
}

// Minimal index: A -> concept -> B (2-hop path)
const twoHopIndex = makeIndex({
  'formal_module::model-a': {
    type: 'formal_module', id: 'model-a',
    edges: [{ to: 'concept::shared-concept', rel: 'described_by', source: 'test' }]
  },
  'concept::shared-concept': {
    type: 'concept', id: 'shared-concept',
    edges: [{ to: 'formal_module::model-b', rel: 'describes', source: 'test' }]
  },
  'formal_module::model-b': {
    type: 'formal_module', id: 'model-b',
    edges: []
  }
});

// Index with direct 1-hop neighbor
const oneHopIndex = makeIndex({
  'formal_module::model-a': {
    type: 'formal_module', id: 'model-a',
    edges: [
      { to: 'formal_module::model-c', rel: 'shares_property', source: 'test' },
      { to: 'concept::shared-concept', rel: 'described_by', source: 'test' }
    ]
  },
  'formal_module::model-c': {
    type: 'formal_module', id: 'model-c',
    edges: []
  },
  'concept::shared-concept': {
    type: 'concept', id: 'shared-concept',
    edges: [{ to: 'formal_module::model-b', rel: 'describes', source: 'test' }]
  },
  'formal_module::model-b': {
    type: 'formal_module', id: 'model-b',
    edges: []
  }
});

// Index for reverse-edge testing: B -> concept, concept has NO forward edge to A
// But A -> concept exists, so reverse traversal from concept should find A
const reverseEdgeIndex = makeIndex({
  'formal_module::model-a': {
    type: 'formal_module', id: 'model-a',
    edges: [{ to: 'concept::bridge', rel: 'described_by', source: 'test' }]
  },
  'concept::bridge': {
    type: 'concept', id: 'bridge',
    edges: [] // NO forward edge to model-b
  },
  'formal_module::model-b': {
    type: 'formal_module', id: 'model-b',
    edges: [{ to: 'concept::bridge', rel: 'described_by', source: 'test' }]
  }
});

// Large index with many neighbors for cap testing
function makeLargeIndex(count) {
  const nodes = {
    'formal_module::start': {
      type: 'formal_module', id: 'start',
      edges: Array.from({ length: count }, (_, i) => ({
        to: `concept::concept-${i}`, rel: 'described_by', source: 'test'
      }))
    }
  };
  for (let i = 0; i < count; i++) {
    nodes[`concept::concept-${i}`] = {
      type: 'concept', id: `concept-${i}`,
      edges: [{ to: `formal_module::neighbor-${i}`, rel: 'describes', source: 'test' }]
    };
    nodes[`formal_module::neighbor-${i}`] = {
      type: 'formal_module', id: `neighbor-${i}`,
      edges: []
    };
  }
  return makeIndex(nodes);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resolve-proximity-neighbors', () => {

  it('finds 2-hop neighbors through shared concepts', () => {
    const result = resolveNeighbors(twoHopIndex, 'model-a');
    assert.strictEqual(result.neighbors.length, 1);
    assert.strictEqual(result.neighbors[0].id, 'model-b');
    assert.strictEqual(result.neighbors[0].hop_distance, 2);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('finds 1-hop direct neighbors', () => {
    const result = resolveNeighbors(oneHopIndex, 'model-a');
    const modelC = result.neighbors.find(n => n.id === 'model-c');
    assert.ok(modelC, 'model-c should be found as 1-hop neighbor');
    assert.strictEqual(modelC.hop_distance, 1);
  });

  it('uses bidirectional traversal (reverse edges)', () => {
    // model-b -> concept::bridge, and model-a -> concept::bridge
    // Starting from model-b: forward edge to concept::bridge,
    // then reverse edge from concept::bridge back to model-a
    const result = resolveNeighbors(reverseEdgeIndex, 'model-b');
    const modelA = result.neighbors.find(n => n.id === 'model-a');
    assert.ok(modelA, 'model-a should be found via reverse edge traversal');
    assert.strictEqual(modelA.hop_distance, 2);
  });

  it('respects maxHops=1 (only 1-hop neighbors)', () => {
    const result = resolveNeighbors(oneHopIndex, 'model-a', { maxHops: 1 });
    // Only model-c is 1-hop; model-b is 2-hop and should be excluded
    const modelC = result.neighbors.find(n => n.id === 'model-c');
    const modelB = result.neighbors.find(n => n.id === 'model-b');
    assert.ok(modelC, 'model-c (1-hop) should be found');
    assert.strictEqual(modelB, undefined, 'model-b (2-hop) should NOT be found with maxHops=1');
  });

  it('caps at maxNeighbors', () => {
    const largeIndex = makeLargeIndex(15);
    const result = resolveNeighbors(largeIndex, 'start', { maxNeighbors: 10 });
    assert.strictEqual(result.neighbors.length, 10);
    assert.ok(result.warnings.some(w => w.includes('Capped from 15 to 10')));
  });

  it('sorts 1-hop before 2-hop when capping', () => {
    // Create index with both 1-hop and 2-hop neighbors
    const mixedIndex = makeIndex({
      'formal_module::start': {
        type: 'formal_module', id: 'start',
        edges: [
          { to: 'formal_module::direct-1', rel: 'shares_property', source: 'test' },
          { to: 'concept::bridge', rel: 'described_by', source: 'test' }
        ]
      },
      'formal_module::direct-1': {
        type: 'formal_module', id: 'direct-1',
        edges: []
      },
      'concept::bridge': {
        type: 'concept', id: 'bridge',
        edges: [{ to: 'formal_module::indirect-1', rel: 'describes', source: 'test' }]
      },
      'formal_module::indirect-1': {
        type: 'formal_module', id: 'indirect-1',
        edges: []
      }
    });
    const result = resolveNeighbors(mixedIndex, 'start', { maxNeighbors: 2 });
    assert.strictEqual(result.neighbors[0].id, 'direct-1');
    assert.strictEqual(result.neighbors[0].hop_distance, 1);
    assert.strictEqual(result.neighbors[1].hop_distance, 2);
  });

  it('returns warning when model not found', () => {
    const result = resolveNeighbors(twoHopIndex, 'nonexistent-model');
    assert.strictEqual(result.neighbors.length, 0);
    assert.ok(result.warnings.some(w => w.includes('not found')));
  });

  it('returns warning when index is null', () => {
    const result = resolveNeighbors(null, 'model-a');
    assert.strictEqual(result.neighbors.length, 0);
    assert.ok(result.warnings.some(w => w.includes('proximity-index.json')));
  });

  it('buildReverseEdges creates correct reverse mapping', () => {
    const nodes = {
      'A': { edges: [{ to: 'B', rel: 'owns', source: 'test' }] },
      'B': { edges: [] }
    };
    const reverse = buildReverseEdges(nodes);
    assert.ok(reverse['B'], 'B should have reverse entries');
    assert.strictEqual(reverse['B'].length, 1);
    assert.strictEqual(reverse['B'][0].from, 'A');
    assert.strictEqual(reverse['B'][0].rel, 'owns');
  });

  it('handles nodes with no edges gracefully', () => {
    const sparseIndex = makeIndex({
      'formal_module::lonely': {
        type: 'formal_module', id: 'lonely',
        edges: []
      }
    });
    const result = resolveNeighbors(sparseIndex, 'lonely');
    assert.strictEqual(result.neighbors.length, 0);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('skips null node values in the index without throwing', () => {
    const idx = makeIndex({
      'formal_module::model-a': {
        type: 'formal_module', id: 'model-a',
        edges: [{ to: 'concept::shared-concept', rel: 'described_by', source: 'test' }]
      },
      'concept::shared-concept': {
        type: 'concept', id: 'shared-concept',
        edges: [{ to: 'formal_module::model-b', rel: 'describes', source: 'test' }]
      },
      'formal_module::model-b': {
        type: 'formal_module', id: 'model-b', edges: []
      },
      'formal_module::corrupt': null
    });
    let result;
    assert.doesNotThrow(() => { result = resolveNeighbors(idx, 'model-a'); });
    assert.ok(result.neighbors.find(n => n.id === 'model-b'), 'model-b should still resolve');
  });

  it('ignores edges with a missing/non-string `to` without throwing', () => {
    const idx = makeIndex({
      'formal_module::model-a': {
        type: 'formal_module', id: 'model-a',
        edges: [{ rel: 'shares_property', source: 'test' }] // no `to`
      }
    });
    let result;
    assert.doesNotThrow(() => { result = resolveNeighbors(idx, 'model-a'); });
    assert.strictEqual(result.neighbors.length, 0);
  });

  it('buildReverseEdges handles prototype-pollution keys (__proto__) safely', () => {
    let reverse;
    assert.doesNotThrow(() => {
      reverse = buildReverseEdges({
        'A': { edges: [{ to: '__proto__', rel: 'owns', source: 'test' }] }
      });
    });
    assert.ok(Array.isArray(reverse['__proto__']), 'reverse should store __proto__ as an own array key');
    assert.strictEqual(reverse['__proto__'][0].from, 'A');
  });

});
