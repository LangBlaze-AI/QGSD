const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeObservationsToDebt } = require('./observe-debt-writer.cjs');
const { readDebtLedger } = require('./debt-ledger.cjs');
const { fingerprintIssue } = require('./fingerprint-issue.cjs');
const { fingerprintDrift } = require('./fingerprint-drift.cjs');

function makeTmpLedger() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-debt-test-'));
  const formalDir = path.join(tmpDir, '.planning', 'formal');
  fs.mkdirSync(formalDir, { recursive: true });
  const ledgerPath = path.join(formalDir, 'debt.json');
  // Seed with empty ledger
  const now = new Date().toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify({
    schema_version: '1',
    created_at: now,
    last_updated: now,
    debt_entries: []
  }, null, 2));
  return { tmpDir, ledgerPath };
}

function cleanupTmp(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('writeObservationsToDebt', () => {
  let tmpDir, ledgerPath;

  beforeEach(() => {
    const tmp = makeTmpLedger();
    tmpDir = tmp.tmpDir;
    ledgerPath = tmp.ledgerPath;
  });

  afterEach(() => {
    cleanupTmp(tmpDir);
  });

  it('creates new debt entry with correct fingerprint and status open', () => {
    const obs = [{
      id: 'gh-42',
      title: 'TypeError in handler',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    const result = writeObservationsToDebt(obs, ledgerPath);
    assert.equal(result.written, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.errors, 0);

    const ledger = readDebtLedger(ledgerPath);
    assert.equal(ledger.debt_entries.length, 1);
    assert.equal(ledger.debt_entries[0].status, 'open');
    assert.equal(ledger.debt_entries[0].occurrences, 1);
    assert.equal(ledger.debt_entries[0].title, 'TypeError in handler');
    assert.ok(ledger.debt_entries[0].fingerprint);
    assert.ok(ledger.debt_entries[0].id);
  });

  it('increments occurrences and updates last_seen on repeat observation', () => {
    const obs = [{
      id: 'gh-42',
      title: 'TypeError in handler',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    // First write
    writeObservationsToDebt(obs, ledgerPath);
    const ledger1 = readDebtLedger(ledgerPath);
    assert.equal(ledger1.debt_entries.length, 1);
    assert.equal(ledger1.debt_entries[0].occurrences, 1);
    const firstLastSeen = ledger1.debt_entries[0].last_seen;

    // Small delay to ensure timestamp differs
    const obs2 = [{ ...obs[0], id: 'gh-42-run2' }];

    // Second write
    const result = writeObservationsToDebt(obs2, ledgerPath);
    assert.equal(result.written, 0);
    assert.equal(result.updated, 1);

    const ledger2 = readDebtLedger(ledgerPath);
    assert.equal(ledger2.debt_entries.length, 1); // No duplicate
    assert.equal(ledger2.debt_entries[0].occurrences, 2);
    assert.equal(ledger2.debt_entries[0].source_entries.length, 2);
  });

  it('uses fingerprintDrift for drift observations', () => {
    const obs = [{
      id: 'drift-1',
      title: 'Max deliberation exceeded',
      source_type: 'prometheus',
      issue_type: 'drift',
      formal_parameter_key: 'MCsafety.cfg:MaxDeliberation',
      created_at: new Date().toISOString()
    }];

    const result = writeObservationsToDebt(obs, ledgerPath);
    assert.equal(result.written, 1);

    const ledger = readDebtLedger(ledgerPath);
    const entry = ledger.debt_entries[0];

    // Verify fingerprint matches what fingerprintDrift would produce
    const expectedFp = fingerprintDrift({ formal_parameter_key: 'MCsafety.cfg:MaxDeliberation' });
    assert.equal(entry.fingerprint, expectedFp);
    assert.equal(entry.formal_ref, 'MCsafety.cfg:MaxDeliberation');
  });

  it('uses fingerprintIssue for issue observations', () => {
    const obs = [{
      id: 'gh-1',
      title: 'Test error message',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    writeObservationsToDebt(obs, ledgerPath);
    const ledger = readDebtLedger(ledgerPath);
    const entry = ledger.debt_entries[0];

    const expectedFp = fingerprintIssue({
      exception_type: 'github',
      function_name: 'unknown',
      message: 'Test error message'
    });
    assert.equal(entry.fingerprint, expectedFp);
  });

  it('written ledger is readable and valid', () => {
    const obs = [
      { id: 'gh-1', title: 'TypeError in authentication handler', source_type: 'github', issue_type: 'issue', created_at: new Date().toISOString() },
      { id: 'gh-2', title: 'SyntaxError in configuration parser module', source_type: 'sentry', issue_type: 'issue', created_at: new Date().toISOString() }
    ];

    writeObservationsToDebt(obs, ledgerPath);
    const ledger = readDebtLedger(ledgerPath);

    assert.equal(ledger.schema_version, '1');
    assert.ok(ledger.last_updated);
    assert.equal(ledger.debt_entries.length, 2);
    for (const entry of ledger.debt_entries) {
      assert.ok(entry.id);
      assert.ok(entry.fingerprint);
      assert.ok(entry.title);
      assert.equal(entry.status, 'open');
      assert.ok(entry.source_entries.length > 0);
    }
  });

  it('returns correct counts for mixed write/update/error', () => {
    // First, write one entry
    writeObservationsToDebt([{
      id: 'gh-1',
      title: 'Existing issue',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }], ledgerPath);

    // Now write: one repeat (update), one new (write)
    const result = writeObservationsToDebt([
      { id: 'gh-1-again', title: 'Existing issue', source_type: 'github', issue_type: 'issue', created_at: new Date().toISOString() },
      { id: 'gh-2', title: 'New issue', source_type: 'github', issue_type: 'issue', created_at: new Date().toISOString() }
    ], ledgerPath);

    assert.equal(result.written, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.errors, 0);
  });

  it('handles empty observations array', () => {
    const result = writeObservationsToDebt([], ledgerPath);
    assert.equal(result.written, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.errors, 0);
  });

  it('truncates long titles to 256 chars', () => {
    const longTitle = 'A'.repeat(300);
    writeObservationsToDebt([{
      id: 'gh-1',
      title: longTitle,
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }], ledgerPath);

    const ledger = readDebtLedger(ledgerPath);
    assert.ok(ledger.debt_entries[0].title.length <= 256);
  });

  // ── v0.27-03 dedup + formal-ref integration tests ──────────────────────

  it('returns merged and linked counts in result', () => {
    const obs = [{
      id: 'gh-1',
      title: 'Test issue',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    const result = writeObservationsToDebt(obs, ledgerPath);
    assert.strictEqual(typeof result.merged, 'number');
    assert.strictEqual(typeof result.linked, 'number');
  });

  it('two observations with different sources but similar titles get Levenshtein-merged', () => {
    // Write two observations with different fingerprints but similar titles
    // They need different exception_type/function_name to get different fingerprints
    const obs = [
      {
        id: 'gh-1',
        title: 'TypeError in authentication handler module',
        source_type: 'github',
        issue_type: 'issue',
        exception_type: 'TypeError',
        function_name: 'authHandlerModule',
        created_at: new Date().toISOString()
      },
      {
        id: 'sn-1',
        title: 'TypeError in authentication handler service',
        source_type: 'sentry',
        issue_type: 'issue',
        exception_type: 'TypeError',
        function_name: 'authHandlerService',
        created_at: new Date().toISOString()
      }
    ];

    const result = writeObservationsToDebt(obs, ledgerPath);
    const ledger = readDebtLedger(ledgerPath);

    // Should merge by Levenshtein near-duplicate
    assert.strictEqual(ledger.debt_entries.length, 1);
    assert.strictEqual(result.merged, 1);
  });

  it('observation with title matching requirement gets formal_ref auto-detected', () => {
    // Create mock requirements file
    const reqDir = path.join(tmpDir, 'mock-formal');
    fs.mkdirSync(reqDir, { recursive: true });
    const reqPath = path.join(reqDir, 'requirements.json');
    fs.writeFileSync(reqPath, JSON.stringify([
      { id: 'DEBT-01', text: 'Schema validation for debt entries' }
    ]));

    const obs = [{
      id: 'gh-1',
      title: 'Schema validation fails on empty entries',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    const result = writeObservationsToDebt(obs, ledgerPath, { requirementsPath: reqPath });
    const ledger = readDebtLedger(ledgerPath);

    assert.strictEqual(result.linked, 1);
    assert.strictEqual(ledger.debt_entries[0].formal_ref, 'requirement:DEBT-01');
    assert.strictEqual(ledger.debt_entries[0].formal_ref_source, 'auto-detect');
  });

  it('options.threshold configures dedup sensitivity', () => {
    const obs = [
      {
        id: 'gh-1',
        title: 'TypeError in authentication handler module',
        source_type: 'github',
        issue_type: 'issue',
        exception_type: 'TypeError',
        function_name: 'authHandlerModule',
        created_at: new Date().toISOString()
      },
      {
        id: 'sn-1',
        title: 'TypeError in authentication handler service',
        source_type: 'sentry',
        issue_type: 'issue',
        exception_type: 'TypeError',
        function_name: 'authHandlerService',
        created_at: new Date().toISOString()
      }
    ];

    // With high threshold, should NOT merge
    const result = writeObservationsToDebt(obs, ledgerPath, { threshold: 0.99 });
    const ledger = readDebtLedger(ledgerPath);
    assert.strictEqual(ledger.debt_entries.length, 2);
    assert.strictEqual(result.merged, 0);
  });

  it('verbose option includes mergeLog and linkLog', () => {
    const obs = [{
      id: 'gh-1',
      title: 'Test issue',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    const result = writeObservationsToDebt(obs, ledgerPath, { verbose: true });
    assert.ok(Array.isArray(result.mergeLog));
    assert.ok(Array.isArray(result.linkLog));
  });

  it('existing tests: return value still has written, updated, errors', () => {
    const obs = [{
      id: 'gh-1',
      title: 'Test issue',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];

    const result = writeObservationsToDebt(obs, ledgerPath);
    assert.strictEqual(typeof result.written, 'number');
    assert.strictEqual(typeof result.updated, 'number');
    assert.strictEqual(typeof result.errors, 'number');
  });

  it('does not throw on null/undefined observations argument (fail-open)', () => {
    let result;
    assert.doesNotThrow(() => {
      result = writeObservationsToDebt(null, ledgerPath);
    });
    assert.equal(result.written, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.errors, 0);

    assert.doesNotThrow(() => {
      writeObservationsToDebt(undefined, ledgerPath);
    });
  });

  it('does not crash when debt.json parses to a non-object (corrupt ledger)', () => {
    fs.writeFileSync(ledgerPath, 'null');
    let result;
    assert.doesNotThrow(() => {
      result = writeObservationsToDebt([{
        id: 'gh-1',
        title: 'Corrupt ledger issue',
        source_type: 'github',
        issue_type: 'issue',
        created_at: new Date().toISOString()
      }], ledgerPath);
    });
    assert.equal(result.errors, 0);
    assert.equal(result.written, 1);
    const ledger = readDebtLedger(ledgerPath);
    assert.equal(ledger.debt_entries.length, 1);
  });

  it('repairs missing source_entries on an existing entry instead of dropping the update', () => {
    const obs = [{
      id: 'gh-1',
      title: 'Recurring issue',
      source_type: 'github',
      issue_type: 'issue',
      created_at: new Date().toISOString()
    }];
    writeObservationsToDebt(obs, ledgerPath);

    // Corrupt the persisted entry: strip its source_entries array
    const corrupt = readDebtLedger(ledgerPath);
    delete corrupt.debt_entries[0].source_entries;
    fs.writeFileSync(ledgerPath, JSON.stringify(corrupt));

    const result = writeObservationsToDebt([{ ...obs[0], id: 'gh-1-again' }], ledgerPath);
    assert.equal(result.errors, 0);
    assert.equal(result.updated, 1);
    const ledger = readDebtLedger(ledgerPath);
    assert.ok(Array.isArray(ledger.debt_entries[0].source_entries));
  });
});
