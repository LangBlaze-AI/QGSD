'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sweepPtoF } = require('./sweepPtoF.cjs');

describe('sweepPtoF', () => {
  let tmpDir;

  function seedLedger(entries) {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    fs.writeFileSync(path.join(formalDir, 'debt.json'), JSON.stringify({
      schema_version: '1',
      created_at: '2026-01-01T00:00:00.000Z',
      last_updated: '2026-01-01T00:00:00.000Z',
      debt_entries: entries,
    }));
  }

  function seedSpec(relPath, content) {
    const specDir = path.join(tmpDir, '.planning', 'formal', 'spec');
    const filePath = path.join(specDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-ptof-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns residual=0 for empty ledger', () => {
    seedLedger([]);
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
    assert.deepStrictEqual(result.detail.divergent_entries, []);
    assert.strictEqual(result.detail.skipped_unlinked, 0);
  });

  it('filters out all open entries (PF-03)', () => {
    seedLedger([
      { id: '1', status: 'open', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
      { id: '2', status: 'open', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 20 } },
      { id: '3', status: 'open', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 30 } },
    ]);
    seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
  });

  it('detects divergent acknowledged entries with formal_ref', () => {
    seedLedger([
      { id: 'a', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
      { id: 'b', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxSize', meta: { measured_value: 7 } },
    ]);
    seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\nMaxSize = 3\n');
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 2);
    assert.strictEqual(result.detail.divergent_entries.length, 2);
  });

  it('counts unlinked entries in skipped_unlinked', () => {
    seedLedger([
      { id: 'a', status: 'acknowledged', formal_ref: null, meta: { measured_value: 10 } },
      { id: 'b', status: 'acknowledged', formal_ref: null, meta: { measured_value: 20 } },
    ]);
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
    assert.strictEqual(result.detail.skipped_unlinked, 2);
    assert.deepStrictEqual(result.detail.skipped_unlinked_ids, ['a', 'b']);
  });

  it('processes only acknowledged entries from mixed statuses', () => {
    seedLedger([
      { id: '1', status: 'open', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
      { id: '2', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
      { id: '3', status: 'resolving', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
      { id: '4', status: 'resolved', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
    ]);
    seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 1);
    assert.strictEqual(result.detail.divergent_entries[0].id, '2');
  });

  it('returns residual=0 when acknowledged linked entry matches expected', () => {
    seedLedger([
      { id: 'a', status: 'acknowledged', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 5 } },
    ]);
    seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
  });

  it('counts only divergent entries in mix of divergent and matching', () => {
    seedLedger([
      { id: 'a', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
      { id: 'b', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxSize', meta: { measured_value: 3 } },
      { id: 'c', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 99 } },
    ]);
    seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\nMaxSize = 3\n');
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 2); // a and c diverge, b matches
  });

  it('includes expected fields in divergent_entries detail', () => {
    seedLedger([
      { id: 'a', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 } },
    ]);
    seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const result = sweepPtoF({ root: tmpDir });
    const entry = result.detail.divergent_entries[0];
    assert.strictEqual(entry.id, 'a');
    assert.strictEqual(entry.formal_ref, 'spec:safety/MCsafety.cfg:MaxDeliberation');
    assert.strictEqual(entry.measured, 10);
    assert.strictEqual(entry.expected, 5);
  });

  it('returns residual=0 on missing debt.json (fail-open)', () => {
    // tmpDir exists but no debt.json
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
  });

  it('does not crash on null entry in debt_entries (fail-open)', () => {
    seedLedger([
      null,
      { id: 'a', status: 'acknowledged', formal_ref: null, meta: { measured_value: 10 } },
    ]);
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
    assert.strictEqual(result.detail.skipped_unlinked, 1);
    assert.deepStrictEqual(result.detail.skipped_unlinked_ids, ['a']);
  });

  it('does not crash when debt_entries is not an array (fail-open)', () => {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    fs.writeFileSync(
      path.join(formalDir, 'debt.json'),
      JSON.stringify({ schema_version: '1', debt_entries: { bogus: true } }),
    );
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
    assert.strictEqual(result.detail.skipped_unlinked, 0);
  });

  it('does not crash when debt.json contains literal null (fail-open)', () => {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    fs.writeFileSync(path.join(formalDir, 'debt.json'), 'null');
    const result = sweepPtoF({ root: tmpDir });
    assert.strictEqual(result.residual, 0);
    assert.deepStrictEqual(result.detail.divergent_entries, []);
  });
});
