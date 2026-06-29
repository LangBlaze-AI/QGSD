'use strict';

/**
 * solve-wave-dag.cjs — Dependency DAG and wave computation for remediation dispatch.
 *
 * Computes dependency-ordered wave groupings so independent layers within each
 * wave can run in parallel (up to 3 concurrent agents per RAM budget).
 * Sequential chains (single-layer waves in succession) are compacted into one
 * wave with a `sequential: true` flag to keep total wave count <= 6.
 *
 * @see PERF-01
 */

/**
 * Layer dependency adjacency list.
 * Each key maps to an array of layer keys it depends on.
 *
 * Note: Uses l1_to_l3 (not l1_to_l2/l2_to_l3) per STRUCT-01 collapse.
 */
const LAYER_DEPS = {
  r_to_f:          [],
  r_to_d:          [],
  t_to_c:          [],
  p_to_f:          [],
  f_to_t:          ['r_to_f'],
  c_to_f:          ['t_to_c'],
  f_to_c:          ['f_to_t', 'c_to_f'],
  d_to_c:          [],
  git_heatmap:     [],
  c_to_r:          ['r_to_f', 'r_to_d', 'f_to_t', 't_to_c', 'c_to_f', 'f_to_c', 'd_to_c', 'git_heatmap', 'p_to_f'],
  t_to_r:          ['r_to_f', 'r_to_d', 'f_to_t', 't_to_c', 'c_to_f', 'f_to_c', 'd_to_c', 'git_heatmap', 'p_to_f'],
  d_to_r:          ['r_to_f', 'r_to_d', 'f_to_t', 't_to_c', 'c_to_f', 'f_to_c', 'd_to_c', 'git_heatmap', 'p_to_f'],
  hazard_model:    ['c_to_r', 't_to_r', 'd_to_r'],
  l1_to_l3:        ['hazard_model'],
  l3_to_tc:        ['l1_to_l3'],
  per_model_gates: ['l1_to_l3', 'l3_to_tc'],
  h_to_m: [],  // No dependencies — hypothesis measurement is independent
  b_to_f: ['t_to_c'],  // Depends on test-to-code traceability for requirement lineage
};

const MAX_PER_WAVE = 3;

/**
 * Return the dependency list for a single layer key.
 * @param {string} layerKey
 * @returns {string[]}
 */
function getLayerDeps(layerKey) {
  return Object.prototype.hasOwnProperty.call(LAYER_DEPS, layerKey)
    ? LAYER_DEPS[layerKey]
    : [];
}

/**
 * Compute wave groupings from a residual vector.
 *
 * Algorithm:
 * 1. Filter to layers with residual > 0
 * 2. Topological sort (longest-path assignment for correct wave ordering)
 * 3. Group by wave number
 * 4. Split large waves into sub-waves of MAX_PER_WAVE
 * 5. Compact trailing sequential chains (consecutive single-layer waves) into
 *    one wave with sequential:true to keep total wave count bounded
 *
 * @param {Object} residualVector — keys are layer names, values are objects
 *   with at least a `residual` property. Layers with residual <= 0 are skipped.
 * @param {Object} [priorityWeights={}] — optional { [layerKey]: number } for
 *   hypothesis-driven intra-wave ordering. Layers with higher weight appear first
 *   within their wave. Does NOT change wave assignment (topology preserved).
 * @returns {Array<{wave: number, layers: string[], sequential?: boolean}>}
 */
function computeWaves(residualVector, priorityWeights = {}) {
  if (!residualVector || typeof residualVector !== 'object') return [];
  // Filter to active layers (residual > 0)
  const active = new Set();
  for (const [key, val] of Object.entries(residualVector)) {
    if (val && typeof val === 'object' && val.residual > 0 && LAYER_DEPS.hasOwnProperty(key)) {
      active.add(key);
    }
  }

  if (active.size === 0) return [];

  // Compute longest-path wave assignment (ensures correct ordering)
  const waveAssignment = new Map();

  function getWave(layer) {
    if (waveAssignment.has(layer)) return waveAssignment.get(layer);
    const deps = (LAYER_DEPS[layer] || []).filter(d => active.has(d));
    if (deps.length === 0) {
      waveAssignment.set(layer, 0);
      return 0;
    }
    const maxDepWave = Math.max(...deps.map(d => getWave(d)));
    const w = maxDepWave + 1;
    waveAssignment.set(layer, w);
    return w;
  }

  for (const layer of active) {
    getWave(layer);
  }

  // Group by wave number
  const waveGroups = new Map();
  for (const [layer, waveNum] of waveAssignment.entries()) {
    if (!waveGroups.has(waveNum)) waveGroups.set(waveNum, []);
    waveGroups.get(waveNum).push(layer);
  }

  // Build raw waves with MAX_PER_WAVE splits
  const sortedWaveNums = [...waveGroups.keys()].sort((a, b) => a - b);
  const rawWaves = [];

  for (const waveNum of sortedWaveNums) {
    const layers = waveGroups.get(waveNum).sort((a, b) =>
      (priorityWeights[b] || 0) - (priorityWeights[a] || 0) || a.localeCompare(b)
    ); // priority weight descending, then alphabetical tiebreaker
    for (let i = 0; i < layers.length; i += MAX_PER_WAVE) {
      const chunk = layers.slice(i, i + MAX_PER_WAVE);
      rawWaves.push({ layers: chunk });
    }
  }

  // Compact: merge consecutive single-layer waves at the tail into one
  // sequential wave. This collapses chains like hazard -> l1_to_l3 -> l3_to_tc -> per_model_gates.
  const result = [];
  let i = 0;
  while (i < rawWaves.length) {
    // Look ahead for a run of consecutive single-layer waves (2+ in a row)
    if (rawWaves[i].layers.length === 1) {
      let runEnd = i;
      while (runEnd + 1 < rawWaves.length && rawWaves[runEnd + 1].layers.length === 1) {
        runEnd++;
      }
      if (runEnd > i) {
        // Merge the run into one sequential wave
        const merged = [];
        for (let j = i; j <= runEnd; j++) {
          merged.push(...rawWaves[j].layers);
        }
        result.push({ wave: result.length + 1, layers: merged, sequential: true });
        i = runEnd + 1;
        continue;
      }
    }
    result.push({ wave: result.length + 1, layers: rawWaves[i].layers });
    i++;
  }

  return result;
}

/**
 * Compute wave groupings from an arbitrary dependency graph.
 *
 * Algorithm:
 * 1. Build adjacency list from edges (forward deps: node -> [nodes it depends on])
 * 2. SCC detection via Tarjan's algorithm — collapse strongly connected components into single composite nodes
 * 3. Build condensation DAG — edges between SCCs (no self-loops)
 * 4. Topological sort of condensation DAG using longest-path wave assignment
 * 5. Group by wave number, sort within wave by priority weight descending then alphabetical
 * 6. Split by MAX_PER_WAVE
 * 7. Sequential chain compaction (merge consecutive single-node waves)
 * 8. Return Array<{wave: number, layers: string[], sequential?: boolean}>
 *
 * @param {Object} graph — { nodes: string[], edges: Array<{from: string, to: string}> }
 * @param {Object} [priorityWeights={}] — { [node]: number } for intra-wave ordering
 * @returns {Array<{wave: number, layers: string[], sequential?: boolean}>}
 */
function computeWavesFromGraph(graph, priorityWeights = {}) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return [];
  }

  const nodes = new Set(graph.nodes);
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(
    (e) => e && typeof e === 'object'
  );

  // Build adjacency list: node -> [nodes it depends on]
  const adjList = new Map();
  for (const node of nodes) {
    adjList.set(node, []);
  }
  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      if (!adjList.has(edge.from)) adjList.set(edge.from, []);
      adjList.get(edge.from).push(edge.to);
    }
  }

  // Tarjan's SCC algorithm
  const sccs = tarjanSCC(adjList, nodes);

  // Map nodes to their SCC ID
  const nodeToScc = new Map();
  for (let i = 0; i < sccs.length; i++) {
    for (const node of sccs[i]) {
      nodeToScc.set(node, i);
    }
  }

  // Build condensation DAG
  const sccAdj = new Map();
  for (let i = 0; i < sccs.length; i++) {
    sccAdj.set(i, new Set());
  }
  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      const fromScc = nodeToScc.get(edge.from);
      const toScc = nodeToScc.get(edge.to);
      if (fromScc !== toScc) {
        sccAdj.get(fromScc).add(toScc);
      }
    }
  }

  // Topological sort using longest-path wave assignment
  const waveAssignment = new Map();

  function getWave(sccId) {
    if (waveAssignment.has(sccId)) return waveAssignment.get(sccId);
    const deps = Array.from(sccAdj.get(sccId) || []);
    if (deps.length === 0) {
      waveAssignment.set(sccId, 0);
      return 0;
    }
    const maxDepWave = Math.max(...deps.map(d => getWave(d)));
    const w = maxDepWave + 1;
    waveAssignment.set(sccId, w);
    return w;
  }

  for (let i = 0; i < sccs.length; i++) {
    getWave(i);
  }

  // Group SCCs by wave
  const waveGroups = new Map();
  for (let i = 0; i < sccs.length; i++) {
    const w = waveAssignment.get(i);
    if (!waveGroups.has(w)) waveGroups.set(w, []);
    waveGroups.get(w).push(i);
  }

  // Build raw waves with SCC composite names
  const sortedWaveNums = [...waveGroups.keys()].sort((a, b) => a - b);
  const rawWaves = [];

  for (const waveNum of sortedWaveNums) {
    const sccIds = waveGroups.get(waveNum);
    const sccLayers = sccIds.map(id => {
      const members = sccs[id].sort();
      return members.join('+');
    });

    // Sort within wave by priority (use max priority of members in composite)
    const sccLayersWithPriority = sccLayers.map(layer => {
      const members = layer.split('+');
      const maxPriority = Math.max(...members.map(m => priorityWeights[m] || 0), 0);
      return { layer, priority: maxPriority };
    });

    sccLayersWithPriority.sort((a, b) => {
      return b.priority - a.priority || a.layer.localeCompare(b.layer);
    });

    const sorted = sccLayersWithPriority.map(x => x.layer);

    for (let i = 0; i < sorted.length; i += MAX_PER_WAVE) {
      const chunk = sorted.slice(i, i + MAX_PER_WAVE);
      rawWaves.push({ layers: chunk });
    }
  }

  // Compact sequential waves
  const result = [];
  let i = 0;
  while (i < rawWaves.length) {
    if (rawWaves[i].layers.length === 1) {
      let runEnd = i;
      while (runEnd + 1 < rawWaves.length && rawWaves[runEnd + 1].layers.length === 1) {
        runEnd++;
      }
      if (runEnd > i) {
        const merged = [];
        for (let j = i; j <= runEnd; j++) {
          merged.push(...rawWaves[j].layers);
        }
        result.push({ wave: result.length + 1, layers: merged, sequential: true });
        i = runEnd + 1;
        continue;
      }
    }
    result.push({ wave: result.length + 1, layers: rawWaves[i].layers });
    i++;
  }

  return result;
}

/**
 * Tarjan's strongly connected components algorithm.
 * @param {Map} adjList — adjacency list (node -> [dependent nodes])
 * @param {Set} nodes — all nodes in graph
 * @returns {Array<Array<string>>} — array of SCCs, each SCC is an array of node names
 */
function tarjanSCC(adjList, nodes) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  let nextIndex = 0;
  const sccs = [];

  function strongconnect(v) {
    index.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of (adjList.get(v) || [])) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      sccs.push(scc);
    }
  }

  for (const v of nodes) {
    if (!index.has(v)) {
      strongconnect(v);
    }
  }

  return sccs;
}

// CLI mode
if (require.main === module) {
  console.log('=== Layer Dependency DAG ===\n');
  for (const [key, deps] of Object.entries(LAYER_DEPS)) {
    console.log(`  ${key}: ${deps.length === 0 ? '(root)' : deps.join(', ')}`);
  }

  // Sample wave grouping with all layers active
  const allActive = {};
  for (const key of Object.keys(LAYER_DEPS)) {
    allActive[key] = { residual: 1 };
  }
  const waves = computeWaves(allActive);

  console.log('\n=== Wave Grouping (all layers active) ===\n');
  for (const w of waves) {
    const seq = w.sequential ? ' [sequential]' : '';
    console.log(`  Wave ${w.wave}: ${w.layers.join(', ')}${seq}`);
  }
  console.log(`\n  Total: ${waves.length} waves`);
}

module.exports = { computeWaves, computeWavesFromGraph, getLayerDeps, LAYER_DEPS, MAX_PER_WAVE };

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark