#!/usr/bin/env node
'use strict';

/**
 * Test for issue #167: providers.json path consolidation.
 * Verifies that all code references a single canonical path (~/.claude/nf-bin/providers.json)
 * and that the legacy nf/bin/ path is only used as a backwards-compatible fallback.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Files that should have their primary providers.json path as nf-bin/
const FILES_WITH_PROVIDERS_PATH = [
  'bin/call-quorum-slot.cjs',
  'bin/unified-mcp-server.mjs',
  'bin/probe-quorum-slots.cjs',
  'bin/quorum-preflight.cjs',
  'bin/account-manager.cjs',
  'bin/provider-status.cjs',
  'hooks/nf-statusline.js',
  'hooks/nf-slot-health-probe.js',
  'hooks/dist/nf-statusline.js',
  'hooks/dist/nf-slot-health-probe.js',
];

// Files where nf-bin/ should be the canonical write/set path
const CANONICAL_WRITE_FILES = [
  'bin/install.js',
];

describe('providers.json path consolidation (issue #167)', () => {

  describe('canonical path is nf-bin/ in all reader files', () => {
    for (const relPath of FILES_WITH_PROVIDERS_PATH) {
      it(`${relPath} references nf-bin/providers.json as canonical`, () => {
        const fullPath = path.join(ROOT, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Must reference nf-bin/providers.json
        const hasNfBin = content.includes("'.claude', 'nf-bin', 'providers.json'") ||
                         content.includes("'.claude/nf-bin/providers.json'");
        assert.ok(hasNfBin, `${relPath} must reference ~/.claude/nf-bin/providers.json`);
      });
    }
  });

  describe('install.js sets UNIFIED_PROVIDERS_CONFIG to nf-bin/ path', () => {
    it('install.js uses nf-bin/providers.json for UNIFIED_PROVIDERS_CONFIG', () => {
      const content = fs.readFileSync(path.join(ROOT, 'bin/install.js'), 'utf8');

      // The globalProvidersJson and installedProvidersPath must point to nf-bin
      const hasCanonicalGlobal = content.includes("'.claude', 'nf-bin', 'providers.json'");
      assert.ok(hasCanonicalGlobal, 'install.js globalProvidersJson must use nf-bin/');

      // The installedProvidersPath must point to nf-bin
      const installedPathMatch = content.match(/const installedProvidersPath\s*=\s*path\.join\(os\.homedir\(\),\s*'\.claude',\s*'nf-bin',\s*'providers\.json'\)/);
      assert.ok(installedPathMatch, 'installedProvidersPath must use nf-bin/');
    });

    it('install.js migrates legacy nf/bin/providers.json entries in UNIFIED_PROVIDERS_CONFIG', () => {
      const content = fs.readFileSync(path.join(ROOT, 'bin/install.js'), 'utf8');

      // Should have code that detects legacy path and replaces it
      const hasLegacyMigration = content.includes("existing.env.UNIFIED_PROVIDERS_CONFIG === legacyPath") ||
                                  content.includes("entry.env.UNIFIED_PROVIDERS_CONFIG === legacyProvidersJson");
      assert.ok(hasLegacyMigration, 'install.js must migrate legacy nf/bin/ UNIFIED_PROVIDERS_CONFIG entries');
    });
  });

  describe('no file writes to nf/bin/providers.json as canonical location', () => {
    for (const relPath of [...FILES_WITH_PROVIDERS_PATH, ...CANONICAL_WRITE_FILES]) {
      it(`${relPath} does not write to nf/bin/providers.json as primary`, () => {
        const fullPath = path.join(ROOT, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Find writeFileSync or renameSync calls that target nf/bin/providers.json
        // (should not exist except in migration/mirror code)
        const writePatterns = [
          /writeFileSync\([^)]*nf['"],\s*['"]bin['"],\s*['"]providers\.json/g,
        ];

        for (const pattern of writePatterns) {
          const matches = content.match(pattern);
          assert.equal(matches, null, `${relPath} should not write to nf/bin/providers.json as primary`);
        }
      });
    }
  });

  describe('install.js creates symlink from nf/bin/ → nf-bin/ for backwards compat', () => {
    it('install.js creates providers.json symlink', () => {
      const content = fs.readFileSync(path.join(ROOT, 'bin/install.js'), 'utf8');
      const hasSymlink = content.includes("symlinkSync(canonicalProviders, nfBinProviders)");
      assert.ok(hasSymlink, 'install.js must create symlink from nf/bin/providers.json → nf-bin/providers.json');
    });

    it('install.js migrates data from legacy path before creating symlink', () => {
      const content = fs.readFileSync(path.join(ROOT, 'bin/install.js'), 'utf8');
      const hasMigration = content.includes('Migrated') && content.includes('nf/bin/') && content.includes('nf-bin/');
      assert.ok(hasMigration, 'install.js must migrate data from nf/bin/ to nf-bin/ before creating symlink');
    });
  });

  describe('hooks source and dist are in sync', () => {
    const hookPairs = [
      ['hooks/nf-statusline.js', 'hooks/dist/nf-statusline.js'],
      ['hooks/nf-slot-health-probe.js', 'hooks/dist/nf-slot-health-probe.js'],
    ];

    for (const [src, dist] of hookPairs) {
      it(`${src} and ${dist} use the same providers.json path`, () => {
        const srcContent = fs.readFileSync(path.join(ROOT, src), 'utf8');
        const distContent = fs.readFileSync(path.join(ROOT, dist), 'utf8');

        const srcHasNfBin = srcContent.includes("'.claude', 'nf-bin', 'providers.json'");
        const distHasNfBin = distContent.includes("'.claude', 'nf-bin', 'providers.json'");

        assert.equal(srcHasNfBin, true, `${src} must use nf-bin/ path`);
        assert.equal(distHasNfBin, true, `${dist} must use nf-bin/ path`);
      });
    }
  });
});
