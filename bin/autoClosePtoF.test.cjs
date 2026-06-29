'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { autoClosePtoF } = require('./autoClosePtoF.cjs');

describe('autoClosePtoF', () => {
  let tmpDir;
  let spawnCalls;

  function mockSpawn(ok) {
    return function spawnTool(script, args) {
      spawnCalls.push({ script, args });
      return { ok };
    };
  }

  function seedLedger(entries) {
    const formalDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(formalDir, { recursive: true });
    const ledgerPath = path.join(formalDir, 'debt.json');
    fs.writeFileSync(ledgerPath, JSON.stringify({
      schema_version: '1',
      created_at: '2026-01-01T00:00:00.000Z',
      last_updated: '2026-01-01T00:00:00.000Z',
      debt_entries: entries,
    }));
    return ledgerPath;
  }

  function seedSpec(relPath, content) {
    const specDir = path.join(tmpDir, '.planning', 'formal', 'spec');
    const filePath = path.join(specDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return specDir;
  }

  function readLedgerEntries(ledgerPath) {
    return JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).debt_entries;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclose-'));
    spawnCalls = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result for residual=0', () => {
    const result = autoClosePtoF({ residual: 0, detail: { divergent_entries: [] } });
    assert.deepStrictEqual(result, { actions_taken: [], entries_processed: 0 });
  });

  it('returns empty result for null residual', () => {
    const result = autoClosePtoF(null);
    assert.deepStrictEqual(result, { actions_taken: [], entries_processed: 0 });
  });

  it('dispatches parameter update for drift + numeric threshold (success)', () => {
    const specDir = seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const ledgerPath = seedLedger([
      { id: 'a', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'a', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', measured: 10, expected: 5 },
        ],
      },
    };

    const result = autoClosePtoF(residual, {
      spawnTool: mockSpawn(true),
      ledgerPath,
      specDir,
    });

    assert.strictEqual(result.entries_processed, 1);
    assert.ok(result.actions_taken[0].includes('Dispatched parameter update for a'));
    assert.strictEqual(spawnCalls.length, 1);

    // Verify entry transitioned to resolved
    const entries = readLedgerEntries(ledgerPath);
    assert.strictEqual(entries[0].status, 'resolved');
    assert.ok(entries[0].meta.remediation_log.includes('parameter update'));
  });

  it('flags investigation for issue entries (no dispatch)', () => {
    const ledgerPath = seedLedger([
      { id: 'b', status: 'acknowledged', issue_type: 'issue', formal_ref: 'requirement:REL-01', meta: { measured_value: 'failing' }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'b', formal_ref: 'requirement:REL-01', measured: 'failing', expected: null },
        ],
      },
    };

    const result = autoClosePtoF(residual, {
      spawnTool: mockSpawn(true),
      isNumericThreshold: () => false,
      ledgerPath,
    });

    assert.strictEqual(result.entries_processed, 1);
    assert.ok(result.actions_taken[0].includes('Flagged b for investigation'));
    assert.strictEqual(spawnCalls.length, 0); // No dispatch for investigation track

    // Verify entry is in resolving status (frozen for investigation)
    const entries = readLedgerEntries(ledgerPath);
    assert.strictEqual(entries[0].status, 'resolving');
    assert.ok(entries[0].meta.investigation_notes.includes('manual review'));
  });

  it('flags investigation for drift + non-numeric threshold (invariant ref)', () => {
    const ledgerPath = seedLedger([
      { id: 'c', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/invariant-consistency', meta: { measured_value: 'fail' }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'c', formal_ref: 'spec:safety/invariant-consistency', measured: 'fail', expected: null },
        ],
      },
    };

    const result = autoClosePtoF(residual, {
      spawnTool: mockSpawn(true),
      isNumericThreshold: () => false,
      ledgerPath,
    });

    assert.ok(result.actions_taken[0].includes('Flagged c for investigation'));
    assert.strictEqual(spawnCalls.length, 0);
  });

  it('handles failed dispatch (entry stays in resolving)', () => {
    const specDir = seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const ledgerPath = seedLedger([
      { id: 'd', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'd', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', measured: 10, expected: 5 },
        ],
      },
    };

    const result = autoClosePtoF(residual, {
      spawnTool: mockSpawn(false),
      ledgerPath,
      specDir,
    });

    assert.ok(result.actions_taken[0].includes('Failed to dispatch'));

    // Entry stays in resolving (state machine does not allow resolving->acknowledged)
    const entries = readLedgerEntries(ledgerPath);
    assert.strictEqual(entries[0].status, 'resolving');
  });

  it('handles mixed batch: success, investigation, failure', () => {
    const specDir = seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\nMaxSize = 3\n');
    const ledgerPath = seedLedger([
      { id: 'e1', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 }, title: 'test' },
      { id: 'e2', status: 'acknowledged', issue_type: 'issue', formal_ref: 'requirement:REL-01', meta: { measured_value: 'fail' }, title: 'test' },
      { id: 'e3', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxSize', meta: { measured_value: 99 }, title: 'test' },
    ]);

    let callCount = 0;
    const mixedSpawn = () => {
      callCount++;
      spawnCalls.push({ script: 'nf-quick.cjs', args: [] });
      // First call succeeds, second fails (e2 is investigation so no call, e3 is second dispatch)
      return { ok: callCount === 1 };
    };

    const residual = {
      residual: 3,
      detail: {
        divergent_entries: [
          { id: 'e1', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', measured: 10, expected: 5 },
          { id: 'e2', formal_ref: 'requirement:REL-01', measured: 'fail', expected: null },
          { id: 'e3', formal_ref: 'spec:safety/MCsafety.cfg:MaxSize', measured: 99, expected: 3 },
        ],
      },
    };

    const result = autoClosePtoF(residual, {
      spawnTool: mixedSpawn,
      ledgerPath,
      specDir,
    });

    assert.strictEqual(result.entries_processed, 3);
    assert.strictEqual(result.actions_taken.length, 3);

    const entries = readLedgerEntries(ledgerPath);
    assert.strictEqual(entries[0].status, 'resolved');        // e1: success dispatch
    assert.strictEqual(entries[1].status, 'resolving');       // e2: investigation
    assert.strictEqual(entries[2].status, 'resolving');       // e3: failed dispatch
  });

  it('defaults to investigation track for ambiguous entry (no issue_type)', () => {
    const ledgerPath = seedLedger([
      { id: 'f', status: 'acknowledged', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'f', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', measured: 10, expected: 5 },
        ],
      },
    };

    const result = autoClosePtoF(residual, {
      spawnTool: mockSpawn(true),
      isNumericThreshold: () => true,
      ledgerPath,
    });

    // issue_type is undefined -> NOT 'drift' -> investigation track
    assert.ok(result.actions_taken[0].includes('Flagged f for investigation'));
    assert.strictEqual(spawnCalls.length, 0);
  });

  it('writes audit trail to meta.remediation_log for dispatched entries', () => {
    const specDir = seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const ledgerPath = seedLedger([
      { id: 'g', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'g', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', measured: 10, expected: 5 },
        ],
      },
    };

    autoClosePtoF(residual, { spawnTool: mockSpawn(true), ledgerPath, specDir });

    const entries = readLedgerEntries(ledgerPath);
    assert.ok(entries[0].meta.remediation_log.includes('parameter update'));
    assert.ok(entries[0].meta.remediation_log.includes('MCsafety.cfg'));
  });

  it('writes investigation_notes for flagged entries', () => {
    const ledgerPath = seedLedger([
      { id: 'h', status: 'acknowledged', issue_type: 'issue', formal_ref: 'requirement:REL-01', meta: { measured_value: 'fail' }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'h', formal_ref: 'requirement:REL-01', measured: 'fail', expected: null },
        ],
      },
    };

    autoClosePtoF(residual, {
      spawnTool: mockSpawn(true),
      isNumericThreshold: () => false,
      ledgerPath,
    });

    const entries = readLedgerEntries(ledgerPath);
    assert.ok(entries[0].meta.investigation_notes.includes('manual review'));
    assert.ok(entries[0].meta.investigation_notes.includes('REL-01'));
  });

  it('persists ledger to disk after processing', () => {
    const specDir = seedSpec('safety/MCsafety.cfg', 'MaxDeliberation = 5\n');
    const ledgerPath = seedLedger([
      { id: 'i', status: 'acknowledged', issue_type: 'drift', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', meta: { measured_value: 10 }, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'i', formal_ref: 'spec:safety/MCsafety.cfg:MaxDeliberation', measured: 10, expected: 5 },
        ],
      },
    };

    let writeCalled = false;
    const mockWrite = (path, ledger) => {
      writeCalled = true;
      fs.writeFileSync(path, JSON.stringify(ledger, null, 2));
    };

    autoClosePtoF(residual, {
      spawnTool: mockSpawn(true),
      writeDebtLedger: mockWrite,
      ledgerPath,
      specDir,
    });

    assert.ok(writeCalled);
  });

  it('skips null divergent entries without crashing (corrupt residual detail)', () => {
    const ledgerPath = seedLedger([
      { id: 'a', status: 'acknowledged', issue_type: 'issue', formal_ref: 'requirement:REL-01', meta: {}, title: 'test' },
    ]);

    const residual = {
      residual: 2,
      detail: {
        divergent_entries: [
          null,
          { id: 'a', formal_ref: 'requirement:REL-01', measured: 'fail', expected: null },
        ],
      },
    };

    let result;
    assert.doesNotThrow(() => {
      result = autoClosePtoF(residual, { isNumericThreshold: () => false, ledgerPath });
    });

    // The valid entry 'a' is still flagged despite the null sibling
    assert.ok(result.actions_taken.some(a => a.includes('Flagged a for investigation')));
  });

  it('skips null entries in ledger debt_entries without crashing (corrupt debt.json)', () => {
    const ledgerPath = seedLedger([
      null,
      { id: 'b', status: 'acknowledged', issue_type: 'issue', formal_ref: 'requirement:REL-01', meta: {}, title: 'test' },
    ]);

    const residual = {
      residual: 1,
      detail: {
        divergent_entries: [
          { id: 'b', formal_ref: 'requirement:REL-01', measured: 'fail', expected: null },
        ],
      },
    };

    let result;
    assert.doesNotThrow(() => {
      result = autoClosePtoF(residual, { isNumericThreshold: () => false, ledgerPath });
    });

    assert.ok(result.actions_taken.some(a => a.includes('Flagged b for investigation')));
  });
});
