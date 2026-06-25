'use strict';

// Dogfood regression (F48 parse-but-not-shape): validate-invariant crashed with
// raw TypeErrors on wrong-shape requirements (null array element, a requirement
// missing `text`, a non-array `requirements`), and with a raw SyntaxError on a
// corrupt envelope. Each now degrades gracefully.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateInvariant, validateInvariantBatch } = require('./validate-invariant.cjs');
const SCRIPT = path.join(__dirname, 'validate-invariant.cjs');

describe('validate-invariant shape guards', () => {
  it('validateInvariant returns a shape verdict for null / missing-text reqs (no crash)', () => {
    assert.equal(validateInvariant(null).verdict, 'NON_INVARIANT');
    assert.equal(validateInvariant(null).layer, 'shape');
    assert.equal(validateInvariant({ id: 'R1' }).layer, 'shape'); // no `text`
    assert.equal(validateInvariant({ id: 'R2', text: 42 }).layer, 'shape'); // non-string text
  });

  it('validateInvariantBatch survives null elements and non-array input', () => {
    const out = validateInvariantBatch([null, { id: 'R1' }, { id: 'R2', text: 'The system MUST persist state.' }]);
    assert.equal(out.length, 3);
    assert.equal(out[0].verdict, 'NON_INVARIANT'); // null element
    assert.equal(out[2].verdict, 'INVARIANT');     // valid invariant
    assert.deepEqual(validateInvariantBatch('garbage'), []); // non-array → []
    assert.deepEqual(validateInvariantBatch(null), []);
  });

  it('CLI emits a clean error (not a raw SyntaxError) on a corrupt envelope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-vi-'));
    try {
      const envPath = path.join(dir, 'env.json');
      fs.writeFileSync(envPath, '{bad json');
      let err;
      try {
        execFileSync(process.execPath, [SCRIPT, '--batch', `--envelope=${envPath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'corrupt envelope must exit non-zero');
      const stderr = String(err.stderr || '');
      assert.match(stderr, /not valid JSON/, 'must be a clean message');
      assert.doesNotMatch(stderr, /at JSON\.parse/, 'must NOT leak a raw stack trace');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
