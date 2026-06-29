const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { reach, findPath, resolveNodeKey, suggestSimilarKeys } = require('./formal-query.cjs');

const INDEX_PATH = path.join(process.cwd(), '.planning', 'formal', 'proximity-index.json');

function loadIndex() {
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

describe('formal-query CLI', () => {

  describe('reach', () => {
    it('should find nodes at depth=1', () => {
      const index = loadIndex();
      const result = reach(index, 'code_file::hooks/nf-circuit-breaker.js', 1, null);
      assert.ok(result[1], 'should have depth 1 results');
      assert.ok(result[1].length > 0, 'should have at least one neighbor');
    });

    it('should find nodes at depth=2', () => {
      const index = loadIndex();
      const result = reach(index, 'code_file::hooks/nf-circuit-breaker.js', 2, null);
      const totalDepth1 = (result[1] || []).length;
      const totalDepth2 = (result[2] || []).length;
      assert.ok(totalDepth1 + totalDepth2 > 0, 'should have some results');
    });

    it('should filter by type', () => {
      const index = loadIndex();
      const result = reach(index, 'code_file::hooks/nf-circuit-breaker.js', 3, ['invariant', 'requirement']);
      for (const [, nodes] of Object.entries(result)) {
        for (const n of nodes) {
          assert.ok(
            n.type === 'invariant' || n.type === 'requirement',
            `node type should be invariant or requirement, got ${n.type}`
          );
        }
      }
    });
  });

  describe('findPath', () => {
    it('should find path between connected nodes', () => {
      const index = loadIndex();
      const p = findPath(index, 'code_file::hooks/nf-circuit-breaker.js', 'formal_module::breaker');
      assert.ok(p, 'should find a path');
      assert.ok(p.length >= 2, 'path should have at least 2 steps');
      assert.equal(p[0].key, 'code_file::hooks/nf-circuit-breaker.js');
      assert.equal(p[p.length - 1].key, 'formal_module::breaker');
    });

    it('should return null for disconnected nodes', () => {
      const index = loadIndex();
      const p = findPath(index, 'code_file::hooks/nf-circuit-breaker.js', 'nonexistent::fake');
      assert.equal(p, null);
    });

    it('should return single-step path for same node', () => {
      const index = loadIndex();
      const p = findPath(index, 'code_file::hooks/nf-circuit-breaker.js', 'code_file::hooks/nf-circuit-breaker.js');
      assert.ok(p);
      assert.equal(p.length, 1);
    });
  });

  describe('resolveNodeKey', () => {
    it('should resolve exact key', () => {
      const index = loadIndex();
      const result = resolveNodeKey(index, 'code_file::hooks/nf-circuit-breaker.js');
      assert.equal(result, 'code_file::hooks/nf-circuit-breaker.js');
    });

    it('should try common prefixes for bare ids', () => {
      const index = loadIndex();
      const result = resolveNodeKey(index, 'Depth');
      assert.equal(result, 'constant::Depth');
    });

    it('should return null for unknown key', () => {
      const index = loadIndex();
      const result = resolveNodeKey(index, 'zzz_completely_nonexistent_zzz');
      assert.equal(result, null);
    });
  });

  describe('suggestSimilarKeys', () => {
    it('should suggest keys containing substring', () => {
      const index = loadIndex();
      const suggestions = suggestSimilarKeys(index, 'circuit-breaker');
      assert.ok(suggestions.length > 0, 'should have suggestions');
      for (const s of suggestions) {
        assert.ok(s.toLowerCase().includes('circuit-breaker'), `suggestion ${s} should contain circuit-breaker`);
      }
    });
  });

  describe('impact convenience wrapper (CLI)', () => {
    it('should return valid JSON for a known code file', () => {
      const result = execFileSync('node', ['bin/formal-query.cjs', 'impact', 'hooks/nf-circuit-breaker.js', '--json'], { encoding: 'utf8' });
      const parsed = JSON.parse(result);
      // Impact returns filtered results; may be empty if graph doesn't connect
      // code_file to invariant/requirement/formal_model/test_file within 3 hops.
      // Verify structure is correct (object with depth keys)
      assert.equal(typeof parsed, 'object');
      for (const n of Object.values(parsed).flat()) {
        assert.ok(
          ['invariant', 'requirement', 'formal_model', 'test_file'].includes(n.type),
          `unexpected type: ${n.type}`
        );
      }
    });

    it('should use reach internally with correct filter', () => {
      const index = loadIndex();
      const filter = ['invariant', 'requirement', 'formal_model', 'test_file'];
      const result = reach(index, 'code_file::hooks/nf-circuit-breaker.js', 3, filter);
      // Verify all returned nodes match filter types
      for (const nodes of Object.values(result)) {
        for (const n of nodes) {
          assert.ok(filter.includes(n.type), `unexpected type in impact: ${n.type}`);
        }
      }
    });
  });

  describe('coverage convenience wrapper (CLI)', () => {
    it('should return results for a known requirement', () => {
      const result = execFileSync('node', ['bin/formal-query.cjs', 'coverage', 'SAFE-01', '--json'], { encoding: 'utf8' });
      const parsed = JSON.parse(result);
      const allNodes = Object.values(parsed).flat();
      assert.ok(allNodes.length > 0, 'should find coverage chain elements');
    });
  });

  describe('stats (CLI)', () => {
    it('should print node and edge counts', () => {
      const result = execFileSync('node', ['bin/formal-query.cjs', 'stats'], { encoding: 'utf8' });
      assert.ok(result.includes('Total nodes:'), 'should show total nodes');
      assert.ok(result.includes('Total edges:'), 'should show total edges');
      assert.ok(result.includes('Nodes by type:'), 'should show type breakdown');
    });
  });

  describe('node not found error handling (CLI)', () => {
    it('should exit 1 for unknown node', () => {
      try {
        execFileSync('node', ['bin/formal-query.cjs', 'neighbors', 'nonexistent::fake_key_xyz'], { encoding: 'utf8', stdio: 'pipe' });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err.status === 1, 'should exit with code 1');
        assert.ok(err.stderr.includes('not found'), 'should mention not found');
      }
    });
  });

  describe('index loaded via fs.readFileSync', () => {
    it('formal-query.cjs should not use require for proximity-index.json', () => {
      const source = fs.readFileSync(path.join(__dirname, 'formal-query.cjs'), 'utf8');
      assert.ok(!source.includes("require('./proximity-index"), 'should not require proximity-index');
      assert.ok(!source.includes("require('../.planning"), 'should not require from .planning');
      assert.ok(source.includes('readFileSync'), 'should use readFileSync');
    });
  });

  describe('resolveNodeKey prototype-key hardening', () => {
    it('should return null for __proto__ (inherited, not a real node)', () => {
      const index = { nodes: { 'real::node': { type: 'x', edges: [] } } };
      assert.equal(resolveNodeKey(index, '__proto__'), null);
    });

    it('should return null for constructor', () => {
      const index = { nodes: {} };
      assert.equal(resolveNodeKey(index, 'constructor'), null);
    });
  });

  describe('reach malformed-node hardening', () => {
    it('should not crash on a node missing an edges array', () => {
      const index = { nodes: { 'a::x': { type: 'code_file' } } };
      const result = reach(index, 'a::x', 2, null);
      assert.deepEqual(result, {});
    });
  });

  describe('findPath malformed-node hardening', () => {
    it('should not crash when a node lacks an edges array', () => {
      const index = { nodes: { 'a::x': { type: 'code_file' }, 'b::y': { type: 'x', edges: [] } } };
      const p = findPath(index, 'a::x', 'b::y');
      assert.equal(p, null);
    });
  });
});
