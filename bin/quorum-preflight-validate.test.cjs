'use strict';

// P5 — providers.json schema validator. There was no gate on the config, so an
// unspawnable subprocess slot (no cli/mainTool) or an http slot missing baseUrl/apiKeyEnv
// only surfaced as a spawn crash at dispatch. This catches drift up front.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateProviders } = require('./quorum-preflight.cjs');

describe('validateProviders — providers.json schema gate', () => {
  it('accepts a well-formed subprocess slot with a deep_probe', () => {
    const r = validateProviders([
      { name: 'codex-1', type: 'subprocess', cli: '/usr/bin/codex', deep_probe: { prompt: 'x', expect: 'y' } },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 0);
  });

  it('errors when a subprocess slot has no spawn target (cli AND mainTool absent)', () => {
    const r = validateProviders([{ name: 'broken-1', type: 'subprocess' }]);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /broken-1: subprocess.*no spawn target/);
  });

  it('accepts a subprocess slot with only mainTool (cli optional)', () => {
    const r = validateProviders([{ name: 'ok-1', type: 'subprocess', mainTool: 'codex', deep_probe: {} }]);
    assert.equal(r.ok, true);
  });

  it('errors when an http slot is missing baseUrl / apiKeyEnv', () => {
    const r = validateProviders([{ name: 'api-1', type: 'http', deep_probe: {} }]);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /api-1: http slot missing baseUrl/);
    assert.match(r.errors.join(), /api-1: http slot missing apiKeyEnv/);
  });

  it('warns (not errors) when an inference slot lacks a deep_probe — the antigravity-1 shape', () => {
    // antigravity-1's live entry has cli but no deep_probe → it failed opaquely as
    // BINARY_MISSING instead of being inference-health-gated.
    const r = validateProviders([{ name: 'antigravity-1', type: 'subprocess', cli: '/x/agy' }]);
    assert.equal(r.ok, true); // spawnable, so not an error
    assert.match(r.warnings.join(), /antigravity-1: no deep_probe/);
  });

  it('errors on a missing type and on duplicate names', () => {
    const r = validateProviders([
      { name: 'x' },
      { name: 'dupe', type: 'subprocess', cli: '/a', deep_probe: {} },
      { name: 'dupe', type: 'subprocess', cli: '/b', deep_probe: {} },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /x: missing type/);
    assert.match(r.errors.join(), /duplicate provider name: dupe/);
  });

  it('tolerates a non-array / empty input (fail-open)', () => {
    assert.equal(validateProviders(null).ok, true);
    assert.equal(validateProviders([]).ok, true);
  });
});
