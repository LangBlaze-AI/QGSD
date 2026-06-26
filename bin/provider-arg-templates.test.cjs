'use strict';

// ARGS-TEMPLATE-01 regression suite.
//
// The install-time auto-detect path wrote providers.json entries WITHOUT an
// args_template field; every consumer then did `provider.args_template.map(...)`
// unguarded, so quorum dispatch crashed for ALL slots with an opaque
// "Cannot read properties of undefined (reading 'map')". This suite locks in:
//   1. the canonical per-family template map,
//   2. the explicit-field-wins / family-default / null resolution order,
//   3. that call-quorum-slot's buildSpawnArgs falls back to the family default
//      and fails LOUD (clear message) on an unknown family — never the bare crash.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { FAMILY_ARGS_TEMPLATE, argsTemplateFor, resolveArgsTemplate } = require('./provider-arg-templates.cjs');
const { buildSpawnArgs } = require('./call-quorum-slot.cjs');

describe('provider-arg-templates: canonical map', () => {
  it('has a template for every quorum CLI family incl. antigravity', () => {
    for (const fam of ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity']) {
      assert.ok(Array.isArray(FAMILY_ARGS_TEMPLATE[fam]), `${fam} must have a template`);
      assert.ok(FAMILY_ARGS_TEMPLATE[fam].includes('{prompt}'), `${fam} template must carry {prompt}`);
    }
  });

  it('codex uses exec; antigravity uses -p print mode', () => {
    assert.deepEqual(argsTemplateFor('codex'), ['exec', '{prompt}']);
    assert.deepEqual(argsTemplateFor('antigravity'), ['-p', '{prompt}']);
  });

  it('argsTemplateFor returns a fresh copy (no shared mutation) and null for unknown', () => {
    const a = argsTemplateFor('gemini');
    a.push('MUTATED');
    assert.ok(!argsTemplateFor('gemini').includes('MUTATED'), 'must return a defensive copy');
    assert.equal(argsTemplateFor('nope'), null);
  });
});

describe('resolveArgsTemplate: resolution order', () => {
  it('explicit args_template on the provider wins', () => {
    const p = { mainTool: 'gemini', args_template: ['--custom', '{prompt}'] };
    assert.deepEqual(resolveArgsTemplate(p), ['--custom', '{prompt}']);
  });
  it('falls back to the family default by mainTool', () => {
    assert.deepEqual(resolveArgsTemplate({ mainTool: 'codex' }), ['exec', '{prompt}']);
  });
  it('returns null when neither explicit nor a known family is present', () => {
    assert.equal(resolveArgsTemplate({ mainTool: 'mystery' }), null);
    assert.equal(resolveArgsTemplate({}), null);
  });
});

describe('buildSpawnArgs: no crash on a provider missing args_template', () => {
  it('a slot with no args_template falls back to the family template (the crash regression)', () => {
    const { args } = buildSpawnArgs({ name: 'gemini-1', mainTool: 'gemini' }, 'HELLO');
    assert.deepEqual(args, ['-p', 'HELLO']);
  });

  it('antigravity slot (no args_template) dispatches via -p', () => {
    const { args } = buildSpawnArgs({ name: 'antigravity-1', mainTool: 'antigravity', cli: '/x/agy' }, 'HI');
    assert.deepEqual(args, ['-p', 'HI']);
  });

  it('an explicit args_template is still honored', () => {
    const { args } = buildSpawnArgs({ name: 'codex-1', mainTool: 'codex', args_template: ['exec', '{prompt}'] }, 'Q');
    assert.deepEqual(args, ['exec', 'Q']);
  });

  it('an unknown family with no template fails LOUD, not with an opaque TypeError', () => {
    assert.throws(
      () => buildSpawnArgs({ name: 'weird-1', mainTool: 'weird' }, 'x'),
      (e) => /no args_template/.test(e.message) && !/undefined \(reading 'map'\)/.test(e.message),
      'must throw a clear, actionable error'
    );
  });
});
