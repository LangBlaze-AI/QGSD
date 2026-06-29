#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Locate memory-store.cjs — try installed global path first, then local dev path.
 */
function findMemoryStore() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'nf-bin', 'memory-store.cjs'),
    path.join(__dirname, 'memory-store.cjs'),
  ];
  for (const p of candidates) {
    try { return require(p); } catch (_) {}
  }
  return null;
}

/**
 * Clusters entries by shared tags. Returns clusters where entries share 2+ tags.
 * @param {Array<{tags: string[]}>} entries
 * @returns {Array<{tags: string[], entries: Array}>}
 */
function clusterByTags(entries) {
  if (!entries || entries.length === 0) return [];

  // Build tag -> entry index map
  const tagMap = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tags = (entry && Array.isArray(entry.tags)) ? entry.tags : [];
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(i);
    }
  }

  // Find pairs of tags that co-occur in 2+ entries
  const tagPairs = new Map();
  const tagList = Array.from(tagMap.keys());

  for (let a = 0; a < tagList.length; a++) {
    for (let b = a + 1; b < tagList.length; b++) {
      const tagA = tagList[a];
      const tagB = tagList[b];
      const indicesA = new Set(tagMap.get(tagA));
      const shared = tagMap.get(tagB).filter(idx => indicesA.has(idx));
      if (shared.length >= 2) {
        const key = [tagA, tagB].sort().join('|');
        if (!tagPairs.has(key)) {
          tagPairs.set(key, { tags: [tagA, tagB].sort(), indices: new Set(shared) });
        } else {
          for (const idx of shared) tagPairs.get(key).indices.add(idx);
        }
      }
    }
  }

  // Convert to clusters with actual entries
  const clusters = [];
  for (const [, cluster] of tagPairs) {
    clusters.push({
      tags: cluster.tags,
      entries: Array.from(cluster.indices).map(idx => entries[idx]),
    });
  }

  // Sort by cluster size descending
  clusters.sort((a, b) => b.entries.length - a.entries.length);
  return clusters;
}

/**
 * Generates candidate skills from tag clusters.
 * Only clusters with 3+ entries produce candidates.
 * Capped at maxCandidates.
 *
 * @param {Array<{tags: string[], entries: Array}>} clusters
 * @param {number} maxCandidates
 * @returns {Array<{skill: string, evidence: string[], tags: string[], evidence_count: number}>}
 */
function generateCandidates(clusters, maxCandidates = 5) {
  const candidates = [];

  for (const cluster of clusters) {
    if (candidates.length >= maxCandidates) break;
    if (cluster.entries.length < 3) continue;

    // Build a description from the cluster
    const summaries = cluster.entries.map(e => {
      if (e.type === 'error_resolution') return (e.symptom || '').slice(0, 80);
      if (e.type === 'correction') return (e.wrong_approach || '').slice(0, 80);
      if (e.type === 'failure') return (e.approach || '').slice(0, 80);
      if (e.type === 'decision') return (e.summary || '').slice(0, 80);
      return '';
    }).filter(Boolean);

    const skill = 'Pattern in [' + cluster.tags.join(', ') + ']: ' +
      cluster.entries.length + ' occurrences across ' +
      cluster.tags.length + ' shared tags';

    candidates.push({
      skill,
      evidence: summaries.slice(0, 5),
      tags: cluster.tags,
      evidence_count: cluster.entries.length,
    });
  }

  return candidates;
}

/**
 * Reads recent entries from all learning categories (last 30 days).
 * @param {object} memStore - memory-store module
 * @param {string} cwd - project directory
 * @returns {Array} Combined entries
 */
function readRecentEntries(memStore, cwd) {
  const categories = ['errors', 'corrections', 'failures', 'decisions'];
  const entries = [];
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const cat of categories) {
    try {
      const items = memStore.readLastN(cwd, cat, 50);
      for (const item of items) {
        if (item.ts && new Date(item.ts).getTime() >= cutoff) {
          entries.push(item);
        }
      }
    } catch (_) {}
  }

  return entries;
}

// ─── CLI interface ──────────────────────────────────────────────────────────

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const cwd = process.cwd();

    function getArg(name) {
      const idx = args.indexOf('--' + name);
      if (idx === -1 || idx + 1 >= args.length) return null;
      return args[idx + 1];
    }

    const hasFlag = (name) => args.includes('--' + name);

    const memStore = findMemoryStore();
    if (!memStore) {
      process.stderr.write('[skill-extractor] Could not find memory-store.cjs\n');
      process.exit(0);
    }

    if (hasFlag('persist')) {
      // --persist mode: directly append a validated skill
      const skill = getArg('skill');
      const validatedBy = getArg('validated-by');
      const confidence = parseFloat(getArg('confidence') || '0.7');

      if (!skill) {
        process.stderr.write('Usage: skill-extractor.cjs --persist --skill "..." --validated-by "codex-1,gemini-1" --confidence 0.9\n');
        process.exit(0);
      }

      const entry = {
        type: 'skill',
        skill,
        evidence_count: parseInt(getArg('evidence-count') || '0', 10),
        validated_by: (validatedBy || '').split(',').filter(Boolean),
        tags: (getArg('tags') || '').split(',').filter(Boolean),
        confidence,
      };
      const result = memStore.appendEntry(cwd, 'skills', entry);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    // Read recent entries and cluster
    const entries = readRecentEntries(memStore, cwd);

    if (entries.length === 0) {
      process.stdout.write(JSON.stringify({ candidates: [], message: 'No recent entries found (last 30 days)' }) + '\n');
      process.exit(0);
    }

    const clusters = clusterByTags(entries);
    const candidates = generateCandidates(clusters);

    if (candidates.length === 0) {
      process.stdout.write(JSON.stringify({ candidates: [], message: 'No candidate skills found (need 3+ entries with 2+ shared tags)' }) + '\n');
      process.exit(0);
    }

    if (hasFlag('validate')) {
      // --validate mode: output candidates with quorum instructions
      process.stdout.write(JSON.stringify({ candidates, count: candidates.length }) + '\n');
      process.stderr.write('\nTo validate each candidate via quorum, run:\n');
      for (let i = 0; i < candidates.length; i++) {
        process.stderr.write('  /nf:quick validate skill: ' + candidates[i].skill + '\n');
      }
      process.stderr.write('\nAfter quorum validation, persist with:\n');
      process.stderr.write('  node bin/skill-extractor.cjs --persist --skill "..." --validated-by "codex-1,gemini-1" --confidence 0.9\n');
    } else {
      // Dry run: list candidates
      process.stdout.write(JSON.stringify({
        candidates,
        count: candidates.length,
        total_entries: entries.length,
        clusters: clusters.length,
      }) + '\n');
    }
  } catch (e) {
    process.stderr.write('[skill-extractor] Error: ' + e.message + '\n');
    process.exit(0); // Fail open
  }
}

module.exports = { clusterByTags, generateCandidates, readRecentEntries, findMemoryStore };
