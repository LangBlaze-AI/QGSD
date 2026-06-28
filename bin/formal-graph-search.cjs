#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * BFS reach from a node, up to maxDepth hops, filtered by type.
 * @param {object} index - Proximity index object with nodes property
 * @param {string} startKey - Node key to start BFS from
 * @param {number} maxDepth - Maximum depth in hops
 * @param {Array<string>} typeFilter - Types to include in results
 * @returns {Array} Array of reachable nodes matching the type filter
 */
function reachFiltered(index, startKey, maxDepth, typeFilter) {
  const results = [];
  const visited = new Set([startKey]);
  let frontier = [{ key: startKey, depth: 0 }];

  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const { key, depth } of frontier) {
      if (depth >= maxDepth) continue;
      const node = index.nodes[key];
      if (!node) continue;
      const edges = Array.isArray(node.edges) ? node.edges : [];
      for (const edge of edges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        const target = index.nodes[edge.to];
        if (!target) continue;
        const d = depth + 1;
        if (typeFilter.includes(target.type)) {
          results.push({ key: edge.to, type: target.type, rel: edge.rel, depth: d });
        }
        nextFrontier.push({ key: edge.to, depth: d });
      }
    }
    frontier = nextFrontier;
  }

  return results;
}

/**
 * Compute proximity score between two nodes using edge weights and decay.
 * Uses BFS with weighted propagation — first path found (shortest) wins.
 * @param {object} index - Proximity index object with nodes property
 * @param {string} fromKey - Starting node key
 * @param {string} toKey - Target node key
 * @returns {number} Proximity score (0-1)
 */
function proximityScore(index, fromKey, toKey) {
  const EDGE_WEIGHTS = {
    owns: 1.0, owned_by: 1.0,
    contains: 1.0, in_file: 1.0,
    emits: 0.9, emitted_by: 0.9,
    maps_to: 0.9, mapped_from: 0.9,
    declared_in: 0.9,
    modeled_by: 0.8, models: 0.8,
    declares: 0.8, declared_by: 0.8,
    verified_by: 0.8, verifies: 0.8,
    tested_by: 0.7, tests: 0.7,
    triggers: 0.7, triggered_by: 0.7,
    transitions: 0.6,
    describes: 0.5, described_by: 0.5,
    constrains: 0.5, constrained_by: 0.5,
    scores: 0.4, scored_by: 0.4,
    affects: 0.4, affected_by: 0.4
  };
  const DECAY = 0.7;

  if (fromKey === toKey) return 1.0;
  const visited = new Set([fromKey]);
  const queue = [{ key: fromKey, score: 1.0 }];

  while (queue.length > 0) {
    const { key, score } = queue.shift();
    const node = index.nodes[key];
    if (!node) continue;

    const edges = Array.isArray(node.edges) ? node.edges : [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      const edgeWeight = EDGE_WEIGHTS[edge.rel] || 0.3;
      const nextScore = score * edgeWeight * DECAY;
      if (edge.to === toKey) return nextScore;
      if (nextScore > 0.01) {
        queue.push({ key: edge.to, score: nextScore });
      }
    }
  }

  return 0;
}

/**
 * Keyword pre-screen: extract key terms from model file and requirement text,
 * compute overlap. Zero overlap = auto-reject.
 * @param {string} modelPath - Path to formal model file
 * @param {string} reqText - Requirement text
 * @returns {boolean} true if there is meaningful keyword overlap
 */
function keywordOverlap(modelPath, reqText) {
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her',
    'was', 'one', 'our', 'out', 'with', 'that', 'this', 'from', 'they', 'been',
    'have', 'its', 'will', 'would', 'could', 'should', 'each', 'which', 'their',
    'there', 'when', 'must', 'shall'
  ]);

  const extractTerms = (text) => {
    if (!text) return new Set();
    return new Set(
      text.toLowerCase()
        .replace(/[^a-z0-9\s-_]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    );
  };

  const reqTerms = extractTerms(reqText);
  if (reqTerms.size === 0) return true; // Can't filter if no terms

  // Read model file content
  let modelContent = '';
  try {
    const fullPath = path.join(process.cwd(), modelPath);
    modelContent = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return true; // Can't read file = don't filter
  }

  const modelTerms = extractTerms(modelContent);
  if (modelTerms.size === 0) return true;

  // Count overlapping terms
  let overlap = 0;
  for (const term of reqTerms) {
    if (modelTerms.has(term)) overlap++;
  }

  // Zero overlap = reject
  return overlap > 0;
}

/**
 * Graph-first discovery: walk from description-derived concept nodes to formal_module nodes.
 * Algorithm:
 *   - For each token in tokens, check if concept::{token} exists in index
 *   - Also check partial matches (e.g., token "breaker" matches concept "circuit-breaker")
 *   - BFS from matched concepts (maxDepth=2) to find related formal_module nodes
 *   - Collect discovered modules with their discovery path
 *   - Deduplicate by module name, keeping shortest path
 *   - Return deterministically sorted by depth (ascending), then module name (alphabetically)
 * @param {object} index - Proximity index object with nodes property
 * @param {Array<string>} tokens - Description tokens
 * @param {string} description - Full description (unused in current version, kept for future)
 * @returns {Array<{module: string, discoveredVia: string, depth: number}>} Discovered modules
 */
function graphDiscoverModules(index, tokens, description) {
  if (!index || !index.nodes || tokens.length === 0) {
    return [];
  }

  const discovered = new Map(); // module -> { discoveredVia, depth }

  for (const token of tokens) {
    if (typeof token !== 'string') continue;
    const tokenLower = token.toLowerCase();

    // Exact match: concept::{token}
    const exactKey = 'concept::' + tokenLower;
    if (index.nodes[exactKey]) {
      const reachable = reachFiltered(index, exactKey, 2, ['formal_module']);
      for (const r of reachable) {
        const modName = r.key.replace('formal_module::', '');
        // Keep shortest depth
        if (!discovered.has(modName) || discovered.get(modName).depth > r.depth) {
          discovered.set(modName, { discoveredVia: exactKey, depth: r.depth });
        }
      }
    }

    // Partial match: look for concept nodes that include the token
    for (const [nodeKey, node] of Object.entries(index.nodes)) {
      if (!nodeKey.startsWith('concept::')) continue;
      const conceptName = nodeKey.replace('concept::', '').toLowerCase();
      // Match if token is in concept name or concept contains token
      if (conceptName.includes(tokenLower) || tokenLower.includes(conceptName)) {
        const reachable = reachFiltered(index, nodeKey, 2, ['formal_module']);
        for (const r of reachable) {
          const modName = r.key.replace('formal_module::', '');
          // Keep shortest depth
          if (!discovered.has(modName) || discovered.get(modName).depth > r.depth) {
            discovered.set(modName, { discoveredVia: nodeKey, depth: r.depth });
          }
        }
      }
    }
  }

  // Convert to array and sort: by depth ascending, then by module name alphabetically
  const result = Array.from(discovered.entries()).map(([module, info]) => ({
    module,
    discoveredVia: info.discoveredVia,
    depth: info.depth
  }));

  result.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.module < b.module ? -1 : a.module > b.module ? 1 : 0;
  });

  return result;
}

module.exports = {
  reachFiltered,
  proximityScore,
  keywordOverlap,
  graphDiscoverModules
};
