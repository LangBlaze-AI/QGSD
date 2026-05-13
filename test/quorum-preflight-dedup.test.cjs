#!/usr/bin/env node
'use strict';

/**
 * quorum-preflight-dedup.test.cjs — DEDUP-01 composite (model, display_provider) tests
 *
 * Verifies that Daintree fan-out slots which clone the vanilla's model string
 * but route to a different upstream (via ANTHROPIC_BASE_URL override) stay
 * distinct from the vanilla — i.e. claude-1, claude-z-ai, claude-minimax all
 * remain primary instead of collapsing to one.
 *
 * Run: node --test test/quorum-preflight-dedup.test.cjs
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { dedupBySlotIdentity } = require('../bin/quorum-preflight.cjs');

function providerMap(providers) {
  return new Map(providers.map(p => [p.name, p]));
}

describe('dedupBySlotIdentity (DEDUP-01)', () => {
  it('keeps all slots when model+display_provider tuples are distinct', () => {
    const providers = [
      { name: 'claude-1', model: 'claude-opus-4-6', display_provider: 'Anthropic' },
      { name: 'codex-1',  model: 'gpt-5.4',         display_provider: 'OpenAI' },
      { name: 'gemini-1', model: 'gemini-3-flash',  display_provider: 'Google' },
    ];
    const { kept, demoted } = dedupBySlotIdentity(
      providers.map(p => p.name),
      providerMap(providers),
    );
    assert.deepStrictEqual(kept, ['claude-1', 'codex-1', 'gemini-1']);
    assert.deepStrictEqual(demoted, []);
  });

  it('demotes a second slot when both model AND display_provider match', () => {
    const providers = [
      { name: 'claude-1',     model: 'claude-opus-4-6', display_provider: 'Anthropic' },
      { name: 'claude-1-alt', model: 'claude-opus-4-6', display_provider: 'Anthropic' },
    ];
    const { kept, demoted } = dedupBySlotIdentity(
      providers.map(p => p.name),
      providerMap(providers),
    );
    assert.deepStrictEqual(kept, ['claude-1']);
    assert.deepStrictEqual(demoted, ['claude-1-alt']);
  });

  it('keeps fan-out slots distinct when display_provider differs (Daintree case)', () => {
    // Real-world setup from `/nf:link-daintree`: three slots all declaring
    // model=claude-opus-4-6 but routing to three different upstreams via
    // ANTHROPIC_BASE_URL. Before this fix, DEDUP-01 keyed on model alone and
    // collapsed the two fan-out slots to backup. After the fix, the distinct
    // display_provider keeps all three primary.
    const providers = [
      { name: 'claude-1',       model: 'claude-opus-4-6', display_provider: 'Anthropic' },
      { name: 'claude-z-ai',    model: 'claude-opus-4-6', display_provider: 'Z.AI' },
      { name: 'claude-minimax', model: 'claude-opus-4-6', display_provider: 'MiniMax' },
    ];
    const { kept, demoted } = dedupBySlotIdentity(
      providers.map(p => p.name),
      providerMap(providers),
    );
    assert.deepStrictEqual(kept, ['claude-1', 'claude-z-ai', 'claude-minimax']);
    assert.deepStrictEqual(demoted, []);
  });

  it('falls back to provider field when display_provider is missing', () => {
    // Older installs may not have display_provider populated. Use `provider`
    // (the lower-case canonical family) as a fallback so dedup still works.
    const providers = [
      { name: 'a', model: 'claude-opus-4-6', provider: 'anthropic' },
      { name: 'b', model: 'claude-opus-4-6', provider: 'anthropic' },
    ];
    const { kept, demoted } = dedupBySlotIdentity(
      providers.map(p => p.name),
      providerMap(providers),
    );
    assert.deepStrictEqual(kept, ['a']);
    assert.deepStrictEqual(demoted, ['b']);
  });

  it('preserves input order in the kept list', () => {
    // Sort order matters — the caller pre-sorts CLI before HTTP. The dedup
    // function must respect that order so the higher-tier (CLI) slot wins
    // when two slots share an identity.
    const providers = [
      { name: 'cli-first',  model: 'M', display_provider: 'P' },
      { name: 'http-later', model: 'M', display_provider: 'P' },
    ];
    const { kept, demoted } = dedupBySlotIdentity(
      ['cli-first', 'http-later'],
      providerMap(providers),
    );
    assert.deepStrictEqual(kept, ['cli-first']);
    assert.deepStrictEqual(demoted, ['http-later']);
  });

  it('treats slots with no model and no provider as always-kept (no dedup)', () => {
    // Empty key (`|`) means we have no identity signal — never dedup; surfacing
    // these as duplicates of each other would be a false positive.
    const providers = [
      { name: 'x', model: '', display_provider: '' },
      { name: 'y' /* no fields at all */ },
    ];
    const { kept, demoted } = dedupBySlotIdentity(
      ['x', 'y'],
      providerMap(providers),
    );
    assert.deepStrictEqual(kept, ['x', 'y']);
    assert.deepStrictEqual(demoted, []);
  });
});
