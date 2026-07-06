#!/usr/bin/env node
'use strict';

/**
 * Unit tests for issue #200 — install.js must install unified-mcp-server.mjs
 * into ~/.claude/nf-bin/ and point every mcpServers slot at that INSTALLED copy
 * (never the repo working tree). Exercises the pure helpers only; never runs the
 * installer against the real ~/.claude environment.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Import the pure helpers from install-helpers.cjs — NOT install.js, which runs
// the installer on require (in CI's non-interactive shell that auto-installs and
// fails the test file at load). install.js re-exports the same helpers from here.
const {
  shouldCopyToNfBin,
  isUnderInstallDir,
  synthesizeMcpEntry,
  installedUnifiedMcpPath,
  mcpArgsNeedMigration,
  NF_BIN_RUNTIME_MJS,
} = require('../bin/install-helpers.cjs');

describe('mcpArgsNeedMigration — repo-tree → nf-bin args migration (issue #200)', () => {
  const nfBin = '/home/u/.claude/nf-bin';
  it('flags a repo-tree args[0] for migration (the bug: slots ran from the repo)', () => {
    assert.equal(mcpArgsNeedMigration('/home/u/code/QGSD/bin/unified-mcp-server.mjs', nfBin), true);
  });
  it('flags an npx-cache args[0] for migration', () => {
    assert.equal(mcpArgsNeedMigration('/home/u/.npm/_npx/abc/node_modules/@nforma.ai/nforma/bin/unified-mcp-server.mjs', nfBin), true);
  });
  it('does NOT flag an already-installed nf-bin path', () => {
    assert.equal(mcpArgsNeedMigration('/home/u/.claude/nf-bin/unified-mcp-server.mjs', nfBin), false);
  });
  it('ignores non-unified args and non-string input', () => {
    assert.equal(mcpArgsNeedMigration('/home/u/code/QGSD/bin/some-other.mjs', nfBin), false);
    assert.equal(mcpArgsNeedMigration(undefined, nfBin), false);
    assert.equal(mcpArgsNeedMigration(null, nfBin), false);
  });
});

describe('shouldCopyToNfBin — nf-bin copy filter (issue #200)', () => {
  it('selects runtime .mjs on the allowlist (the bug: .mjs was skipped)', () => {
    assert.equal(shouldCopyToNfBin('unified-mcp-server.mjs'), true);
    assert.ok(NF_BIN_RUNTIME_MJS.has('unified-mcp-server.mjs'));
    // proximity-embed.mjs must ship too (dogfood: /nf:proximity + nf-solve Phase 0 need it)
    assert.equal(shouldCopyToNfBin('proximity-embed.mjs'), true);
    assert.ok(NF_BIN_RUNTIME_MJS.has('proximity-embed.mjs'));
  });

  it('still selects .cjs dispatch scripts', () => {
    assert.equal(shouldCopyToNfBin('resolve-cli.cjs'), true);
    assert.equal(shouldCopyToNfBin('unified-mcp-server.cjs'), true);
  });

  it('does not select providers.json (merge-handled separately)', () => {
    assert.equal(shouldCopyToNfBin('providers.json'), false);
  });

  it('does not select unrelated .mjs / other files', () => {
    assert.equal(shouldCopyToNfBin('some-random-tool.mjs'), false); // not on the allowlist
    assert.equal(shouldCopyToNfBin('README.md'), false);
    assert.equal(shouldCopyToNfBin('something.test.js'), false);
  });
});

describe('isUnderInstallDir', () => {
  const installDir = '/home/u/.claude/nf-bin';

  it('true for a file directly under the install dir', () => {
    assert.equal(
      isUnderInstallDir('/home/u/.claude/nf-bin/unified-mcp-server.mjs', installDir),
      true
    );
  });

  it('false for a repo working-tree path (the #200 failure mode)', () => {
    assert.equal(
      isUnderInstallDir('/Users/dev/code/QGSD/bin/unified-mcp-server.mjs', installDir),
      false
    );
  });

  it('false for the install dir itself and for parent escapes', () => {
    assert.equal(isUnderInstallDir(installDir, installDir), false);
    assert.equal(isUnderInstallDir('/home/u/.claude/nf-bin/../bin/x.mjs', installDir), false);
  });

  it('false for empty / nullish inputs', () => {
    assert.equal(isUnderInstallDir('', installDir), false);
    assert.equal(isUnderInstallDir('/x/y.mjs', ''), false);
  });
});

describe('synthesizeMcpEntry — args resolve under the install dir', () => {
  const claudeHome = path.join('/home', 'u', '.claude');
  const nfBin = path.join(claudeHome, 'nf-bin');

  it('args[0] is the installed unified-mcp-server copy, under nf-bin', () => {
    const entry = synthesizeMcpEntry('codex-1', claudeHome);
    assert.equal(entry.type, 'stdio');
    assert.equal(entry.command, 'node');
    assert.equal(entry.args[0], installedUnifiedMcpPath(claudeHome));
    assert.equal(entry.args[0], path.join(nfBin, 'unified-mcp-server.mjs'));
    assert.equal(isUnderInstallDir(entry.args[0], nfBin), true);
  });

  it('env carries PROVIDER_SLOT and the installed providers.json path', () => {
    const entry = synthesizeMcpEntry('gemini-1', claudeHome);
    assert.equal(entry.env.PROVIDER_SLOT, 'gemini-1');
    assert.equal(entry.env.UNIFIED_PROVIDERS_CONFIG, path.join(nfBin, 'providers.json'));
    assert.equal(isUnderInstallDir(entry.env.UNIFIED_PROVIDERS_CONFIG, nfBin), true);
  });
});
