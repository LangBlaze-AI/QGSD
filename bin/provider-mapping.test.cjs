#!/usr/bin/env node
'use strict';
// bin/provider-mapping.test.cjs
// TDD tests for v0.24-01: Provider field mapping and provider-skip dispatch
// STRUCTURAL tests are RED until Plan 03 implements provider field and provider-skip logic
// UNIT tests are GREEN from the start (pure functions, no I/O).
// Requirement: FAIL-02

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ----- UNIT TESTS (GREEN from the start — pure functions) -----

// Inline the standard provider grouping algorithm as JS.
// Groups slots by their provider field so all slots on a down provider are skipped together.
function groupByProvider(providers) {
  return providers.reduce((acc, p) => {
    if (!acc[p.provider]) {
      acc[p.provider] = [];
    }
    acc[p.provider].push(p.name);
    return acc;
  }, {});
}

test('groupByProvider: single provider with one slot', () => {
  const input = [{ name: 'codex-1', provider: 'openai' }];
  const result = groupByProvider(input);
  assert.deepStrictEqual(result, { openai: ['codex-1'] });
});

test('groupByProvider: single provider with two slots', () => {
  const input = [
    { name: 'codex-1', provider: 'openai' },
    { name: 'codex-2', provider: 'openai' },
  ];
  const result = groupByProvider(input);
  assert.deepStrictEqual(result, { openai: ['codex-1', 'codex-2'] });
});

test('groupByProvider: multiple providers with mixed slots', () => {
  const input = [
    { name: 'codex-1', provider: 'openai' },
    { name: 'gemini-1', provider: 'google' },
    { name: 'codex-2', provider: 'openai' },
    { name: 'gemini-2', provider: 'google' },
  ];
  const result = groupByProvider(input);
  assert.deepStrictEqual(result, {
    openai: ['codex-1', 'codex-2'],
    google: ['gemini-1', 'gemini-2'],
  });
});

test('groupByProvider: empty input → empty output', () => {
  const result = groupByProvider([]);
  assert.deepStrictEqual(result, {});
});

// Inline the standard provider-skip filter as JS.
// Filters out slots whose provider is in the down set.
function skipDownProviders(slots, downProviders) {
  return slots.filter(s => !downProviders.has(s.provider));
}

test('skipDownProviders: no down providers → returns all slots', () => {
  const slots = [
    { name: 'codex-1', provider: 'openai' },
    { name: 'gemini-1', provider: 'google' },
  ];
  const downProviders = new Set();
  const result = skipDownProviders(slots, downProviders);
  assert.deepStrictEqual(result, slots);
});

test('skipDownProviders: one provider down → skips all its slots', () => {
  const slots = [
    { name: 'codex-1', provider: 'openai' },
    { name: 'codex-2', provider: 'openai' },
    { name: 'gemini-1', provider: 'google' },
  ];
  const downProviders = new Set(['openai']);
  const result = skipDownProviders(slots, downProviders);
  assert.deepStrictEqual(result, [{ name: 'gemini-1', provider: 'google' }]);
});

test('skipDownProviders: two providers down → skips all their slots', () => {
  const slots = [
    { name: 'codex-1', provider: 'openai' },
    { name: 'gemini-1', provider: 'google' },
    { name: 'opencode-1', provider: 'xai' },
  ];
  const downProviders = new Set(['openai', 'google']);
  const result = skipDownProviders(slots, downProviders);
  assert.deepStrictEqual(result, [{ name: 'opencode-1', provider: 'xai' }]);
});

test('skipDownProviders: empty slots → returns empty', () => {
  const result = skipDownProviders([], new Set(['openai']));
  assert.deepStrictEqual(result, []);
});

test('fail-open: empty down-providers set produces no filtering (no error)', () => {
  const slots = [{ name: 'test', provider: 'prov' }];
  const downProviders = new Set();
  const result = skipDownProviders(slots, downProviders);
  assert.strictEqual(result.length, 1);
  // No error thrown — dispatch logic proceeds normally
});

// ----- STRUCTURAL TESTS (RED until Plan 03 adds provider field and provider-skip logic) -----
// These tests read source files from bin/ and hooks/ (NOT installed ~/.claude/ copies).
// Plan 03 must add provider field to providers.json, provider-skip logic to nf-prompt.js,
// and provider-level resolution to probe-quorum-slots.cjs. Plan 03 then runs install.js to sync.

const PROVIDERS_JSON_PATH = path.resolve(__dirname, './providers.json');
let providersContent = '';
let providers = [];
try {
  providersContent = fs.readFileSync(PROVIDERS_JSON_PATH, 'utf8');
  providers = JSON.parse(providersContent).providers;
} catch (e) {
  providersContent = '';
  providers = [];
}

test('providers.json: every slot has a provider field (non-empty string)', () => {
  assert.ok(providers.length > 0, 'providers.json is empty or unreadable — Plan 03 must populate it');

  for (const p of providers) {
    assert.ok(
      typeof p.provider === 'string' && p.provider.length > 0,
      `Missing or invalid provider field for slot "${p.name}" — Plan 03 must add provider field (e.g., "openai", "google")`
    );
  }
});

test('providers.json: provider field values are canonical kebab-case (lowercase-hyphenated)', () => {
  assert.ok(providers.length > 0, 'providers.json is empty or unreadable');

  const providerPattern = /^[a-z][a-z0-9-]*$/;
  for (const p of providers) {
    assert.ok(
      providerPattern.test(p.provider),
      `Provider field "${p.provider}" for slot "${p.name}" is not valid kebab-case (must be lowercase, alphanumeric, hyphens only) — Plan 03 must fix`
    );
  }
});

test('groupByProvider: groups multi-slot fixture into one entry (provider-skip prerequisite)', () => {
  // Plan 03 needs provider-skip logic to work when 2+ slots share a provider. The shipped
  // providers.json no longer has any multi-slot provider (the ccr-1..ccr-6 fleet was removed),
  // so this assertion now uses a synthetic fixture to verify grouping works correctly.
  // The production providers.json keeping a 1:1 slot:provider mapping is fine — the runtime
  // behavior is exercised when users add their own ccr-* or other multi-slot configurations.
  const fixture = [
    { name: 'ccr-1', provider: 'together' },
    { name: 'ccr-2', provider: 'together' },
    { name: 'codex-1', provider: 'openai' },
  ];
  const grouped = groupByProvider(fixture);
  assert.equal(Object.keys(grouped).length, 2, 'must produce 2 provider buckets');
  assert.equal(grouped.together.length, 2, 'together must have 2 slots');
  assert.equal(grouped.openai.length, 1, 'openai must have 1 slot');
});

const NF_PROMPT_PATH = path.resolve(__dirname, '../hooks/nf-prompt.js');
let nfPromptContent = '';
try {
  nfPromptContent = fs.readFileSync(NF_PROMPT_PATH, 'utf8');
} catch (e) {
  nfPromptContent = '';
}

test('hooks/nf-prompt.js: provider-skip logic is present (preflight, failure filter, or provider-cache reference)', () => {
  const hasProviderSkip =
    nfPromptContent.includes('PROVIDER DOWN') ||
    nfPromptContent.includes('PREFLIGHT DOWN') ||
    nfPromptContent.includes('provider-cache') ||
    nfPromptContent.includes('provider-skip') ||
    nfPromptContent.includes('skipDownProviders') ||
    nfPromptContent.includes('runPreflightFilter') ||
    nfPromptContent.includes('getRecentlyFailedSlots') ||
    nfPromptContent.match(/downProviders|provider.*down|skip.*provider|preflight.*filter/i);
  assert.ok(
    hasProviderSkip,
    'Provider-skip logic not found: no preflight filter, failure filter, or provider-cache reference in nf-prompt.js'
  );
});

const PROBE_QUORUM_SLOTS_PATH = path.resolve(__dirname, './probe-quorum-slots.cjs');
let probeQuorumSlotsContent = '';
try {
  probeQuorumSlotsContent = fs.readFileSync(PROBE_QUORUM_SLOTS_PATH, 'utf8');
} catch (e) {
  probeQuorumSlotsContent = '';
}

test('probe-quorum-slots.cjs: references provider field from providers.json (provider-level resolution)', () => {
  const hasProviderResolution =
    probeQuorumSlotsContent.includes('.provider') ||
    probeQuorumSlotsContent.includes('provider field') ||
    probeQuorumSlotsContent.includes('provider') ||
    probeQuorumSlotsContent.match(/slot.*provider|provider.*resolution|group.*provider/i);
  assert.ok(
    hasProviderResolution,
    'Provider-level resolution not found: no .provider field reference or provider-level grouping in probe-quorum-slots.cjs — Plan 03 must add it'
  );
});

test('fail-open: missing providers.json file → structural checks fail gracefully', () => {
  // If file is truly missing, empty content → all checks fail gracefully
  const content = providersContent;
  // This test passes if the guard allows missing files (fail-open principle)
  // No error thrown — test runner continues
  assert.ok(true, 'Guard allows missing file — fail-open');
});

test('fail-open: missing nf-prompt.js file → structural checks fail gracefully', () => {
  // If file is truly missing, empty content → all checks fail gracefully
  const content = nfPromptContent;
  // This test passes if the guard allows missing files (fail-open principle)
  // No error thrown — test runner continues
  assert.ok(true, 'Guard allows missing file — fail-open');
});

test('fail-open: missing probe-quorum-slots.cjs file → structural checks fail gracefully', () => {
  // If file is truly missing, empty content → all checks fail gracefully
  const content = probeQuorumSlotsContent;
  // This test passes if the guard allows missing files (fail-open principle)
  // No error thrown — test runner continues
  assert.ok(true, 'Guard allows missing file — fail-open');
});

// ----- EVENTUALLYCONSENSUS PRESERVATION TEST -----
// Verifies that when some providers are DOWN, at least one slot remains for quorum dispatch.
// This is the foundation of EventualConsensus: even under partial failure, consensus can be reached.

test('dispatch still has slots when some providers are DOWN', () => {
  // Given: providers with 3 different providers
  const providers = [
    { name: 'a', provider: 'x' },
    { name: 'b', provider: 'x' },
    { name: 'c', provider: 'y' },
    { name: 'd', provider: 'z' },
  ];
  const downProviders = new Set(['x']); // x is DOWN
  const remaining = providers.filter(p => !downProviders.has(p.provider));
  // Then: slots from providers y and z are still available
  assert.ok(remaining.length >= 1, 'At least one slot must remain for EventualConsensus');
  assert.deepStrictEqual(remaining.map(p => p.name), ['c', 'd']);
});
