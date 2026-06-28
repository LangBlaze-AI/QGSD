#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { parseCfgFiles, parseSpecInvariants, mineObservedInvariants, deduplicateInvariants } = require('./invariant-catalog.cjs');

// ── Unit tests: .cfg parsing ────────────────────────────────────────────────

describe('parseCfgFiles', () => {
  it('extracts single-line INVARIANT declarations', () => {
    const results = parseCfgFiles();
    const typeOKs = results.filter(r => r.name === 'TypeOK');
    assert.ok(typeOKs.length > 0, 'Should find at least one TypeOK invariant');
    assert.strictEqual(typeOKs[0].source, 'tla_cfg');
    assert.strictEqual(typeOKs[0].type, 'declared');
  });

  it('extracts PROPERTY declarations', () => {
    const results = parseCfgFiles();
    const properties = results.filter(r =>
      r.name.includes('Terminates') || r.name.includes('Reachable') ||
      r.name.includes('Consensus') || r.name.includes('Monotone') ||
      r.name.includes('Preserved') || r.name.includes('Progress') ||
      r.name.includes('Decision')
    );
    assert.ok(properties.length > 0, 'Should find at least one PROPERTY');
  });

  it('extracts block-format INVARIANTS declarations', () => {
    const results = parseCfgFiles();
    // MCaccount-manager.cfg has INVARIANTS block
    const blockInvs = results.filter(r => r.config === 'MCaccount-manager');
    assert.ok(blockInvs.length >= 4, `Expected >= 4 from MCaccount-manager block, got ${blockInvs.length}`);
    const names = blockInvs.map(b => b.name);
    assert.ok(names.includes('ActiveIsPoolMember'), 'Should include ActiveIsPoolMember');
  });

  it('all entries have source tla_cfg', () => {
    const results = parseCfgFiles();
    assert.ok(results.every(r => r.source === 'tla_cfg'));
  });
});

// ── Unit tests: spec/invariants.md parsing ──────────────────────────────────

describe('parseSpecInvariants', () => {
  it('extracts invariant names from ## headers', () => {
    const results = parseSpecInvariants();
    assert.ok(results.length > 0, 'Should find at least one spec invariant');
    assert.ok(results.every(r => r.name && r.name.length > 0));
  });

  it('extracts property expressions', () => {
    const results = parseSpecInvariants();
    const withExpr = results.filter(r => r.property_expression !== null);
    assert.ok(withExpr.length > 0, 'At least one should have property_expression');
  });

  it('all entries have source spec_invariants_md', () => {
    const results = parseSpecInvariants();
    assert.ok(results.every(r => r.source === 'spec_invariants_md'));
  });
});

// ── Unit tests: observed invariants ─────────────────────────────────────────

describe('mineObservedInvariants', () => {
  it('produces at least 1 observed invariant', () => {
    const results = mineObservedInvariants();
    assert.ok(results.length >= 1, `Expected >= 1 observed, got ${results.length}`);
  });

  it('observed invariants have confidence "curated"', () => {
    const results = mineObservedInvariants();
    for (const inv of results) {
      assert.strictEqual(inv.confidence, 'curated', `${inv.name} should have curated confidence`);
    }
  });

  it('observed invariants have type "observed"', () => {
    const results = mineObservedInvariants();
    for (const inv of results) {
      assert.strictEqual(inv.type, 'observed');
    }
  });
});

// ── Unit tests: deduplication ───────────────────────────────────────────────

describe('deduplicateInvariants', () => {
  it('deduplicates by (name, config) pair', () => {
    const input = [
      { name: 'TypeOK', source: 'tla_cfg', source_file: 'a.cfg', config: 'MCfoo' },
      { name: 'TypeOK', source: 'tla_cfg', source_file: 'b.cfg', config: 'MCfoo' },
      { name: 'TypeOK', source: 'tla_cfg', source_file: 'c.cfg', config: 'MCbar' },
    ];
    const result = deduplicateInvariants(input);
    assert.strictEqual(result.length, 2);
  });

  it('preserves distinct models with same name', () => {
    const input = [
      { name: 'TypeOK', source: 'tla_cfg', source_file: 'a.cfg', config: 'MCfoo' },
      { name: 'TypeOK', source: 'tla_cfg', source_file: 'b.cfg', config: 'MCbar' },
    ];
    const result = deduplicateInvariants(input);
    assert.strictEqual(result.length, 2);
  });
});

describe('deduplicateInvariants — adversarial input', () => {
  it('returns [] for null/undefined input instead of throwing', () => {
    assert.deepStrictEqual(deduplicateInvariants(null), []);
    assert.deepStrictEqual(deduplicateInvariants(undefined), []);
  });
});

describe('deduplicateInvariants — malformed entries', () => {
  it('skips null and non-object entries instead of throwing or emitting junk', () => {
    const input = [
      null,
      'not-an-object',
      { name: 'TypeOK', source: 'tla_cfg', source_file: 'a.cfg', config: 'MCfoo' },
    ];
    const result = deduplicateInvariants(input);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'TypeOK');
  });
});

describe('mineObservedInvariants — corrupt trace stats', () => {
  it('fails open (exit 0) when trace-corpus-stats.json is invalid JSON', () => {
    const { spawnSync } = require('node:child_process');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-cat-'));
    const ev = path.join(tmp, '.planning', 'formal', 'evidence');
    fs.mkdirSync(ev, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.planning', 'formal', 'tla'), { recursive: true });
    fs.writeFileSync(path.join(ev, 'trace-corpus-stats.json'), '{ corrupt');
    const r = spawnSync(
      process.execPath,
      ['-e', 'require(process.argv[1]).mineObservedInvariants()', path.join(__dirname, 'invariant-catalog.cjs')],
      { env: { ...process.env, PROJECT_ROOT: tmp } }
    );
    assert.strictEqual(r.status, 0, `expected fail-open exit 0, got ${r.status}: ${r.stderr}`);
  });
});

// ── Integration test ────────────────────────────────────────────────────────

describe('integration', () => {
  it('invariant-catalog.json has expected structure', () => {
    const catPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'invariant-catalog.json');
    assert.ok(fs.existsSync(catPath), 'invariant-catalog.json should exist');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    assert.strictEqual(cat.schema_version, '1');
    assert.ok(Array.isArray(cat.invariants));
    assert.ok(cat.summary.total_deduplicated > 0);
    assert.ok(cat.summary.by_type.declared > 0);
  });

  it('total_deduplicated in reasonable range (50-200)', () => {
    const catPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'invariant-catalog.json');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    assert.ok(cat.summary.total_deduplicated >= 50 && cat.summary.total_deduplicated <= 200,
      `Expected 50-200, got ${cat.summary.total_deduplicated}`);
  });

  it('no invariant has source "unclassified"', () => {
    const catPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'invariant-catalog.json');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    assert.ok(cat.invariants.every(i => i.source !== 'unclassified'));
  });

  it('all invariants are declared or observed', () => {
    const catPath = path.join(ROOT, '.planning', 'formal', 'semantics', 'invariant-catalog.json');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    assert.ok(cat.invariants.every(i => i.type === 'declared' || i.type === 'observed'));
  });
});
