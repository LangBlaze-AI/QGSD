'use strict';

const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Helper to create a ledger object
function makeLedger(entries) {
  return {
    schema_version: '1',
    created_at: '2026-01-01T00:00:00Z',
    last_updated: '2026-01-01T00:00:00Z',
    debt_entries: entries
  };
}

// Helper to create a debt entry
function makeEntry(overrides = {}) {
  return {
    fingerprint: 'fp-' + Math.random().toString(36).slice(2, 8),
    title: 'Test entry',
    status: 'open',
    source_entries: [],
    ...overrides
  };
}

// We test by requiring the module and mocking debt-ledger at the fs level
// Since the module uses loadDebtLedger() which requires debt-ledger.cjs,
// we mock require by providing a controlled debt.json file
const fs = require('node:fs');
const os = require('node:os');

describe('solve-debt-bridge', () => {
  let tmpDir;
  let debtPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-test-'));
    debtPath = path.join(tmpDir, 'debt.json');
  });

  // We need to test the actual module, but it requires debt-ledger.cjs
  // which is available in the same directory. We write test debt.json files.
  const {
    readOpenDebt,
    matchDebtToResidual,
    transitionDebtEntries,
    summarizeDebtProgress,
    VALID_TRANSITIONS
  } = require('./solve-debt-bridge.cjs');

  describe('readOpenDebt', () => {
    it('returns open and acknowledged entries from valid ledger', () => {
      const entries = [
        makeEntry({ fingerprint: 'a', status: 'open' }),
        makeEntry({ fingerprint: 'b', status: 'acknowledged' }),
        makeEntry({ fingerprint: 'c', status: 'resolved' }),
        makeEntry({ fingerprint: 'd', status: 'resolving' })
      ];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = readOpenDebt(debtPath);
      assert.equal(result.error, null);
      assert.equal(result.entries.length, 2);
      assert.deepStrictEqual(result.entries.map(e => e.fingerprint), ['a', 'b']);
    });

    it('returns empty entries for empty ledger', () => {
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger([])));
      const result = readOpenDebt(debtPath);
      assert.equal(result.error, null);
      assert.equal(result.entries.length, 0);
    });

    it('fail-open: returns empty entries for missing file', () => {
      const result = readOpenDebt(path.join(tmpDir, 'nonexistent.json'));
      assert.equal(result.entries.length, 0);
      // Should not throw
    });

    it('fail-open: returns empty entries for corrupt file', () => {
      fs.writeFileSync(debtPath, 'not json{{{');
      const result = readOpenDebt(debtPath);
      assert.equal(result.entries.length, 0);
    });
  });

  describe('matchDebtToResidual', () => {
    it('matches formal_ref entries to r_to_f', () => {
      const entries = [makeEntry({ formal_ref: 'REQ-01' })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched.length, 1);
      assert.equal(result.matched[0].layer, 'r_to_f');
      assert.equal(result.unmatched.length, 0);
    });

    it('matches ACT- and CONF- formal_ref patterns', () => {
      const entries = [
        makeEntry({ formal_ref: 'ACT-05' }),
        makeEntry({ formal_ref: 'CONF-12' })
      ];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched.length, 2);
      assert.ok(result.matched.every(m => m.layer === 'r_to_f'));
    });

    it('matches internal source with test route to f_to_t', () => {
      const entries = [makeEntry({
        source_entries: [{ source_type: 'internal' }],
        _route: 'f_to_t'
      })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched[0].layer, 'f_to_t');
    });

    it('matches internal source with doc route to r_to_d', () => {
      const entries = [makeEntry({
        source_entries: [{ source_type: 'internal' }],
        _route: 'r_to_d'
      })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched[0].layer, 'r_to_d');
    });

    it('matches github source to f_to_c', () => {
      const entries = [makeEntry({
        source_entries: [{ source_type: 'github' }]
      })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched[0].layer, 'f_to_c');
    });

    it('matches sentry source to f_to_c', () => {
      const entries = [makeEntry({
        source_entries: [{ source_type: 'sentry' }]
      })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched[0].layer, 'f_to_c');
    });

    it('matches title keywords to layers', () => {
      const entries = [makeEntry({ title: 'Missing test coverage for auth module' })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched[0].layer, 'f_to_t');
      assert.ok(result.matched[0].reason.includes('keyword'));
    });

    it('matches description keywords to layers', () => {
      const entries = [makeEntry({ title: 'Something', description: 'needs documentation updates' })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched[0].layer, 'r_to_d');
    });

    it('puts unmatched entries in unmatched array', () => {
      const entries = [makeEntry({ title: 'Random unrelated thing' })];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched.length, 0);
      assert.equal(result.unmatched.length, 1);
    });

    it('handles null/invalid input gracefully', () => {
      assert.deepStrictEqual(matchDebtToResidual(null, {}), { matched: [], unmatched: [] });
      assert.deepStrictEqual(matchDebtToResidual(undefined, {}), { matched: [], unmatched: [] });
    });

    it('matches mixed entry types correctly', () => {
      const entries = [
        makeEntry({ formal_ref: 'REQ-01' }),
        makeEntry({ source_entries: [{ source_type: 'github' }] }),
        makeEntry({ source_entries: [{ source_type: 'internal' }], _route: 'test' }),
        makeEntry({ title: 'Random thing with no keywords that match' })
      ];
      const result = matchDebtToResidual(entries, {});
      assert.equal(result.matched.length, 3);
      assert.equal(result.unmatched.length, 1);
      assert.equal(result.matched[0].layer, 'r_to_f');
      assert.equal(result.matched[1].layer, 'f_to_c');
      assert.equal(result.matched[2].layer, 'f_to_t');
    });
  });

  describe('transitionDebtEntries', () => {
    it('transitions open -> resolving', () => {
      const entries = [
        makeEntry({ fingerprint: 'fp1', status: 'open' }),
        makeEntry({ fingerprint: 'fp2', status: 'open' })
      ];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = transitionDebtEntries(debtPath, ['fp1'], 'open', 'resolving');
      assert.equal(result.transitioned, 1);
      assert.equal(result.skipped, 0);

      // Verify written
      const updated = JSON.parse(fs.readFileSync(debtPath, 'utf8'));
      assert.equal(updated.debt_entries[0].status, 'resolving');
      assert.equal(updated.debt_entries[1].status, 'open');
    });

    it('transitions acknowledged -> resolving', () => {
      const entries = [makeEntry({ fingerprint: 'fp1', status: 'acknowledged' })];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = transitionDebtEntries(debtPath, ['fp1'], 'acknowledged', 'resolving');
      assert.equal(result.transitioned, 1);
    });

    it('transitions resolving -> resolved', () => {
      const entries = [makeEntry({ fingerprint: 'fp1', status: 'resolving' })];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = transitionDebtEntries(debtPath, ['fp1'], 'resolving', 'resolved');
      assert.equal(result.transitioned, 1);
    });

    it('supports resolving -> open regression transition', () => {
      const entries = [makeEntry({ fingerprint: 'fp1', status: 'resolving' })];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = transitionDebtEntries(debtPath, ['fp1'], 'resolving', 'open');
      assert.equal(result.transitioned, 1);
    });

    it('rejects invalid transitions (resolved -> open)', () => {
      const entries = [makeEntry({ fingerprint: 'fp1', status: 'resolved' })];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = transitionDebtEntries(debtPath, ['fp1'], 'resolved', 'open');
      assert.equal(result.transitioned, 0);
      assert.equal(result.skipped, 1);
    });

    it('skips entries with non-matching status', () => {
      const entries = [makeEntry({ fingerprint: 'fp1', status: 'resolved' })];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = transitionDebtEntries(debtPath, ['fp1'], 'open', 'resolving');
      assert.equal(result.transitioned, 0);
      assert.equal(result.skipped, 1);
    });

    it('handles empty fingerprints array', () => {
      const result = transitionDebtEntries(debtPath, [], 'open', 'resolving');
      assert.equal(result.transitioned, 0);
      assert.equal(result.skipped, 0);
    });

    it('fail-open on missing file', () => {
      const result = transitionDebtEntries(
        path.join(tmpDir, 'nonexistent.json'), ['fp1'], 'open', 'resolving'
      );
      assert.equal(result.transitioned, 0);
    });
  });

  describe('summarizeDebtProgress', () => {
    it('counts entries by status', () => {
      const entries = [
        makeEntry({ status: 'open' }),
        makeEntry({ status: 'open' }),
        makeEntry({ status: 'acknowledged' }),
        makeEntry({ status: 'resolving' }),
        makeEntry({ status: 'resolved' }),
        makeEntry({ status: 'resolved' })
      ];
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger(entries)));

      const result = summarizeDebtProgress(debtPath);
      assert.deepStrictEqual(result, {
        open: 2,
        acknowledged: 1,
        resolving: 1,
        resolved: 2,
        total: 6
      });
    });

    it('returns all zeros for empty ledger', () => {
      fs.writeFileSync(debtPath, JSON.stringify(makeLedger([])));
      const result = summarizeDebtProgress(debtPath);
      assert.deepStrictEqual(result, { open: 0, acknowledged: 0, resolving: 0, resolved: 0, total: 0 });
    });

    it('fail-open: returns zeros for missing file', () => {
      const result = summarizeDebtProgress(path.join(tmpDir, 'nonexistent.json'));
      assert.deepStrictEqual(result, { open: 0, acknowledged: 0, resolving: 0, resolved: 0, total: 0 });
    });

    it('fail-open: returns zeros for corrupt file', () => {
      fs.writeFileSync(debtPath, 'not-json');
      const result = summarizeDebtProgress(debtPath);
      assert.deepStrictEqual(result, { open: 0, acknowledged: 0, resolving: 0, resolved: 0, total: 0 });
    });
  });

  describe('VALID_TRANSITIONS', () => {
    it('allows open -> resolving', () => {
      assert.ok(VALID_TRANSITIONS.open.includes('resolving'));
    });

    it('allows acknowledged -> resolving', () => {
      assert.ok(VALID_TRANSITIONS.acknowledged.includes('resolving'));
    });

    it('allows resolving -> resolved', () => {
      assert.ok(VALID_TRANSITIONS.resolving.includes('resolved'));
    });

    it('allows resolving -> open (regression)', () => {
      assert.ok(VALID_TRANSITIONS.resolving.includes('open'));
    });

    it('disallows resolved -> anything', () => {
      assert.equal(VALID_TRANSITIONS.resolved.length, 0);
    });
  });

  // Dogfood regression: the module exported readOpenDebt but had no
  // `require.main` CLI block, so `/nf:solve`'s `node solve-debt-bridge.cjs
  // --read-open --project-root=…` emitted NOTHING → DEBT_JSON always fell back to
  // {"entries":[]} and debt-convergence never ran. The CLI must print JSON.
  describe('CLI --read-open (live invocation)', () => {
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const SCRIPT = path.join(__dirname, 'solve-debt-bridge.cjs');

    it('emits parseable {entries} JSON filtering open+acknowledged', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-debt-'));
      try {
        fs.mkdirSync(path.join(dir, '.planning', 'formal'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, '.planning', 'formal', 'debt.json'),
          JSON.stringify({ debt_entries: [
            { id: 'D1', status: 'open' },
            { id: 'D2', status: 'resolved' },
            { id: 'D3', status: 'acknowledged' },
          ] })
        );
        const out = execFileSync(process.execPath, [SCRIPT, '--read-open', `--project-root=${dir}`], { encoding: 'utf8' });
        assert.ok(out.trim().length > 0, 'CLI must emit output (not the dead-path empty string)');
        const parsed = JSON.parse(out);
        assert.equal(parsed.entries.length, 2, 'open + acknowledged retained, resolved dropped');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
