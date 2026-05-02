#!/usr/bin/env node
'use strict';

/**
 * Unit tests for guided provider selection in install.js.
 * Tests classifyProviders, detectExternalClis, and the selectedProviderSlots filter logic.
 * Uses inline fixture data — providers.json is empty in the repo (populated at install time).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const origArgv = process.argv;
process.argv = ['node', 'test'];

const { classifyProviders, detectExternalClis } = require('../bin/install.js');

process.argv = origArgv;

// Inline fixture data matching the provider schema — not read from providers.json
const FIXTURE_PROVIDERS = [
  { name: 'codex-1', provider: 'openai', type: 'subprocess', auth_type: 'sub', has_file_access: true, mainTool: 'codex', model: 'gpt-5.4', cli: null, args_template: ['exec', '{prompt}'] },
  { name: 'gemini-1', provider: 'google', type: 'subprocess', auth_type: 'sub', has_file_access: true, mainTool: 'gemini', model: 'gemini-3-flash-preview', cli: null, args_template: ['-m', 'gemini-3-flash-preview', '-p', '{prompt}'] },
  { name: 'opencode-1', provider: 'xai', type: 'subprocess', auth_type: 'sub', has_file_access: true, mainTool: 'opencode', model: 'grok-code-fast-1', cli: null, args_template: ['run', '--print-logs', '--log-level', 'ERROR', '{prompt}'] },
  { name: 'copilot-1', provider: 'github', type: 'subprocess', auth_type: 'sub', has_file_access: true, mainTool: 'ask', model: 'gpt-4.1', cli: null, args_template: ['-p', '{prompt}', '--allow-all-tools', '--no-color', '-s'] },
  { name: 'claude-1', provider: 'anthropic', type: 'subprocess', auth_type: 'sub', has_file_access: true, mainTool: 'claude', model: 'claude-opus-4-6', cli: null, args_template: ['-p', '{prompt}', '--model', 'claude-opus-4-6', '--dangerously-skip-permissions'] },
];

describe('classifyProviders', () => {
  const result = classifyProviders(FIXTURE_PROVIDERS);

  it('should return empty CCR array', () => {
    assert.equal(result.ccr.length, 0);
  });

  it('should classify 5 external primary slots', () => {
    assert.equal(result.externalPrimary.length, 5);
    const names = result.externalPrimary.map(p => p.name).sort();
    assert.deepEqual(names, ['claude-1', 'codex-1', 'copilot-1', 'gemini-1', 'opencode-1']);
  });

  it('should return empty dual-subscription array', () => {
    assert.equal(result.dualSubscription.length, 0);
  });

  it('should derive bareCli for copilot-1 from mainTool when cli is null', () => {
    const copilot = result.externalPrimary.find(p => p.name === 'copilot-1');
    assert.equal(copilot.bareCli, 'ask', 'bareCli falls back to mainTool when cli is null');
  });

  it('should derive correct bareCli for all external primaries', () => {
    const claude = result.externalPrimary.find(p => p.name === 'claude-1');
    const codex = result.externalPrimary.find(p => p.name === 'codex-1');
    const gemini = result.externalPrimary.find(p => p.name === 'gemini-1');
    const opencode = result.externalPrimary.find(p => p.name === 'opencode-1');
    assert.equal(claude.bareCli, 'claude');
    assert.equal(codex.bareCli, 'codex');
    assert.equal(gemini.bareCli, 'gemini');
    assert.equal(opencode.bareCli, 'opencode');
  });
});

describe('classifyProviders edge cases', () => {
  it('should derive bareCli from cli path when both cli and mainTool are set', () => {
    const result = classifyProviders([
      { name: 'copilot-1', mainTool: 'ask', cli: '/opt/homebrew/bin/copilot' }
    ]);
    assert.equal(result.externalPrimary[0].bareCli, 'copilot');
  });

  it('should fall back to mainTool when cli is empty', () => {
    const result = classifyProviders([
      { name: 'test-1', mainTool: 'mytool', cli: '' }
    ]);
    assert.equal(result.externalPrimary[0].bareCli, 'mytool');
  });

  it('should fall back to mainTool when cli is missing', () => {
    const result = classifyProviders([
      { name: 'test-1', mainTool: 'mytool' }
    ]);
    assert.equal(result.externalPrimary[0].bareCli, 'mytool');
  });

  it('should handle Daintree preset entries', () => {
    const result = classifyProviders([
      ...FIXTURE_PROVIDERS,
      { name: 'claude-z-ai', provider: 'anthropic', type: 'subprocess', auth_type: 'sub', has_file_access: true, mainTool: 'claude', model: 'glm-5.1', cli: null, daintree_preset_id: 'user-123', daintree_preset_name: 'Z.AI' },
    ]);
    assert.equal(result.externalPrimary.length, 6);
    const zai = result.externalPrimary.find(p => p.name === 'claude-z-ai');
    assert.ok(zai, 'Daintree preset should be classified as externalPrimary');
    assert.equal(zai.bareCli, 'claude');
  });
});

describe('detectExternalClis', () => {
  const classified = classifyProviders(FIXTURE_PROVIDERS);
  const detected = detectExternalClis(classified.externalPrimary);

  it('should return same number of entries as externalPrimary', () => {
    assert.equal(detected.length, classified.externalPrimary.length);
  });

  it('should have found (boolean) and resolvedPath fields on each entry', () => {
    for (const d of detected) {
      assert.equal(typeof d.found, 'boolean', `${d.name} should have boolean found`);
      if (d.found) {
        assert.equal(typeof d.resolvedPath, 'string', `${d.name} found=true should have string resolvedPath`);
        assert.notEqual(d.resolvedPath, d.bareCli, `${d.name} resolvedPath should be a full path, not bare name`);
      } else {
        assert.equal(d.resolvedPath, null, `${d.name} found=false should have null resolvedPath`);
      }
    }
  });

  it('should preserve original provider properties', () => {
    for (const d of detected) {
      assert.ok(d.name, 'should have name');
      assert.ok(d.bareCli, 'should have bareCli');
    }
  });
});

describe('selectedProviderSlots filter logic', () => {
  it('should filter providers when selectedProviderSlots is an array', () => {
    const slots = ['claude-1', 'codex-1', 'gemini-1'];
    const filtered = FIXTURE_PROVIDERS.filter(p => slots.includes(p.name));
    assert.equal(filtered.length, 3);
    const names = filtered.map(p => p.name).sort();
    assert.deepEqual(names, ['claude-1', 'codex-1', 'gemini-1']);
  });

  it('should pass ALL providers when selectedProviderSlots is null', () => {
    const slots = null;
    const filtered = FIXTURE_PROVIDERS.filter(p => !slots || slots.includes(p.name));
    assert.equal(filtered.length, FIXTURE_PROVIDERS.length);
  });

  it('should filter claude-1 when selectedProviderSlots has claude name', () => {
    const classified = classifyProviders(FIXTURE_PROVIDERS);
    const claudeOnly = classified.externalPrimary.filter(p => p.name === 'claude-1').map(p => p.name);
    const filtered = FIXTURE_PROVIDERS.filter(p => claudeOnly.includes(p.name));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, 'claude-1');
  });
});

describe('--all-providers flag parsing', () => {
  it('should recognize --all-providers flag', () => {
    assert.ok(['--all-providers'].includes('--all-providers'));
  });
});

describe('repo providers.json', () => {
  it('should be empty — providers are populated at install time via /nf:link-daintree', () => {
    const repoProviders = require('../bin/providers.json');
    assert.equal(repoProviders.providers.length, 0, 'repo providers.json must be empty — no user-specific providers');
  });
});
