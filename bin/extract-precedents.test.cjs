#!/usr/bin/env node
'use strict';
// bin/extract-precedents.test.cjs
// Tests for bin/extract-precedents.cjs — precedent extraction from debate archives.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let mod;

describe('extract-precedents module', () => {
  before(() => {
    mod = require('./extract-precedents.cjs');
  });

  describe('Module exports', () => {
    it('loads without error', () => {
      assert.ok(mod);
    });

    it('exports extractPrecedentMetadata as a function', () => {
      assert.equal(typeof mod.extractPrecedentMetadata, 'function');
    });

    it('exports isPrecedentFresh as a function', () => {
      assert.equal(typeof mod.isPrecedentFresh, 'function');
    });

    it('exports main as a function', () => {
      assert.equal(typeof mod.main, 'function');
    });
  });

  describe('extractPrecedentMetadata', () => {
    const validDebate = `# Quorum Debate
Question: Should we use keyword matching for precedent lookup?
Date: 2026-03-10
Consensus: APPROVE
Rounds: 1

## Round 1
| Model | Position |
|---|---|
| Claude | APPROVE |

## Outcome
CONSENSUS: APPROVE (unanimous)

Implement keyword matching as the MVP approach for precedent lookup.
`;

    it('extracts all fields from a valid debate file', () => {
      const result = mod.extractPrecedentMetadata('test.md', validDebate);
      assert.ok(result);
      assert.equal(result.question, 'Should we use keyword matching for precedent lookup?');
      assert.equal(result.date, '2026-03-10');
      assert.equal(result.consensus, 'APPROVE');
      assert.ok(result.outcome.includes('CONSENSUS: APPROVE'));
      assert.equal(result.source_file, 'test.md');
      assert.ok(result.computed_at);
    });

    it('returns null for INCONCLUSIVE consensus', () => {
      const content = validDebate.replace('Consensus: APPROVE', 'Consensus: INCONCLUSIVE');
      const result = mod.extractPrecedentMetadata('test.md', content);
      assert.equal(result, null);
    });

    it('returns null when Date field is missing', () => {
      const content = validDebate.replace(/^Date:.*$/m, '');
      const result = mod.extractPrecedentMetadata('test.md', content);
      assert.equal(result, null);
    });

    it('returns null when Question field is missing', () => {
      const content = validDebate.replace(/^Question:.*$/m, '');
      const result = mod.extractPrecedentMetadata('test.md', content);
      assert.equal(result, null);
    });

    it('handles case-insensitive consensus: "consensus: approve"', () => {
      const content = validDebate.replace('Consensus: APPROVE', 'consensus: approve');
      const result = mod.extractPrecedentMetadata('test.md', content);
      assert.ok(result);
      assert.equal(result.consensus, 'APPROVE');
    });

    it('handles whitespace tolerance: "Consensus:  BLOCK"', () => {
      const content = validDebate.replace('Consensus: APPROVE', 'Consensus:  BLOCK');
      const result = mod.extractPrecedentMetadata('test.md', content);
      assert.ok(result);
      assert.equal(result.consensus, 'BLOCK');
    });

    it('extracts outcome text between ## Outcome and next heading or EOF', () => {
      const result = mod.extractPrecedentMetadata('test.md', validDebate);
      assert.ok(result);
      assert.ok(result.outcome.includes('keyword matching'));
    });

    it('computed_at is a valid ISO timestamp', () => {
      const result = mod.extractPrecedentMetadata('test.md', validDebate);
      assert.ok(result);
      const parsed = new Date(result.computed_at);
      assert.ok(!isNaN(parsed.getTime()));
    });

    it('source_file matches the provided filePath argument', () => {
      const result = mod.extractPrecedentMetadata('/path/to/debate.md', validDebate);
      assert.ok(result);
      assert.equal(result.source_file, '/path/to/debate.md');
    });

    it('returns null (does not throw) when content is not a string', () => {
      assert.equal(mod.extractPrecedentMetadata('test.md', null), null);
      assert.equal(mod.extractPrecedentMetadata('test.md', undefined), null);
      assert.equal(mod.extractPrecedentMetadata('test.md', 42), null);
    });
  });

  describe('isPrecedentFresh', () => {
    function makePrecedent(daysAgo) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return { date: d.toISOString().slice(0, 10) };
    }

    it('precedent dated today is fresh', () => {
      assert.equal(mod.isPrecedentFresh(makePrecedent(0)), true);
    });

    it('precedent dated 89 days ago is fresh', () => {
      assert.equal(mod.isPrecedentFresh(makePrecedent(89)), true);
    });

    it('precedent dated 91 days ago is stale', () => {
      assert.equal(mod.isPrecedentFresh(makePrecedent(91)), false);
    });

    it('invalid date string returns false without throwing', () => {
      assert.equal(mod.isPrecedentFresh({ date: 'not-a-date' }), false);
    });

    it('custom maxAgeMs parameter works (30 days)', () => {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      assert.equal(mod.isPrecedentFresh(makePrecedent(29), thirtyDays), true);
      assert.equal(mod.isPrecedentFresh(makePrecedent(31), thirtyDays), false);
    });
  });

  describe('main() integration', () => {
    let tmpDir;
    let outPath;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prec-test-'));
      outPath = path.join(tmpDir, 'precedents.json');

      // 1 APPROVE debate
      fs.writeFileSync(path.join(tmpDir, 'approve.md'), `# Quorum Debate
Question: Should we approve this?
Date: ${new Date().toISOString().slice(0, 10)}
Consensus: APPROVE
Rounds: 1

## Outcome
Yes, approved unanimously.
`);

      // 1 BLOCK debate
      fs.writeFileSync(path.join(tmpDir, 'block.md'), `# Quorum Debate
Question: Should we block this?
Date: ${new Date().toISOString().slice(0, 10)}
Consensus: BLOCK
Rounds: 1

## Outcome
Blocked due to risk.
`);

      // 1 INCONCLUSIVE debate (should be excluded)
      fs.writeFileSync(path.join(tmpDir, 'inconclusive.md'), `# Quorum Debate
Question: Should we consider this?
Date: ${new Date().toISOString().slice(0, 10)}
Consensus: INCONCLUSIVE
Rounds: 2

## Outcome
No consensus reached.
`);
    });

    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('produces output JSON with exactly 2 entries (INCONCLUSIVE excluded)', async () => {
      const result = await mod.main(tmpDir, outPath);
      assert.equal(result.precedents.length, 2);
    });

    it('output JSON has extracted_at, debate_count, skipped_count', async () => {
      const result = await mod.main(tmpDir, outPath);
      assert.ok(result.extracted_at);
      assert.equal(result.debate_count, 3);
      assert.equal(result.skipped_count, 1);
    });

    it('written file matches returned object', async () => {
      await mod.main(tmpDir, outPath);
      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.equal(written.precedents.length, 2);
      assert.ok(written.extracted_at);
    });

    it('no INCONCLUSIVE entries in output', async () => {
      const result = await mod.main(tmpDir, outPath);
      const hasInconclusive = result.precedents.some(p => p.consensus === 'INCONCLUSIVE');
      assert.equal(hasInconclusive, false);
    });

    it('skips directory entries ending in .md without crashing', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prec-eisdir-'));
      fs.mkdirSync(path.join(dir, 'notafile.md'));
      fs.writeFileSync(path.join(dir, 'valid.md'), `# Quorum Debate\nQuestion: Should we ship?\nDate: ${new Date().toISOString().slice(0, 10)}\nConsensus: APPROVE\nRounds: 1\n\n## Outcome\nApproved.\n`);
      const out = path.join(dir, 'out.json');
      const result = await mod.main(dir, out);
      assert.equal(result.precedents.length, 1);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
