'use strict';
// bin/memory-store.test.cjs
// Tests for JSONL-based memory store (MEMP-01/03/04).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getMemoryPath,
  appendEntry,
  readLastN,
  queryByField,
  isDuplicate,
  countEntries,
  generateSessionReminder,
  formatMemoryInjection,
  pruneOlderThan,
  computeCurrentConfidence,
  boostConfidence,
  queryWithConfidence,
  MEMORY_DIR,
  FILES,
} = require('./memory-store.cjs');

let tmpDir;

function freshTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
  return tmpDir;
}

function cleanTmp() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Helper: write a raw JSONL line with a specific timestamp
function writeRawEntry(cwd, category, entry) {
  const dir = path.join(cwd, MEMORY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, FILES[category]);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

describe('memory-store', () => {

  describe('constants', () => {
    it('exports expected file mappings', () => {
      assert.equal(FILES.decisions, 'decisions.jsonl');
      assert.equal(FILES.errors, 'errors.jsonl');
      assert.equal(FILES.quorum, 'quorum-decisions.jsonl');
      assert.equal(MEMORY_DIR, '.planning/memory');
    });
  });

  describe('new categories', () => {
    it('FILES has all 6 categories', () => {
      assert.equal(Object.keys(FILES).length, 6);
      assert.equal(FILES.corrections, 'corrections.jsonl');
      assert.equal(FILES.skills, 'skills.jsonl');
      assert.equal(FILES.failures, 'failures.jsonl');
    });

    it('getMemoryPath works for each new category', () => {
      const tmp = freshTmp();
      assert.ok(getMemoryPath(tmp, 'corrections').endsWith('corrections.jsonl'));
      assert.ok(getMemoryPath(tmp, 'skills').endsWith('skills.jsonl'));
      assert.ok(getMemoryPath(tmp, 'failures').endsWith('failures.jsonl'));
      cleanTmp();
    });
  });

  describe('getMemoryPath', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('returns correct path for each category', () => {
      assert.ok(getMemoryPath(tmpDir, 'decisions').endsWith('decisions.jsonl'));
      assert.ok(getMemoryPath(tmpDir, 'errors').endsWith('errors.jsonl'));
      assert.ok(getMemoryPath(tmpDir, 'quorum').endsWith('quorum-decisions.jsonl'));
    });

    it('creates .planning/memory/ directory if missing', () => {
      const dir = path.join(tmpDir, MEMORY_DIR);
      assert.ok(!fs.existsSync(dir));
      getMemoryPath(tmpDir, 'decisions');
      assert.ok(fs.existsSync(dir));
    });
  });

  describe('appendEntry', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('creates JSONL file and appends valid JSON line with ts field', () => {
      const result = appendEntry(tmpDir, 'decisions', { summary: 'Test', source: 'user' });
      assert.ok(result.ts, 'should have ts field');
      assert.equal(result.summary, 'Test');

      const filePath = getMemoryPath(tmpDir, 'decisions');
      const content = fs.readFileSync(filePath, 'utf8').trim();
      const parsed = JSON.parse(content);
      assert.equal(parsed.summary, 'Test');
      assert.ok(parsed.ts);
    });

    it('creates .planning/memory/ directory if missing', () => {
      const dir = path.join(tmpDir, MEMORY_DIR);
      assert.ok(!fs.existsSync(dir));
      appendEntry(tmpDir, 'decisions', { summary: 'Test' });
      assert.ok(fs.existsSync(dir));
    });

    it('appends multiple entries as separate lines', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'First' });
      appendEntry(tmpDir, 'decisions', { summary: 'Second' });
      const filePath = getMemoryPath(tmpDir, 'decisions');
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).summary, 'First');
      assert.equal(JSON.parse(lines[1]).summary, 'Second');
    });
  });

  describe('readLastN', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('returns empty array when file missing', () => {
      const result = readLastN(tmpDir, 'decisions', 5);
      assert.deepStrictEqual(result, []);
    });

    it('returns last N entries in correct order (newest last)', () => {
      for (let i = 1; i <= 5; i++) {
        appendEntry(tmpDir, 'decisions', { summary: `Decision ${i}` });
      }
      const result = readLastN(tmpDir, 'decisions', 3);
      assert.equal(result.length, 3);
      assert.equal(result[0].summary, 'Decision 3');
      assert.equal(result[1].summary, 'Decision 4');
      assert.equal(result[2].summary, 'Decision 5');
    });

    it('skips malformed JSON lines gracefully', () => {
      const filePath = getMemoryPath(tmpDir, 'decisions');
      fs.appendFileSync(filePath, '{"summary":"Good"}\n', 'utf8');
      fs.appendFileSync(filePath, 'not-json\n', 'utf8');
      fs.appendFileSync(filePath, '{"summary":"AlsoGood"}\n', 'utf8');
      const result = readLastN(tmpDir, 'decisions', 5);
      assert.equal(result.length, 2);
      assert.equal(result[0].summary, 'Good');
      assert.equal(result[1].summary, 'AlsoGood');
    });

    it('returns all entries when N exceeds file size', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Only one' });
      const result = readLastN(tmpDir, 'decisions', 100);
      assert.equal(result.length, 1);
      assert.equal(result[0].summary, 'Only one');
    });
  });

  describe('queryByField', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('matches substring case-insensitively on specified field', () => {
      appendEntry(tmpDir, 'errors', { symptom: 'EACCES permission denied', fix: 'chmod' });
      appendEntry(tmpDir, 'errors', { symptom: 'ENOENT file not found', fix: 'create' });
      const result = queryByField(tmpDir, 'errors', 'symptom', 'eacces');
      assert.equal(result.length, 1);
      assert.ok(result[0].symptom.includes('EACCES'));
    });

    it('also matches on tags array values', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Some decision', tags: ['install', 'hooks'] });
      appendEntry(tmpDir, 'decisions', { summary: 'Other decision', tags: ['config'] });
      const result = queryByField(tmpDir, 'decisions', 'summary', 'hooks');
      assert.equal(result.length, 1);
      assert.equal(result[0].summary, 'Some decision');
    });

    it('returns results newest-first, respects limit', () => {
      for (let i = 1; i <= 10; i++) {
        appendEntry(tmpDir, 'errors', { symptom: `Error ${i} EACCES`, fix: `Fix ${i}` });
      }
      const result = queryByField(tmpDir, 'errors', 'symptom', 'eacces', 3);
      assert.equal(result.length, 3);
      assert.equal(result[0].symptom, 'Error 10 EACCES');
      assert.equal(result[1].symptom, 'Error 9 EACCES');
      assert.equal(result[2].symptom, 'Error 8 EACCES');
    });

    it('returns empty array when file missing', () => {
      const result = queryByField(tmpDir, 'errors', 'symptom', 'anything');
      assert.deepStrictEqual(result, []);
    });

    it('returns empty array when no matches found', () => {
      appendEntry(tmpDir, 'errors', { symptom: 'Some error', fix: 'Some fix' });
      const result = queryByField(tmpDir, 'errors', 'symptom', 'nonexistent');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('isDuplicate', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('detects matching entries in recent history', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Use JSONL for storage' });
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'Use JSONL for storage'), true);
    });

    it('returns false when no match exists', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Use JSONL for storage' });
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'Something completely different'), false);
    });

    it('handles bidirectional substring matching', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Use JSONL' });
      // Needle contains hay
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'Use JSONL for memory stores'), true);
      // Hay contains needle
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'JSONL'), true);
    });

    it('is case-insensitive', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Use JSONL' });
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'use jsonl'), true);
    });

    it('returns false for empty file', () => {
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'anything'), false);
    });
  });

  describe('countEntries', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('returns 0 for missing file', () => {
      assert.equal(countEntries(tmpDir, 'decisions'), 0);
    });

    it('returns correct count for populated file', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'One' });
      appendEntry(tmpDir, 'decisions', { summary: 'Two' });
      appendEntry(tmpDir, 'decisions', { summary: 'Three' });
      assert.equal(countEntries(tmpDir, 'decisions'), 3);
    });

    it('returns 0 for empty file', () => {
      const filePath = getMemoryPath(tmpDir, 'decisions');
      fs.writeFileSync(filePath, '', 'utf8');
      assert.equal(countEntries(tmpDir, 'decisions'), 0);
    });
  });

  describe('generateSessionReminder', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('returns null when no memory entries exist', () => {
      assert.equal(generateSessionReminder(tmpDir), null);
    });

    it('includes last 3 decisions with phase and source', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Dec 1', phase: 'v0.30-01', source: 'quorum' });
      appendEntry(tmpDir, 'decisions', { summary: 'Dec 2', phase: 'v0.30-02', source: 'research' });
      appendEntry(tmpDir, 'decisions', { summary: 'Dec 3', phase: 'v0.30-03', source: 'user' });
      const result = generateSessionReminder(tmpDir);
      assert.ok(result.includes('SESSION MEMORY REMINDER:'));
      assert.ok(result.includes('[v0.30-01] Dec 1 (quorum)'));
      assert.ok(result.includes('[v0.30-02] Dec 2 (research)'));
      assert.ok(result.includes('[v0.30-03] Dec 3 (user)'));
    });

    it('includes error count and quorum count', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Dec 1', phase: 'test', source: 'user' });
      appendEntry(tmpDir, 'errors', { symptom: 'Err 1', fix: 'Fix 1' });
      appendEntry(tmpDir, 'errors', { symptom: 'Err 2', fix: 'Fix 2' });
      appendEntry(tmpDir, 'quorum', { question: 'Q1', chosen: 'A' });
      const result = generateSessionReminder(tmpDir);
      assert.ok(result.includes('Error patterns: 2 entries'));
      assert.ok(result.includes('Quorum decisions: 1 entries'));
    });

    it('respects 800 character cap', () => {
      // Add many long entries to exceed 800 chars
      for (let i = 0; i < 50; i++) {
        appendEntry(tmpDir, 'decisions', {
          summary: `Very long decision summary number ${i} with lots of extra text to pad the output beyond the character limit`,
          phase: 'v0.30-03',
          source: 'quorum',
        });
      }
      for (let i = 0; i < 50; i++) {
        appendEntry(tmpDir, 'errors', { symptom: `Error ${i}`, fix: `Fix ${i}` });
      }
      for (let i = 0; i < 50; i++) {
        appendEntry(tmpDir, 'quorum', { question: `Q${i}`, chosen: `A${i}` });
      }
      const result = generateSessionReminder(tmpDir);
      assert.ok(result.length <= 800, `Expected <= 800 chars, got ${result.length}`);
    });
  });

  describe('formatMemoryInjection', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('returns null when no memory entries exist', () => {
      assert.equal(formatMemoryInjection(tmpDir), null);
    });

    it('includes last 3 decisions and last 2 errors', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Dec A', phase: 'v0.30-01' });
      appendEntry(tmpDir, 'decisions', { summary: 'Dec B', phase: 'v0.30-02' });
      appendEntry(tmpDir, 'decisions', { summary: 'Dec C', phase: 'v0.30-03' });
      appendEntry(tmpDir, 'errors', { symptom: 'Err X', fix: 'Fix X' });
      appendEntry(tmpDir, 'errors', { symptom: 'Err Y', fix: 'Fix Y' });
      const result = formatMemoryInjection(tmpDir);
      assert.ok(result.includes('## Memory Snapshot'));
      assert.ok(result.includes('Dec A'));
      assert.ok(result.includes('Dec B'));
      assert.ok(result.includes('Dec C'));
      assert.ok(result.includes('Err X'));
      assert.ok(result.includes('Err Y'));
    });

    it('respects 1200 character cap', () => {
      for (let i = 0; i < 50; i++) {
        appendEntry(tmpDir, 'decisions', {
          summary: `Very long decision summary number ${i} with lots of extra text to pad output significantly`,
          phase: 'v0.30-03',
        });
      }
      for (let i = 0; i < 50; i++) {
        appendEntry(tmpDir, 'errors', {
          symptom: `Very long error symptom description number ${i} with lots of extra words`,
          fix: `Very long fix description number ${i} with lots of implementation detail text`,
        });
      }
      const result = formatMemoryInjection(tmpDir);
      assert.ok(result.length <= 1200, `Expected <= 1200 chars, got ${result.length}`);
    });

    it('includes query hint line', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Dec 1', phase: 'test' });
      const result = formatMemoryInjection(tmpDir);
      assert.ok(result.includes('Query more: node bin/memory-store.cjs query-decisions --last 10'));
    });
  });

  describe('pruneOlderThan', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('removes entries older than N days', () => {
      const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      writeRawEntry(tmpDir, 'decisions', { summary: 'Old entry', ts: oldTs });
      appendEntry(tmpDir, 'decisions', { summary: 'Recent entry' });

      const result = pruneOlderThan(tmpDir, 'decisions', 90);
      assert.equal(result.removed, 1);
      assert.equal(result.remaining, 1);

      const remaining = readLastN(tmpDir, 'decisions', 10);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].summary, 'Recent entry');
    });

    it('preserves entries within retention window', () => {
      appendEntry(tmpDir, 'decisions', { summary: 'Recent 1' });
      appendEntry(tmpDir, 'decisions', { summary: 'Recent 2' });
      const result = pruneOlderThan(tmpDir, 'decisions', 90);
      assert.equal(result.removed, 0);
      assert.equal(result.remaining, 2);
    });

    it('handles missing file gracefully', () => {
      const result = pruneOlderThan(tmpDir, 'decisions', 90);
      assert.deepStrictEqual(result, { removed: 0, remaining: 0 });
    });

    it('handles empty file gracefully', () => {
      const filePath = getMemoryPath(tmpDir, 'decisions');
      fs.writeFileSync(filePath, '', 'utf8');
      const result = pruneOlderThan(tmpDir, 'decisions', 90);
      assert.deepStrictEqual(result, { removed: 0, remaining: 0 });
    });
  });

  describe('append-correction', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('appends a correction with required schema fields', () => {
      const result = appendEntry(tmpDir, 'corrections', {
        type: 'correction',
        wrong_approach: 'Using var',
        correct_approach: 'Using const',
        context: 'variable declarations',
        tags: ['js', 'style'],
      });
      assert.ok(result.ts);
      assert.equal(result.type, 'correction');
      assert.equal(result.wrong_approach, 'Using var');
      assert.equal(result.correct_approach, 'Using const');
      assert.equal(result.context, 'variable declarations');
      assert.deepStrictEqual(result.tags, ['js', 'style']);
    });
  });

  describe('append-skill', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('appends a skill with required schema fields', () => {
      const result = appendEntry(tmpDir, 'skills', {
        type: 'skill',
        skill: 'Use async IIFE pattern for hooks',
        evidence_count: 3,
        validated_by: ['codex-1', 'gemini-1'],
        tags: ['hooks', 'async'],
        confidence: 0.9,
      });
      assert.ok(result.ts);
      assert.equal(result.type, 'skill');
      assert.equal(result.skill, 'Use async IIFE pattern for hooks');
      assert.equal(result.evidence_count, 3);
      assert.deepStrictEqual(result.validated_by, ['codex-1', 'gemini-1']);
      assert.equal(result.confidence, 0.9);
    });
  });

  describe('append-failure', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('appends a failure with confidence=0.7, last_confirmed set, confirmation_count=1', () => {
      const entry = {
        type: 'failure',
        approach: 'Using SQLite for memory',
        context: 'memory persistence',
        why_failed: 'Too heavy for simple JSONL needs',
        confidence: 0.7,
        last_confirmed: new Date().toISOString(),
        confirmation_count: 1,
        tags: ['storage'],
      };
      const result = appendEntry(tmpDir, 'failures', entry);
      assert.ok(result.ts);
      assert.equal(result.confidence, 0.7);
      assert.ok(result.last_confirmed);
      assert.equal(result.confirmation_count, 1);
    });

    it('dedup prevents duplicate approach', () => {
      appendEntry(tmpDir, 'failures', {
        type: 'failure',
        approach: 'Using SQLite for memory',
        why_failed: 'Too heavy',
        confidence: 0.7,
        last_confirmed: new Date().toISOString(),
        confirmation_count: 1,
        tags: [],
      });
      assert.equal(isDuplicate(tmpDir, 'failures', 'approach', 'Using SQLite for memory'), true);
    });
  });

  describe('computeCurrentConfidence', () => {
    it('returns stored confidence for fresh entry (0 days old)', () => {
      const entry = { confidence: 0.7, last_confirmed: new Date().toISOString() };
      const result = computeCurrentConfidence(entry);
      assert.equal(result, 0.7);
    });

    it('decays by 0.1 for 14-day old entry', () => {
      const twoWeeksAgo = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
      const entry = { confidence: 0.7, last_confirmed: twoWeeksAgo };
      const result = computeCurrentConfidence(entry);
      assert.ok(Math.abs(result - 0.6) < 0.001, `Expected ~0.6 but got ${result}`);
    });

    it('floors at 0.1 for 84-day old entry (12 weeks decay)', () => {
      const longAgo = new Date(Date.now() - 84 * 86400 * 1000).toISOString();
      const entry = { confidence: 0.7, last_confirmed: longAgo };
      const result = computeCurrentConfidence(entry);
      assert.equal(result, 0.1);
    });

    it('returns 0.7 when missing fields', () => {
      const result = computeCurrentConfidence({});
      assert.equal(result, 0.7);
    });
  });

  describe('boostConfidence', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('boosts confidence by 0.2 and updates last_confirmed', () => {
      appendEntry(tmpDir, 'failures', {
        type: 'failure',
        approach: 'Using spawnSync for async ops',
        why_failed: 'blocks event loop',
        confidence: 0.7,
        last_confirmed: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
        confirmation_count: 1,
        tags: [],
      });

      const result = boostConfidence(tmpDir, 'spawnSync');
      assert.ok(result);
      assert.ok(Math.abs(result.confidence - 0.9) < 0.001, `Expected ~0.9 but got ${result.confidence}`);
      assert.equal(result.confirmation_count, 2);
      // last_confirmed should be recent (within last minute)
      const confAge = Date.now() - new Date(result.last_confirmed).getTime();
      assert.ok(confAge < 60000, 'last_confirmed should be very recent');
    });

    it('returns null when approach not found', () => {
      const result = boostConfidence(tmpDir, 'nonexistent');
      assert.equal(result, null);
    });

    it('clamps confidence at 1.0', () => {
      appendEntry(tmpDir, 'failures', {
        type: 'failure',
        approach: 'Test approach',
        why_failed: 'reason',
        confidence: 0.95,
        last_confirmed: new Date().toISOString(),
        confirmation_count: 1,
        tags: [],
      });

      const result = boostConfidence(tmpDir, 'Test approach');
      assert.ok(result);
      assert.equal(result.confidence, 1.0);
    });
  });

  describe('queryWithConfidence', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('filters by minConfidence and sorts by confidence descending', () => {
      // Add failures with different confidences
      const now = new Date().toISOString();
      const oldDate = new Date(Date.now() - 70 * 86400 * 1000).toISOString();

      writeRawEntry(tmpDir, 'failures', {
        type: 'failure', approach: 'High conf approach', why_failed: 'reason',
        confidence: 0.9, last_confirmed: now, confirmation_count: 3, tags: [], ts: now,
      });
      writeRawEntry(tmpDir, 'failures', {
        type: 'failure', approach: 'Low conf approach', why_failed: 'reason',
        confidence: 0.7, last_confirmed: oldDate, confirmation_count: 1, tags: [], ts: oldDate,
      });
      writeRawEntry(tmpDir, 'failures', {
        type: 'failure', approach: 'Medium conf approach', why_failed: 'reason',
        confidence: 0.5, last_confirmed: now, confirmation_count: 2, tags: [], ts: now,
      });

      // Query with min confidence 0.3 -- should include all except the decayed old one
      const results = queryWithConfidence(tmpDir, 'failures', 'approach', '', 0.3, 10);
      assert.ok(results.length >= 2);
      // First result should be highest confidence
      assert.ok(results[0]._currentConfidence >= results[1]._currentConfidence);
    });

    it('returns empty array when no entries above minConfidence', () => {
      const oldDate = new Date(Date.now() - 200 * 86400 * 1000).toISOString();
      writeRawEntry(tmpDir, 'failures', {
        type: 'failure', approach: 'Very old failure', why_failed: 'reason',
        confidence: 0.2, last_confirmed: oldDate, confirmation_count: 1, tags: [], ts: oldDate,
      });
      const results = queryWithConfidence(tmpDir, 'failures', 'approach', '', 0.5, 5);
      assert.equal(results.length, 0);
    });

    it('filters by keyword when provided', () => {
      const now = new Date().toISOString();
      writeRawEntry(tmpDir, 'failures', {
        type: 'failure', approach: 'SQLite approach', why_failed: 'reason',
        confidence: 0.9, last_confirmed: now, confirmation_count: 1, tags: [], ts: now,
      });
      writeRawEntry(tmpDir, 'failures', {
        type: 'failure', approach: 'Redis approach', why_failed: 'reason',
        confidence: 0.9, last_confirmed: now, confirmation_count: 1, tags: [], ts: now,
      });
      const results = queryWithConfidence(tmpDir, 'failures', 'approach', 'sqlite', 0.3, 5);
      assert.equal(results.length, 1);
      assert.ok(results[0].approach.includes('SQLite'));
    });
  });

  describe('query-corrections', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('readLastN returns corrections in order', () => {
      appendEntry(tmpDir, 'corrections', { type: 'correction', wrong_approach: 'A', correct_approach: 'B' });
      appendEntry(tmpDir, 'corrections', { type: 'correction', wrong_approach: 'C', correct_approach: 'D' });
      const results = readLastN(tmpDir, 'corrections', 5);
      assert.equal(results.length, 2);
      assert.equal(results[0].wrong_approach, 'A');
      assert.equal(results[1].wrong_approach, 'C');
    });
  });

  describe('query-skills', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('queryByField on tag works for skills', () => {
      appendEntry(tmpDir, 'skills', { type: 'skill', skill: 'Async IIFE', tags: ['hooks', 'async'] });
      appendEntry(tmpDir, 'skills', { type: 'skill', skill: 'Config merge', tags: ['config'] });
      const results = queryByField(tmpDir, 'skills', 'skill', 'hooks');
      assert.equal(results.length, 1);
      assert.equal(results[0].skill, 'Async IIFE');
    });
  });

  describe('computeCurrentConfidence — malformed timestamp', () => {
    it('returns a real number (not NaN) when last_confirmed is unparseable', () => {
      const entry = { confidence: 0.7, last_confirmed: 'garbage' };
      const result = computeCurrentConfidence(entry);
      assert.ok(!Number.isNaN(result), `Expected a number, got ${result}`);
      assert.equal(result, 0.7);
    });

    it('queryWithConfidence does not leak NaN-confidence entries past the minConfidence filter', () => {
      const tmp = freshTmp();
      writeRawEntry(tmp, 'failures', {
        type: 'failure', approach: 'bad date', why_failed: 'x',
        confidence: 0.7, last_confirmed: 'garbage', ts: 'garbage',
      });
      const results = queryWithConfidence(tmp, 'failures', 'approach', '', 0.9, 5);
      assert.ok(results.every(r => !Number.isNaN(r._currentConfidence)), 'no NaN confidences');
      assert.equal(results.length, 0, '0.7 < 0.9 so entry must be filtered out');
      cleanTmp();
    });
  });

  describe('isDuplicate — non-string stored field', () => {
    beforeEach(() => freshTmp());
    afterEach(() => cleanTmp());

    it('does not throw when a stored entry has a non-string field value', () => {
      writeRawEntry(tmpDir, 'decisions', { summary: 42, ts: new Date().toISOString() });
      writeRawEntry(tmpDir, 'decisions', { summary: { nested: true }, ts: new Date().toISOString() });
      assert.doesNotThrow(() => isDuplicate(tmpDir, 'decisions', 'summary', 'anything'));
      assert.equal(isDuplicate(tmpDir, 'decisions', 'summary', 'anything'), false);
    });
  });

  describe('computeCurrentConfidence — null entry', () => {
    it('returns default 0.7 for null/undefined instead of throwing', () => {
      assert.doesNotThrow(() => computeCurrentConfidence(null));
      assert.equal(computeCurrentConfidence(null), 0.7);
      assert.equal(computeCurrentConfidence(undefined), 0.7);
    });
  });
});
