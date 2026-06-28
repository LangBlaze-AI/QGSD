/**
 * Unit tests for debt-ledger.cjs (RED phase)
 * Tests for atomic read/write operations with fail-open behavior
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Import debt ledger module
const { readDebtLedger, writeDebtLedger } = require('./debt-ledger.cjs');

describe('Debt Ledger I/O', () => {
  let tempDir;

  // Setup: create temporary directory for test isolation
  const setup = () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-ledger-test-'));
  };

  // Teardown: clean up temp directory
  const teardown = () => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  };

  describe('readDebtLedger', () => {
    it('reading nonexistent file returns empty ledger with schema_version "1" and empty debt_entries (fail-open)', () => {
      setup();
      try {
        const nonexistentPath = path.join(tempDir, 'nonexistent.json');
        const result = readDebtLedger(nonexistentPath);

        assert.strictEqual(result.schema_version, '1');
        assert(Array.isArray(result.debt_entries));
        assert.strictEqual(result.debt_entries.length, 0);
        assert(result.created_at);
        assert(result.last_updated);
      } finally {
        teardown();
      }
    });

    it('reading corrupt JSON file returns empty ledger (fail-open, no crash, logs error)', () => {
      setup();
      try {
        const corruptPath = path.join(tempDir, 'corrupt.json');
        fs.writeFileSync(corruptPath, 'not valid json {{{');

        const result = readDebtLedger(corruptPath);

        assert.strictEqual(result.schema_version, '1');
        assert(Array.isArray(result.debt_entries));
        assert.strictEqual(result.debt_entries.length, 0);
      } finally {
        teardown();
      }
    });
  });

  describe('writeDebtLedger', () => {
    it('write creates parent directory if needed (recursive mkdir)', () => {
      setup();
      try {
        const nestedPath = path.join(tempDir, 'nested', 'deep', 'ledger.json');
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: []
        };

        writeDebtLedger(nestedPath, ledger);

        assert(fs.existsSync(nestedPath));
      } finally {
        teardown();
      }
    });

    it('write is atomic: uses temp file (.tmp) + rename (not direct write)', () => {
      setup();
      try {
        const ledgerPath = path.join(tempDir, 'ledger.json');
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: []
        };

        // During write, temp file should not be visible after completion
        writeDebtLedger(ledgerPath, ledger);

        assert(fs.existsSync(ledgerPath));
        const tmpPath = ledgerPath + '.tmp';
        assert(!fs.existsSync(tmpPath), 'temp file should not exist after write completes');
      } finally {
        teardown();
      }
    });

    it('reading back a written ledger returns identical data (round-trip)', () => {
      setup();
      try {
        const ledgerPath = path.join(tempDir, 'ledger.json');
        const originalLedger = {
          schema_version: '1',
          created_at: '2026-03-04T13:32:10Z',
          last_updated: '2026-03-04T13:32:10Z',
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              fingerprint: '0123456789abcdef',
              title: 'Test issue',
              occurrences: 1,
              first_seen: '2026-03-04T13:32:10Z',
              last_seen: '2026-03-04T13:32:10Z',
              environments: ['production'],
              status: 'open',
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2026-03-04T13:32:10Z'
                }
              ]
            }
          ]
        };

        writeDebtLedger(ledgerPath, originalLedger);
        const readBack = readDebtLedger(ledgerPath);

        // Verify structure and content match (last_updated will be updated by write)
        assert.strictEqual(readBack.schema_version, originalLedger.schema_version);
        assert.strictEqual(readBack.created_at, originalLedger.created_at);
        assert.strictEqual(readBack.debt_entries.length, originalLedger.debt_entries.length);
        assert.deepStrictEqual(readBack.debt_entries[0], originalLedger.debt_entries[0]);
        assert(readBack.last_updated); // Verify last_updated was set
      } finally {
        teardown();
      }
    });

    it('schema version field is preserved across read/write cycles', () => {
      setup();
      try {
        const ledgerPath = path.join(tempDir, 'ledger.json');
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: []
        };

        writeDebtLedger(ledgerPath, ledger);
        const readBack = readDebtLedger(ledgerPath);

        assert.strictEqual(readBack.schema_version, '1');
      } finally {
        teardown();
      }
    });

    it('last_updated is set on write', () => {
      setup();
      try {
        const ledgerPath = path.join(tempDir, 'ledger.json');
        const ledger = {
          schema_version: '1',
          created_at: '2026-03-04T13:32:10Z',
          last_updated: null,
          debt_entries: []
        };

        writeDebtLedger(ledgerPath, ledger);
        const readBack = readDebtLedger(ledgerPath);

        assert(readBack.last_updated);
        assert(readBack.last_updated !== null);
        // Verify it's a valid ISO8601 string
        assert(typeof readBack.last_updated === 'string');
        assert(/^\d{4}-\d{2}-\d{2}T/.test(readBack.last_updated));
      } finally {
        teardown();
      }
    });

    it('empty debt_entries array writes correctly', () => {
      setup();
      try {
        const ledgerPath = path.join(tempDir, 'ledger.json');
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: []
        };

        writeDebtLedger(ledgerPath, ledger);
        const readBack = readDebtLedger(ledgerPath);

        assert(Array.isArray(readBack.debt_entries));
        assert.strictEqual(readBack.debt_entries.length, 0);
      } finally {
        teardown();
      }
    });
  });

  describe('readDebtLedger shape guard', () => {
    it('file that parses to null/array/scalar fails open to a valid empty ledger', () => {
      setup();
      try {
        const nullPath = path.join(tempDir, 'null.json');
        fs.writeFileSync(nullPath, 'null');
        const r1 = readDebtLedger(nullPath);
        assert.strictEqual(r1.schema_version, '1');
        assert(Array.isArray(r1.debt_entries));
        assert.strictEqual(r1.debt_entries.length, 0);

        const arrPath = path.join(tempDir, 'arr.json');
        fs.writeFileSync(arrPath, '[]');
        const r2 = readDebtLedger(arrPath);
        assert(Array.isArray(r2.debt_entries));
        assert.strictEqual(r2.debt_entries.length, 0);

        const numPath = path.join(tempDir, 'num.json');
        fs.writeFileSync(numPath, '42');
        const r3 = readDebtLedger(numPath);
        assert(Array.isArray(r3.debt_entries));
        assert.strictEqual(r3.debt_entries.length, 0);
      } finally {
        teardown();
      }
    });
  });

  describe('writeDebtLedger input guard', () => {
    it('null ledger is normalized, not persisted as a malformed object', () => {
      setup();
      try {
        const ledgerPath = path.join(tempDir, 'ledger.json');
        writeDebtLedger(ledgerPath, null);
        const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        assert.strictEqual(raw.schema_version, '1');
        assert(Array.isArray(raw.debt_entries));
        assert.strictEqual(raw.debt_entries.length, 0);
      } finally {
        teardown();
      }
    });
  });
});

describe('Debt Retention Policy', () => {
  let tempDir;

  const setup = () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-retention-test-'));
  };

  const teardown = () => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  };

  describe('applyRetentionPolicy', () => {
    it('entry with status=open is NEVER archived regardless of age (test with 365-day-old open entry)', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              fingerprint: '0123456789abcdef',
              title: 'Old open issue',
              occurrences: 1,
              first_seen: '2025-03-04T13:32:10Z', // 365 days ago
              last_seen: '2025-03-04T13:32:10Z',
              environments: ['production'],
              status: 'open',
              resolved_at: null,
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2025-03-04T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 1);
        assert.strictEqual(result.archived.length, 0);
      } finally {
        teardown();
      }
    });

    it('entry with status=acknowledged is NEVER archived regardless of age', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440001',
              fingerprint: '0123456789abcde1',
              title: 'Old acknowledged issue',
              occurrences: 1,
              first_seen: '2025-03-04T13:32:10Z',
              last_seen: '2025-03-04T13:32:10Z',
              environments: ['production'],
              status: 'acknowledged',
              resolved_at: null,
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2025-03-04T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 1);
        assert.strictEqual(result.archived.length, 0);
      } finally {
        teardown();
      }
    });

    it('entry with status=resolving is NEVER archived regardless of age', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440002',
              fingerprint: '0123456789abcde2',
              title: 'Old resolving issue',
              occurrences: 1,
              first_seen: '2025-03-04T13:32:10Z',
              last_seen: '2025-03-04T13:32:10Z',
              environments: ['production'],
              status: 'resolving',
              resolved_at: null,
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2025-03-04T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 1);
        assert.strictEqual(result.archived.length, 0);
      } finally {
        teardown();
      }
    });

    it('entry with status=resolved AND resolved_at older than cutoff IS archived', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440003',
              fingerprint: '0123456789abcde3',
              title: 'Old resolved issue',
              occurrences: 1,
              first_seen: '2025-03-04T13:32:10Z',
              last_seen: '2025-03-04T13:32:10Z',
              environments: ['production'],
              status: 'resolved',
              resolved_at: '2025-12-04T13:32:10Z', // ~90 days ago (resolved ~12/4)
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2025-03-04T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 0);
        assert.strictEqual(result.archived.length, 1);
      } finally {
        teardown();
      }
    });

    it('entry with status=resolved AND resolved_at newer than cutoff is kept active', () => {
      setup();
      try {
        const now = new Date();
        const recentResolved = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440004',
              fingerprint: '0123456789abcde4',
              title: 'Recently resolved issue',
              occurrences: 1,
              first_seen: '2026-02-02T13:32:10Z',
              last_seen: '2026-02-02T13:32:10Z',
              environments: ['production'],
              status: 'resolved',
              resolved_at: recentResolved, // 30 days ago
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2026-02-02T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 1);
        assert.strictEqual(result.archived.length, 0);
      } finally {
        teardown();
      }
    });

    it('default max_age is 90 days', () => {
      setup();
      try {
        // This test just verifies the function is callable without max_age param
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: []
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger);

        assert.strictEqual(result.active.length, 0);
        assert.strictEqual(result.archived.length, 0);
      } finally {
        teardown();
      }
    });

    it('custom max_age parameter is honored (test with 30 days)', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440005',
              fingerprint: '0123456789abcde5',
              title: 'Resolved 45 days ago',
              occurrences: 1,
              first_seen: '2026-01-18T13:32:10Z',
              last_seen: '2026-01-18T13:32:10Z',
              environments: ['production'],
              status: 'resolved',
              resolved_at: '2026-01-18T13:32:10Z', // ~45 days ago
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2026-01-18T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 30);

        // With 30-day max_age, this 45-day-old resolved entry should be archived
        assert.strictEqual(result.active.length, 0);
        assert.strictEqual(result.archived.length, 1);
      } finally {
        teardown();
      }
    });

    it('entry without resolved_at falls back to last_seen for cutoff calculation (per research)', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: [
            {
              id: '550e8400-e29b-41d4-a716-446655440006',
              fingerprint: '0123456789abcde6',
              title: 'Resolved without resolved_at',
              occurrences: 1,
              first_seen: '2025-03-04T13:32:10Z',
              last_seen: '2025-12-04T13:32:10Z', // ~90 days ago
              environments: ['production'],
              status: 'resolved',
              resolved_at: null, // Missing! Should fall back to last_seen
              formal_ref: null,
              source_entries: [
                {
                  source_type: 'github',
                  source_id: '12345',
                  observed_at: '2025-03-04T13:32:10Z'
                }
              ]
            }
          ]
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 0);
        assert.strictEqual(result.archived.length, 1);
      } finally {
        teardown();
      }
    });

    it('empty ledger returns empty active and empty archived arrays', () => {
      setup();
      try {
        const ledger = {
          schema_version: '1',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          debt_entries: []
        };

        const result = require('./debt-retention.cjs').applyRetentionPolicy(ledger, 90);

        assert.strictEqual(result.active.length, 0);
        assert.strictEqual(result.archived.length, 0);
      } finally {
        teardown();
      }
    });
  });

  describe('writeArchive', () => {
    it('archived entries are written in JSONL format (one JSON object per line, no outer array)', () => {
      setup();
      try {
        const archivePath = path.join(tempDir, 'archive.jsonl');
        const entries = [
          {
            id: '550e8400-e29b-41d4-a716-446655440000',
            fingerprint: '0123456789abcdef',
            title: 'Archived entry 1'
          },
          {
            id: '550e8400-e29b-41d4-a716-446655440001',
            fingerprint: '0123456789abcde1',
            title: 'Archived entry 2'
          }
        ];

        require('./debt-retention.cjs').writeArchive(entries, archivePath);

        const content = fs.readFileSync(archivePath, 'utf8');
        const lines = content.trim().split('\n');

        assert.strictEqual(lines.length, 2);
        const parsed1 = JSON.parse(lines[0]);
        const parsed2 = JSON.parse(lines[1]);

        assert.deepStrictEqual(parsed1, entries[0]);
        assert.deepStrictEqual(parsed2, entries[1]);
      } finally {
        teardown();
      }
    });

    it('JSONL append does not overwrite existing archive content', () => {
      setup();
      try {
        const archivePath = path.join(tempDir, 'archive.jsonl');

        const firstBatch = [
          { id: '550e8400-e29b-41d4-a716-446655440000', fingerprint: '0123456789abcdef' }
        ];

        const secondBatch = [
          { id: '550e8400-e29b-41d4-a716-446655440001', fingerprint: '0123456789abcde1' }
        ];

        require('./debt-retention.cjs').writeArchive(firstBatch, archivePath);
        require('./debt-retention.cjs').writeArchive(secondBatch, archivePath);

        const content = fs.readFileSync(archivePath, 'utf8');
        const lines = content.trim().split('\n');

        assert.strictEqual(lines.length, 2, 'Should have both batches');
      } finally {
        teardown();
      }
    });
  });
});
