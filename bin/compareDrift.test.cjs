'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compareDrift } = require('./compareDrift.cjs');

describe('compareDrift', () => {
  it('returns true when measured_value differs from formalExpected (numeric)', () => {
    const entry = { meta: { measured_value: 100 } };
    assert.strictEqual(compareDrift(entry, 200), true);
  });

  it('returns false when measured_value equals formalExpected (numeric)', () => {
    const entry = { meta: { measured_value: 100 } };
    assert.strictEqual(compareDrift(entry, 100), false);
  });

  it('returns false when formalExpected is null (fail-open)', () => {
    const entry = { meta: { measured_value: 100 } };
    assert.strictEqual(compareDrift(entry, null), false);
  });

  it('returns false when measured_value is null (fail-open)', () => {
    const entry = { meta: { measured_value: null } };
    assert.strictEqual(compareDrift(entry, 200), false);
  });

  it('returns false when both are null', () => {
    const entry = { meta: { measured_value: null } };
    assert.strictEqual(compareDrift(entry, null), false);
  });

  it('returns true when string values differ', () => {
    const entry = { meta: { measured_value: 'high' } };
    assert.strictEqual(compareDrift(entry, 'low'), true);
  });

  it('returns false when string values match', () => {
    const entry = { meta: { measured_value: 'ok' } };
    assert.strictEqual(compareDrift(entry, 'ok'), false);
  });

  it('returns true for close-but-not-equal numbers (strict equality)', () => {
    const entry = { meta: { measured_value: 99.9 } };
    assert.strictEqual(compareDrift(entry, 100), true);
  });

  it('returns false when entry has no meta', () => {
    const entry = {};
    assert.strictEqual(compareDrift(entry, 100), false);
  });

  it('returns false when entry is null', () => {
    assert.strictEqual(compareDrift(null, 100), false);
  });

  it('returns false when meta has no measured_value key', () => {
    const entry = { meta: {} };
    assert.strictEqual(compareDrift(entry, 100), false);
  });

  it('returns false when both measured and expected are NaN (fail-open on unreliable measurement)', () => {
    const entry = { meta: { measured_value: NaN } };
    assert.strictEqual(compareDrift(entry, NaN), false);
  });

  it('returns false when measured_value is NaN (fail-open, garbage measurement)', () => {
    const entry = { meta: { measured_value: NaN } };
    assert.strictEqual(compareDrift(entry, 100), false);
  });
});
