'use strict';
// bin/skill-eval-lint.test.cjs
// Tests the inline-eval env/arg-placement standard enforced by lint-isolation
// (the required "Lint" CI check). The detector must flag env/arg AFTER an eval
// and accept env BEFORE it (plus redirects/operators), and the live repo must
// already satisfy the standard.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findEvalTrailingViolations } = require('./skill-eval-lint.cjs');

const E = 'node -e ' + '"'; // avoid the literal in this file's own text

describe('skill-eval-lint detector', () => {
  it('flags env AFTER the eval (F1)', () => {
    const v = findEvalTrailingViolations(`X=$(${E}process.env.A" A="1")`, 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'eval-env-after');
  });

  it('flags a flag/positional AFTER the eval (F21)', () => {
    const v = findEvalTrailingViolations(`${E}code" --force`, 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'eval-arg-after');
  });

  it('flags `-- "$X"` positional args after the eval', () => {
    const v = findEvalTrailingViolations(`${E}code" -- "$REQ_ID"`, 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'eval-arg-after');
  });

  it('flags a whitespace-separated DOUBLE-quoted arg after the eval (F21)', () => {
    const v = findEvalTrailingViolations(`R=$(${E}process.argv[1]" "$ENVELOPE_PATH" 2>&1)`, 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'eval-arg-after');
  });

  it('flags a whitespace-separated SINGLE-quoted arg after the eval (F21)', () => {
    const v = findEvalTrailingViolations(`${E}process.argv[1]" '<intent_json>'`, 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'eval-arg-after');
  });

  it('does NOT flag an immediately-adjacent quote (shell string concatenation, no space)', () => {
    // `node -e "a""b"` → the eval string is `ab`; the second quote is not a
    // separate positional arg, so it must not be treated as arg-after.
    assert.equal(findEvalTrailingViolations(`${E}a""b"`, 'f.md').length, 0);
    assert.equal(findEvalTrailingViolations(`${E}a"'b'`, 'f.md').length, 0);
  });

  it('accepts env BEFORE the eval', () => {
    assert.equal(findEvalTrailingViolations(`A="1" ${E}process.env.A"`, 'f.md').length, 0);
  });

  it('accepts a redirect / operator / closer after the eval', () => {
    assert.equal(findEvalTrailingViolations(`${E}code" 2>/dev/null`, 'f.md').length, 0);
    assert.equal(findEvalTrailingViolations(`${E}code" || echo x`, 'f.md').length, 0);
    assert.equal(findEvalTrailingViolations(`R=$(${E}code")`, 'f.md').length, 0);
    assert.equal(findEvalTrailingViolations(`${E}code"`, 'f.md').length, 0);
  });

  it('honors \\" escapes inside the eval body', () => {
    // the inner \" must not be mistaken for the closing quote
    assert.equal(findEvalTrailingViolations(`${E}console.log(\\"hi\\")" 2>/dev/null`, 'f.md').length, 0);
  });

  it('does NOT flag a trailing CR from CRLF line endings', () => {
    assert.equal(findEvalTrailingViolations(`${E}code"\r\nNEXT`, 'f.md').length, 0);
    // and still flags a real arg even with CRLF
    const v = findEvalTrailingViolations(`${E}code" --force\r\nNEXT`, 'f.md');
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'eval-arg-after');
  });

  it('fails open (returns []) on non-string text instead of throwing', () => {
    assert.deepEqual(findEvalTrailingViolations(null, 'f.md'), []);
    assert.deepEqual(findEvalTrailingViolations(undefined, 'f.md'), []);
    assert.deepEqual(findEvalTrailingViolations(123, 'f.md'), []);
  });

  it('accepts a trailing shell comment after the eval', () => {
    assert.equal(findEvalTrailingViolations(`${E}code" # explanatory note`, 'f.md').length, 0);
  });
});

describe('the live skill/workflow tree satisfies the standard', () => {
  it('has zero env/arg-after-eval violations across commands/nf + core/workflows', () => {
    const dirs = ['commands/nf', 'core/workflows'].map(d => path.join(__dirname, '..', d));
    const all = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
        all.push(...findEvalTrailingViolations(fs.readFileSync(path.join(dir, f), 'utf8'), f));
      }
    }
    assert.deepEqual(all, [], `unexpected violations: ${JSON.stringify(all, null, 2)}`);
  });
});
