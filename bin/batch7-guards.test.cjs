'use strict';

// Dogfood Batch 7: native-ML SIGABRT containment (--no-l3) + falsy-zero CLI guards.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { renderConstraintSummary } = require('./model-constrained-fix.cjs');
const { aggregateBySlot } = require('./token-dashboard.cjs');

describe('falsy-zero: --max-constraints / token coercion', () => {
  it('renderConstraintSummary honors an explicit 0 (|| 5 used to coerce it up)', () => {
    const cs = [{ a: 1 }, { a: 2 }, { a: 3 }];
    assert.equal(renderConstraintSummary(cs, 0).constraints.length, 0, 'max=0 → 0, not 5');
    assert.equal(renderConstraintSummary(cs, 2).constraints.length, 2);
    assert.equal(renderConstraintSummary(cs, undefined).constraints.length, 3, 'default 5, capped at length');
  });

  it('token aggregation coerces string token counts to numbers (no $NaN)', () => {
    const agg = aggregateBySlot([{ slot: 's1', input_tokens: '10', output_tokens: '5', cache_read_input_tokens: '2' }]);
    const v = agg.get('s1');
    assert.equal(v.input, 10, 'string "10" must sum as the number 10, not concatenate / NaN');
    assert.equal(v.output, 5);
    assert.ok(Number.isFinite(v.input) && Number.isFinite(v.output));
  });
});

describe('SIGABRT containment: plan-phase / quick pass --no-l3 to formal-scope-scan', () => {
  // Layer 3 (HuggingFace transformers) can fatally SIGABRT (uncatchable C++ mutex)
  // on a zero-keyword-match description, taking down /nf:plan-phase and /nf:quick.
  // Both must invoke formal-scope-scan with --no-l3.
  for (const rel of ['../core/workflows/plan-phase.md', '../core/workflows/quick.md']) {
    it(`${path.basename(rel)} invokes formal-scope-scan with --no-l3`, () => {
      const md = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const invocations = md.match(/node bin\/formal-scope-scan\.cjs[^\n]*/g) || [];
      assert.ok(invocations.length > 0, 'must invoke formal-scope-scan');
      for (const inv of invocations) {
        assert.match(inv, /--no-l3/, `formal-scope-scan invocation must pass --no-l3: ${inv}`);
      }
    });
  }
});
