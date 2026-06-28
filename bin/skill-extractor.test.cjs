#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { clusterByTags, generateCandidates } = require('./skill-extractor.cjs');
// Use local memory-store directly (installed version may be outdated)
const memStore = require('./memory-store.cjs');

describe('skill-extractor', () => {
  describe('clusterByTags', () => {
    it('should return empty array for empty input', () => {
      assert.deepStrictEqual(clusterByTags([]), []);
      assert.deepStrictEqual(clusterByTags(null), []);
    });

    it('should cluster entries with 2+ shared tags', () => {
      const entries = [
        { tags: ['hooks', 'async'], type: 'error_resolution', symptom: 'err1' },
        { tags: ['hooks', 'async'], type: 'error_resolution', symptom: 'err2' },
        { tags: ['other'], type: 'error_resolution', symptom: 'err3' },
      ];
      const clusters = clusterByTags(entries);
      assert.ok(clusters.length >= 1);
      // The cluster with hooks+async should have 2 entries
      const hookCluster = clusters.find(c => c.tags.includes('hooks') && c.tags.includes('async'));
      assert.ok(hookCluster);
      assert.strictEqual(hookCluster.entries.length, 2);
    });

    it('should not cluster entries with only 1 shared tag and < 2 entries', () => {
      const entries = [
        { tags: ['hooks'], type: 'error_resolution', symptom: 'err1' },
        { tags: ['other'], type: 'error_resolution', symptom: 'err2' },
      ];
      const clusters = clusterByTags(entries);
      // No pair of tags co-occurs in 2+ entries
      assert.strictEqual(clusters.length, 0);
    });

    it('should sort clusters by size descending', () => {
      const entries = [
        { tags: ['a', 'b'], type: 'error_resolution', symptom: 'e1' },
        { tags: ['a', 'b'], type: 'error_resolution', symptom: 'e2' },
        { tags: ['a', 'b'], type: 'error_resolution', symptom: 'e3' },
        { tags: ['c', 'd'], type: 'error_resolution', symptom: 'e4' },
        { tags: ['c', 'd'], type: 'error_resolution', symptom: 'e5' },
      ];
      const clusters = clusterByTags(entries);
      assert.ok(clusters.length >= 2);
      assert.ok(clusters[0].entries.length >= clusters[1].entries.length);
    });

    it('should skip null/non-object entries instead of throwing', () => {
      const entries = [
        { tags: ['hooks', 'async'], type: 'error_resolution', symptom: 'e1' },
        { tags: ['hooks', 'async'], type: 'error_resolution', symptom: 'e2' },
        null,
        { tags: ['hooks', 'async'], type: 'error_resolution', symptom: 'e3' },
      ];
      let clusters;
      assert.doesNotThrow(() => { clusters = clusterByTags(entries); });
      const hookCluster = clusters.find(c => c.tags.includes('hooks') && c.tags.includes('async'));
      assert.ok(hookCluster);
      assert.strictEqual(hookCluster.entries.length, 3);
    });

    it('should ignore non-array tags instead of iterating characters', () => {
      const entries = [
        { tags: 'hooks', type: 'error_resolution', symptom: 'e1' },
        { tags: 'hooks', type: 'error_resolution', symptom: 'e2' },
      ];
      let clusters;
      assert.doesNotThrow(() => { clusters = clusterByTags(entries); });
      // 'hooks' is a string, not an array — must NOT be split into char-tags h/o/k/s.
      assert.strictEqual(clusters.length, 0);
      // numeric tags must also be tolerated, not throw
      assert.doesNotThrow(() => clusterByTags([{ tags: 42 }, { tags: 42 }]));
    });
  });

  describe('generateCandidates', () => {
    it('should return empty array for empty clusters', () => {
      assert.deepStrictEqual(generateCandidates([]), []);
    });

    it('should only generate candidates from clusters with 3+ entries', () => {
      const clusters = [
        {
          tags: ['hooks', 'async'],
          entries: [
            { type: 'error_resolution', symptom: 'e1' },
            { type: 'error_resolution', symptom: 'e2' },
          ],
        },
      ];
      const candidates = generateCandidates(clusters);
      assert.strictEqual(candidates.length, 0);
    });

    it('should generate candidate for cluster with 3+ entries', () => {
      const clusters = [
        {
          tags: ['hooks', 'async'],
          entries: [
            { type: 'error_resolution', symptom: 'err1' },
            { type: 'error_resolution', symptom: 'err2' },
            { type: 'correction', wrong_approach: 'wrong1' },
          ],
        },
      ];
      const candidates = generateCandidates(clusters);
      assert.strictEqual(candidates.length, 1);
      assert.ok(candidates[0].skill.includes('hooks'));
      assert.strictEqual(candidates[0].evidence_count, 3);
      assert.deepStrictEqual(candidates[0].tags, ['hooks', 'async']);
    });

    it('should cap at maxCandidates (default 5)', () => {
      const clusters = [];
      for (let i = 0; i < 10; i++) {
        clusters.push({
          tags: ['tag' + i, 'shared'],
          entries: [
            { type: 'error_resolution', symptom: 'e1' },
            { type: 'error_resolution', symptom: 'e2' },
            { type: 'error_resolution', symptom: 'e3' },
          ],
        });
      }
      const candidates = generateCandidates(clusters);
      assert.strictEqual(candidates.length, 5);
    });

    it('should handle different entry types in evidence summaries', () => {
      const clusters = [
        {
          tags: ['config', 'hooks'],
          entries: [
            { type: 'error_resolution', symptom: 'syntax error in config' },
            { type: 'correction', wrong_approach: 'used ESM instead of CJS' },
            { type: 'failure', approach: 'spawnSync for async ops' },
            { type: 'decision', summary: 'use CommonJS everywhere' },
          ],
        },
      ];
      const candidates = generateCandidates(clusters);
      assert.strictEqual(candidates.length, 1);
      assert.strictEqual(candidates[0].evidence.length, 4);
    });
  });

  describe('persist mode', () => {
    it('should have memory-store module with required functions', () => {
      assert.strictEqual(typeof memStore.appendEntry, 'function');
      assert.strictEqual(typeof memStore.readLastN, 'function');
    });

    it('should persist a skill entry via memory-store', () => {
      // Use a temp dir to avoid polluting project memory
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
      try {
        const entry = {
          type: 'skill',
          skill: 'test skill from unit test',
          evidence_count: 3,
          validated_by: ['codex-1', 'gemini-1'],
          tags: ['test'],
          confidence: 0.9,
        };
        const result = memStore.appendEntry(tmpDir, 'skills', entry);
        assert.ok(result.ts);
        assert.strictEqual(result.skill, 'test skill from unit test');

        const retrieved = memStore.readLastN(tmpDir, 'skills', 1);
        assert.strictEqual(retrieved.length, 1);
        assert.strictEqual(retrieved[0].skill, 'test skill from unit test');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
