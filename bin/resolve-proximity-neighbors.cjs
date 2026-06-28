#!/usr/bin/env node
'use strict';
// bin/resolve-proximity-neighbors.cjs
// Resolves 2-hop formal_module neighbors from proximity-index.json
//
// Usage:
//   node bin/resolve-proximity-neighbors.cjs --model=account-manager [--max-hops=2] [--max-neighbors=10]
//   node bin/resolve-proximity-neighbors.cjs --model=oscillation --format=json|csv|lines
//   node bin/resolve-proximity-neighbors.cjs --model=oscillation --project-root=/path/to/repo
//
// Output (JSON): { neighbors: [{ id, hop_distance, shared_concepts }], warnings: [] }

const fs   = require('fs');
const path = require('path');

const TAG = '[resolve-proximity-neighbors]';
const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_NEIGHBORS = 10;

/**
 * Load proximity-index.json from project root.
 * @param {string} root - project root directory
 * @returns {object|null} parsed index or null if not found
 */
function loadProximityIndex(root) {
  const indexPath = path.join(root, '.planning', 'formal', 'proximity-index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Build reverse edge index for bidirectional traversal.
 * For each edge A->B, creates a reverse entry B->A.
 * @param {object} nodes - proximity-index.json nodes object
 * @returns {object} reverse map: { nodeKey: [{ from, rel, source }] }
 */
function buildReverseEdges(nodes) {
  const reverse = Object.create(null);
  for (const [key, node] of Object.entries(nodes)) {
    if (!node || !Array.isArray(node.edges)) continue;
    for (const edge of node.edges) {
      if (!reverse[edge.to]) reverse[edge.to] = [];
      reverse[edge.to].push({ from: key, rel: edge.rel, source: edge.source });
    }
  }
  return reverse;
}

/**
 * Resolve 2-hop formal_module neighbors from proximity-index.json graph.
 * Uses bidirectional BFS (forward edges + reverse edges).
 *
 * @param {object|null} index - parsed proximity-index.json
 * @param {string} startModuleId - formal module name (e.g., "account-manager")
 * @param {object} [options] - { maxHops, maxNeighbors }
 * @returns {{ neighbors: Array<{id: string, hop_distance: number, shared_concepts: number}>, warnings: string[] }}
 */
function resolveNeighbors(index, startModuleId, options = {}) {
  const maxHops = options.maxHops || DEFAULT_MAX_HOPS;
  const maxNeighbors = options.maxNeighbors || DEFAULT_MAX_NEIGHBORS;
  const warnings = [];

  if (!index || !index.nodes) {
    warnings.push('proximity-index.json not found or invalid. Run /nf:proximity to generate.');
    return { neighbors: [], warnings };
  }

  const startKey = `formal_module::${startModuleId}`;
  if (!index.nodes[startKey]) {
    warnings.push(`Model "${startModuleId}" not found in proximity-index.json`);
    return { neighbors: [], warnings };
  }

  // Build reverse edge index for bidirectional traversal
  const reverseEdges = buildReverseEdges(index.nodes);

  const visited = new Set([startKey]);
  let frontier = [startKey];
  const neighborMap = new Map(); // id -> { hop_distance, shared_concepts }

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = [];

    for (const nodeKey of frontier) {
      // Forward edges
      const node = index.nodes[nodeKey];
      if (node && node.edges) {
        for (const edge of node.edges) {
          if (edge && typeof edge.to === 'string' && !visited.has(edge.to)) {
            visited.add(edge.to);
            nextFrontier.push(edge.to);
            if (edge.to.startsWith('formal_module::')) {
              const neighborId = edge.to.replace('formal_module::', '');
              if (!neighborMap.has(neighborId)) {
                neighborMap.set(neighborId, { hop_distance: hop + 1, shared_concepts: 0 });
              }
            }
          }
        }
      }

      // Reverse edges (bidirectional traversal)
      const revEdges = reverseEdges[nodeKey];
      if (revEdges) {
        for (const revEdge of revEdges) {
          if (!visited.has(revEdge.from)) {
            visited.add(revEdge.from);
            nextFrontier.push(revEdge.from);
            if (revEdge.from.startsWith('formal_module::')) {
              const neighborId = revEdge.from.replace('formal_module::', '');
              if (!neighborMap.has(neighborId)) {
                neighborMap.set(neighborId, { hop_distance: hop + 1, shared_concepts: 0 });
              }
            }
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  // Count shared concepts for each neighbor (for tiebreaking when capping)
  // Shared concepts = number of intermediate concept/code_file nodes that connect
  // the start module to this neighbor
  for (const [neighborId, data] of neighborMap) {
    const neighborKey = `formal_module::${neighborId}`;
    const startNode = index.nodes[startKey];
    const neighborNode = index.nodes[neighborKey];
    if (startNode && startNode.edges && neighborNode && neighborNode.edges) {
      const startTargets = new Set(startNode.edges.map(e => e.to));
      const neighborTargets = new Set(neighborNode.edges.map(e => e.to));
      // Also check reverse edges pointing to neighbor
      const neighborRevTargets = new Set(
        (reverseEdges[neighborKey] || []).map(e => e.from)
      );
      let shared = 0;
      for (const t of startTargets) {
        if (neighborTargets.has(t) || neighborRevTargets.has(t)) shared++;
      }
      data.shared_concepts = shared;
    }
  }

  // Sort: 1-hop before 2-hop, then by shared_concepts descending
  let neighbors = Array.from(neighborMap.entries())
    .map(([id, data]) => ({
      id,
      hop_distance: data.hop_distance,
      shared_concepts: data.shared_concepts,
    }))
    .sort((a, b) => {
      if (a.hop_distance !== b.hop_distance) return a.hop_distance - b.hop_distance;
      return b.shared_concepts - a.shared_concepts;
    });

  // Cap at maxNeighbors
  if (neighbors.length > maxNeighbors) {
    warnings.push(`Capped from ${neighbors.length} to ${maxNeighbors} neighbors (config limit)`);
    neighbors = neighbors.slice(0, maxNeighbors);
  }

  return { neighbors, warnings };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);

  const modelArg = argv.find(a => a.startsWith('--model='));
  const hopsArg = argv.find(a => a.startsWith('--max-hops='));
  const neighborsArg = argv.find(a => a.startsWith('--max-neighbors='));
  const formatArg = argv.find(a => a.startsWith('--format='));
  const rootArg = argv.find(a => a.startsWith('--project-root='));

  if (!modelArg) {
    process.stderr.write('Usage: node bin/resolve-proximity-neighbors.cjs --model=<name> [--max-hops=2] [--max-neighbors=10] [--format=json|csv|lines] [--project-root=<path>]\n');
    process.exit(1);
  }

  const modelId = modelArg.split('=')[1];
  const maxHops = hopsArg ? parseInt(hopsArg.split('=')[1], 10) : DEFAULT_MAX_HOPS;
  const format = formatArg ? formatArg.split('=')[1] : 'json';
  const root = rootArg ? path.resolve(rootArg.split('=')[1]) : process.cwd();

  // Config-backed max neighbors
  let maxNeighbors = neighborsArg ? parseInt(neighborsArg.split('=')[1], 10) : DEFAULT_MAX_NEIGHBORS;
  try {
    const configPath = path.join(root, '.planning', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.cross_model_max_neighbors && !neighborsArg) {
        maxNeighbors = config.cross_model_max_neighbors;
      }
    }
  } catch (_) { /* fail-open */ }

  const index = loadProximityIndex(root);
  const result = resolveNeighbors(index, modelId, { maxHops, maxNeighbors });

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      process.stderr.write(TAG + ' Warning: ' + w + '\n');
    }
  }

  switch (format) {
    case 'csv':
      process.stdout.write(result.neighbors.map(n => n.id).join(',') + '\n');
      break;
    case 'lines':
      for (const n of result.neighbors) {
        process.stdout.write(n.id + '\n');
      }
      break;
    case 'json':
    default:
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
  }
}

module.exports = { resolveNeighbors, loadProximityIndex, buildReverseEdges };
