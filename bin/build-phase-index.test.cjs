#!/usr/bin/env node

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  parseVerificationFrontmatter,
  extractKeywords,
  extractRequirementIds,
  extractObservableTruths,
  buildPhaseIndex,
  appendPhaseEntry
} = require('./build-phase-index.cjs');

describe('build-phase-index', () => {
  describe('parseVerificationFrontmatter', () => {
    it('should parse valid YAML frontmatter', () => {
      const content = `---
phase: v0.19-01
status: passed
score: 95
---
# Phase v0.19-01: Test Phase`;

      const result = parseVerificationFrontmatter(content);
      assert.strictEqual(result.phase, 'v0.19-01');
      assert.strictEqual(result.status, 'passed');
      assert.strictEqual(result.score, 95);
    });

    it('should return empty object for content with no frontmatter delimiters', () => {
      const content = '# No frontmatter here\nJust markdown.';
      const result = parseVerificationFrontmatter(content);
      assert.deepStrictEqual(result, {});
    });

    it('should return empty object for malformed YAML between delimiters', () => {
      const content = `---
: invalid: yaml: syntax:
---
# Content`;

      const result = parseVerificationFrontmatter(content);
      assert.deepStrictEqual(result, {});
    });
  });

  describe('extractRequirementIds', () => {
    it('should extract REQ IDs matching [A-Z]+-\\d+ pattern', () => {
      const content = `---
phase: v0.19-01
---
# Phase v0.19-01: Test
This uses UNIF-01, UNIF-02, CALIB-03 requirements.
Also ENV-01 and FAIL-01.`;

      const result = extractRequirementIds(content);
      assert.deepStrictEqual(result.sort(), ['CALIB-03', 'ENV-01', 'FAIL-01', 'UNIF-01', 'UNIF-02']);
    });

    it('should return empty array when no REQ IDs present', () => {
      const content = `---
phase: v0.10-01
---
# Phase v0.10-01: Old Phase
This is an older phase without structured requirements.`;

      const result = extractRequirementIds(content);
      assert.deepStrictEqual(result, []);
    });

    it('should deduplicate REQ IDs', () => {
      const content = 'UNIF-01 appears twice UNIF-01 in the content';
      const result = extractRequirementIds(content);
      assert.deepStrictEqual(result, ['UNIF-01']);
    });
  });

  describe('extractKeywords', () => {
    it('should extract keywords from directory name', () => {
      const dirName = 'v0.12-09-verification-quick-fixes';
      const result = extractKeywords(dirName, '', '');
      assert(result.includes('verification'));
      assert(result.includes('quick'));
      assert(result.includes('fixes'));
    });

    it('should filter stopwords from goal text', () => {
      const dirName = 'v0.10-01-test';
      const phaseGoal = 'The quick brown fox jumps over the lazy dog';
      const result = extractKeywords(dirName, phaseGoal, '');
      // Should include meaningful words, not stopwords like "the", "over", "lazy"
      assert(result.includes('quick'));
      assert(result.includes('brown'));
      assert(result.includes('fox'));
      assert(!result.includes('the'));
    });

    it('should extract domain-specific pattern words from truths text', () => {
      const dirName = 'v0.15-01-model';
      const phaseGoal = 'Model test phase';
      const truthsText = 'NDJSON output validated, TLA+ model checks pass';
      const result = extractKeywords(dirName, phaseGoal, truthsText);
      assert(result.includes('ndjson'));
      assert(result.includes('tla+'));
    });

    it('should cap keywords at 12 maximum', () => {
      const dirName = 'v0.10-01-a-b-c-d-e-f-g-h-i-j-k-l-m-n';
      const phaseGoal = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15';
      const result = extractKeywords(dirName, phaseGoal, '');
      assert(result.length <= 12);
    });

    it('should deduplicate keywords', () => {
      const dirName = 'v0.10-01-test-test-test';
      const result = extractKeywords(dirName, '', '');
      const testCount = result.filter(k => k === 'test').length;
      assert.strictEqual(testCount, 1);
    });
  });

  describe('extractObservableTruths', () => {
    it('should extract Observable Truths text from markdown table', () => {
      const content = `---
phase: v0.15-01
---
# Phase Test

| Observable Truth | Result |
|---|---|
| NDJSON output validated | PASS |
| TLA+ checks run | PASS |`;

      const result = extractObservableTruths(content);
      assert(result.includes('NDJSON'));
      assert(result.includes('TLA+'));
    });
  });

  describe('appendPhaseEntry', () => {
    let tempDir;
    let indexPath;

    before(() => {
      tempDir = fs.mkdtempSync(path.join('/tmp', 'phase-index-test-'));
      indexPath = path.join(tempDir, 'phase-index.json');
      process.chdir(tempDir);
    });

    after(() => {
      process.chdir('/Users/jonathanborduas/code/QGSD');
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should append new phase entry to index', () => {
      // Create formal dir
      fs.mkdirSync(path.join(tempDir, '.planning', 'formal'), { recursive: true });

      // Create a mock verification file
      const verPath = path.join(tempDir, 'test-ver.md');
      const verContent = `---
phase: v0.99-01
status: passed
---
# Phase v0.99-01: Test Phase
UNIF-01 and ENV-01 are requirements.`;

      fs.writeFileSync(verPath, verContent);

      // Call appendPhaseEntry
      appendPhaseEntry(tempDir, verPath);

      // Verify index was created
      assert(fs.existsSync(path.join(tempDir, '.planning/formal/phase-index.json')));

      const index = JSON.parse(fs.readFileSync(path.join(tempDir, '.planning/formal/phase-index.json'), 'utf-8'));
      assert.strictEqual(index.phases.length, 1);
      assert.strictEqual(index.phases[0].phase_id, 'v0.99-01');
      assert(index.phases[0].requirement_ids.includes('UNIF-01'));
    });

    it('should handle idempotent upsert (no duplicates)', () => {
      // Reset: create fresh formal dir
      const formalDir = path.join(tempDir, '.planning', 'formal');
      if (fs.existsSync(formalDir)) {
        fs.rmSync(formalDir, { recursive: true });
      }
      fs.mkdirSync(formalDir);

      const verPath = path.join(tempDir, 'test-ver.md');
      const verContent = `---
phase: v0.99-02
status: passed
---
# Phase v0.99-02: Upsert Test`;

      fs.writeFileSync(verPath, verContent);

      // Call twice with same phase
      appendPhaseEntry(tempDir, verPath);
      appendPhaseEntry(tempDir, verPath);

      const index = JSON.parse(fs.readFileSync(path.join(tempDir, '.planning/formal/phase-index.json'), 'utf-8'));
      const matching = index.phases.filter(p => p.phase_id === 'v0.99-02');
      assert.strictEqual(matching.length, 1, 'Should have exactly 1 entry for v0.99-02');
    });
  });

  describe('buildPhaseIndex integration', () => {
    let tempPhasesDir;
    let origCwd;

    before(() => {
      origCwd = process.cwd();
      const tempBase = fs.mkdtempSync(path.join('/tmp', 'phase-index-int-'));
      tempPhasesDir = path.join(tempBase, '.planning', 'phases');
      fs.mkdirSync(tempPhasesDir, { recursive: true });
      fs.mkdirSync(path.join(tempBase, '.planning', 'formal'), { recursive: true });
      process.chdir(tempBase);
    });

    after(() => {
      process.chdir(origCwd);
      fs.rmSync(path.dirname(tempPhasesDir), { recursive: true, force: true });
    });

    it('should build index from multiple VERIFICATION.md files and skip malformed ones', () => {
      // Create a newer phase with REQ IDs
      const newer = path.join(tempPhasesDir, 'v0.19-01-unified-verdict');
      fs.mkdirSync(newer);
      fs.writeFileSync(
        path.join(newer, 'v0.19-01-VERIFICATION.md'),
        `---
phase: v0.19-01
status: passed
score: 100
---
# Phase v0.19-01: Unified Verdict Format
UNIF-01 and UNIF-02 requirements.`
      );

      // Create an older phase without REQ IDs
      const older = path.join(tempPhasesDir, 'v0.12-01-quick-fix');
      fs.mkdirSync(older);
      fs.writeFileSync(
        path.join(older, 'v0.12-01-VERIFICATION.md'),
        `---
phase: v0.12-01
status: passed
---
# Phase v0.12-01: Quick Fixes
Quick fixes to the system for better performance.`
      );

      // Create a malformed phase (missing frontmatter)
      const malformed = path.join(tempPhasesDir, 'v0.11-01-bad');
      fs.mkdirSync(malformed);
      fs.writeFileSync(
        path.join(malformed, 'v0.11-01-VERIFICATION.md'),
        `No frontmatter here!
Just content.`
      );

      // Build the index
      const index = require('./build-phase-index.cjs').buildPhaseIndex();

      // Verify 2 entries (malformed skipped)
      assert.strictEqual(index.phases.length, 2);

      // Find the newer entry
      const newerEntry = index.phases.find(p => p.phase_id === 'v0.19-01');
      assert(newerEntry, 'v0.19-01 should be in index');
      assert.strictEqual(newerEntry.requirement_ids.length, 2);
      assert(newerEntry.requirement_ids.includes('UNIF-01'));

      // Find the older entry
      const olderEntry = index.phases.find(p => p.phase_id === 'v0.12-01');
      assert(olderEntry, 'v0.12-01 should be in index');
      assert(olderEntry.keywords.length > 0, 'Older entry should have keywords');

      // Verify file was written
      assert(fs.existsSync('.planning/formal/phase-index.json'));

      // Verify compact format
      const lines = fs.readFileSync('.planning/formal/phase-index.json', 'utf-8').split('\n');
      assert(lines.length < 50, 'Index should stay compact (< 50 lines for 2 entries)');
    });
  });

  describe('parseVerificationFrontmatter adversarial input', () => {
    it('should return empty object for non-string input (null/undefined/number)', () => {
      assert.deepStrictEqual(parseVerificationFrontmatter(null), {});
      assert.deepStrictEqual(parseVerificationFrontmatter(undefined), {});
      assert.deepStrictEqual(parseVerificationFrontmatter(42), {});
      assert.deepStrictEqual(parseVerificationFrontmatter({ phase: 'v0.1-01' }), {});
    });
  });

  describe('extractKeywords adversarial input', () => {
    it('should not throw when dirName is null or undefined', () => {
      assert.doesNotThrow(() => extractKeywords(null, 'distinctive goal words', ''));
      const result = extractKeywords(undefined, 'alpha beta gamma', 'NDJSON truths');
      assert(Array.isArray(result));
      assert(result.includes('alpha'));
      assert(result.includes('ndjson'));
    });
  });

  describe('appendPhaseEntry poisoned existing index', () => {
    let tempDir;
    before(() => {
      tempDir = fs.mkdtempSync(path.join('/tmp', 'phase-index-poison-'));
      fs.mkdirSync(path.join(tempDir, '.planning', 'formal'), { recursive: true });
      process.chdir(tempDir);
    });
    after(() => {
      process.chdir('/Users/jonathanborduas/code/QGSD');
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    it('should still upsert when existing phases array contains a null entry', () => {
      const indexPath = path.join(tempDir, '.planning', 'formal', 'phase-index.json');
      fs.writeFileSync(indexPath, JSON.stringify({ version: '1.0', generated_at: 'x', phases: [null] }));
      const verPath = path.join(tempDir, 'ver.md');
      fs.writeFileSync(verPath, '---\nphase: v0.99-09\nstatus: passed\n---\n# Phase v0.99-09: Poison Test');
      appendPhaseEntry(tempDir, verPath);
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const matching = index.phases.filter(p => p && p.phase_id === 'v0.99-09');
      assert.strictEqual(matching.length, 1, 'new entry should be persisted despite null poison');
    });
  });
});
