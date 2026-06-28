#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(process.cwd(), '.planning', 'formal', 'proximity-index.json');

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) {
    process.stderr.write('Error: proximity-index.json not found.\n');
    process.stderr.write('Run `node bin/formal-proximity.cjs` first to build the index.\n');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

function parseArgs(argv) {
  const args = { command: null, positional: [], depth: 3, filter: null, json: false, format: 'table', help: false };
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--depth' && argv[i + 1]) {
      args.depth = parseInt(argv[++i], 10);
    } else if (arg === '--filter' && argv[i + 1]) {
      args.filter = argv[++i].split(',').map(s => s.trim());
    } else if (arg === '--format' && argv[i + 1]) {
      args.format = argv[++i];
    } else if (!args.command) {
      args.command = arg;
    } else {
      args.positional.push(arg);
    }
    i++;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/formal-query.cjs <command> [args] [options]

Commands:
  reach <node-key> [--depth N] [--filter type1,type2]
      BFS from node up to N hops, optionally filtered by type

  path <from-key> <to-key>
      Shortest path between two nodes

  neighbors <node-key>
      Direct edges only (depth=1)

  impact <code-file-path>
      Formal elements affected by a code change (reach depth=3, filter=invariant,requirement,formal_model,test_file)

  coverage <requirement-id>
      Full verification chain for a requirement (reach depth=4)

  proximity <node-key-A> <node-key-B>
      Compute proximity score and tier

  stats
      Summary statistics of the index

Options:
  --depth N          Max traversal depth (default: 3)
  --filter t1,t2     Only include nodes of these types
  --json             JSON output
  --format lines     One result per line
  --help             Show this help

Examples:
  node bin/formal-query.cjs stats
  node bin/formal-query.cjs neighbors "code_file::hooks/nf-circuit-breaker.js"
  node bin/formal-query.cjs impact hooks/nf-circuit-breaker.js
  node bin/formal-query.cjs reach "constant::Depth" --depth 2
  node bin/formal-query.cjs coverage SAFE-01
  node bin/formal-query.cjs proximity "code_file::hooks/nf-circuit-breaker.js" "requirement::SAFE-01"
`);
}

function suggestSimilarKeys(index, key) {
  const idPart = key.includes('::') ? key.split('::').slice(1).join('::') : key;
  const suggestions = [];
  for (const k of Object.keys(index.nodes)) {
    if (k.toLowerCase().includes(idPart.toLowerCase())) {
      suggestions.push(k);
      if (suggestions.length >= 5) break;
    }
  }
  return suggestions;
}

function resolveNodeKey(index, key) {
  if (Object.prototype.hasOwnProperty.call(index.nodes, key)) return key;
  // Try common prefixes
  const prefixes = ['code_file::', 'requirement::', 'constant::', 'formal_module::', 'invariant::', 'formal_model::'];
  for (const prefix of prefixes) {
    if (Object.prototype.hasOwnProperty.call(index.nodes, prefix + key)) return prefix + key;
  }
  return null;
}

/**
 * BFS reach from startNode up to maxDepth hops.
 * Returns: { [depth]: [{ key, type, rel }] }
 */
function reach(index, startNode, maxDepth, filter) {
  const result = {};
  const visited = new Set([startNode]);
  let frontier = [{ key: startNode, depth: 0 }];

  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const { key, depth } of frontier) {
      if (depth >= maxDepth) continue;
      const node = index.nodes[key];
      if (!node || !Array.isArray(node.edges)) continue;
      for (const edge of node.edges) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        const targetNode = index.nodes[edge.to];
        if (!targetNode) continue;
        const d = depth + 1;
        if (!filter || filter.includes(targetNode.type)) {
          if (!result[d]) result[d] = [];
          result[d].push({ key: edge.to, type: targetNode.type, rel: edge.rel });
        }
        // Always expand even if filtered out
        nextFrontier.push({ key: edge.to, depth: d });
      }
    }
    frontier = nextFrontier;
  }

  return result;
}

/**
 * BFS shortest path from -> to.
 * Returns array of { key, rel } or null if no path.
 */
function findPath(index, from, to) {
  if (from === to) return [{ key: from, rel: null }];
  const visited = new Set([from]);
  const queue = [{ key: from, path: [{ key: from, rel: null }] }];

  while (queue.length > 0) {
    const { key, path: currentPath } = queue.shift();
    const node = index.nodes[key];
    if (!node || !Array.isArray(node.edges)) continue;

    for (const edge of node.edges) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      const newPath = [...currentPath, { key: edge.to, rel: edge.rel }];
      if (edge.to === to) return newPath;
      queue.push({ key: edge.to, path: newPath });
    }
  }

  return null;
}

function cmdReach(index, args) {
  const nodeKey = resolveNodeKey(index, args.positional[0] || '');
  if (!nodeKey) {
    const suggestions = suggestSimilarKeys(index, args.positional[0] || '');
    process.stderr.write(`Node not found: ${args.positional[0] || '(empty)'}\n`);
    if (suggestions.length > 0) {
      process.stderr.write('Did you mean:\n');
      for (const s of suggestions) process.stderr.write(`  ${s}\n`);
    }
    process.exit(1);
  }

  const result = reach(index, nodeKey, args.depth, args.filter);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.format === 'lines') {
    for (const [d, nodes] of Object.entries(result)) {
      for (const n of nodes) {
        console.log(`${d}\t${n.rel}\t${n.key}`);
      }
    }
  } else {
    console.log(`Reachable from ${nodeKey} (max depth=${args.depth}):`);
    for (const [d, nodes] of Object.entries(result)) {
      console.log(`  Depth ${d}:`);
      for (const n of nodes) {
        console.log(`    ${n.rel} -> ${n.key}`);
      }
    }
    const total = Object.values(result).reduce((s, arr) => s + arr.length, 0);
    console.log(`\nTotal: ${total} nodes`);
  }
}

function cmdPath(index, args) {
  const fromKey = resolveNodeKey(index, args.positional[0] || '');
  const toKey = resolveNodeKey(index, args.positional[1] || '');

  if (!fromKey) {
    process.stderr.write(`From node not found: ${args.positional[0] || '(empty)'}\n`);
    const suggestions = suggestSimilarKeys(index, args.positional[0] || '');
    if (suggestions.length > 0) {
      process.stderr.write('Did you mean:\n');
      for (const s of suggestions) process.stderr.write(`  ${s}\n`);
    }
    process.exit(1);
  }
  if (!toKey) {
    process.stderr.write(`To node not found: ${args.positional[1] || '(empty)'}\n`);
    const suggestions = suggestSimilarKeys(index, args.positional[1] || '');
    if (suggestions.length > 0) {
      process.stderr.write('Did you mean:\n');
      for (const s of suggestions) process.stderr.write(`  ${s}\n`);
    }
    process.exit(1);
  }

  const p = findPath(index, fromKey, toKey);
  if (!p) {
    if (args.json) {
      console.log(JSON.stringify({ path: null, message: 'No path found' }));
    } else {
      console.log('No path found');
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ path: p, length: p.length - 1 }));
  } else {
    const parts = p.map((step, i) => {
      if (i === 0) return step.key;
      return `--${step.rel}--> ${step.key}`;
    });
    console.log(parts.join(' '));
    console.log(`\nPath length: ${p.length - 1} hops`);
  }
}

function cmdNeighbors(index, args) {
  const nodeKey = resolveNodeKey(index, args.positional[0] || '');
  if (!nodeKey) {
    process.stderr.write(`Node not found: ${args.positional[0] || '(empty)'}\n`);
    const suggestions = suggestSimilarKeys(index, args.positional[0] || '');
    if (suggestions.length > 0) {
      process.stderr.write('Did you mean:\n');
      for (const s of suggestions) process.stderr.write(`  ${s}\n`);
    }
    process.exit(1);
  }

  const node = index.nodes[nodeKey];
  if (args.json) {
    console.log(JSON.stringify(node.edges, null, 2));
  } else if (args.format === 'lines') {
    for (const e of node.edges) {
      console.log(`${e.rel}\t${e.to}\t${e.source}`);
    }
  } else {
    console.log(`Neighbors of ${nodeKey}:`);
    for (const e of node.edges) {
      console.log(`  --${e.rel}--> ${e.to}  (source: ${e.source})`);
    }
    console.log(`\nTotal: ${node.edges.length} edges`);
  }
}

function cmdImpact(index, args) {
  const filePath = args.positional[0] || '';
  const nodeKey = `code_file::${filePath}`;
  if (!index.nodes[nodeKey]) {
    process.stderr.write(`Code file not found in index: ${filePath}\n`);
    const suggestions = suggestSimilarKeys(index, filePath);
    if (suggestions.length > 0) {
      process.stderr.write('Did you mean:\n');
      for (const s of suggestions) process.stderr.write(`  ${s}\n`);
    }
    process.exit(1);
  }

  const filter = ['invariant', 'requirement', 'formal_model', 'test_file'];
  const result = reach(index, nodeKey, 3, filter);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Impact analysis for ${filePath}:`);
    for (const [d, nodes] of Object.entries(result)) {
      console.log(`  Depth ${d}:`);
      for (const n of nodes) {
        console.log(`    [${n.type}] ${n.key.split('::')[1]} (via ${n.rel})`);
      }
    }
    const total = Object.values(result).reduce((s, arr) => s + arr.length, 0);
    console.log(`\nTotal formal elements impacted: ${total}`);
  }
}

function cmdCoverage(index, args) {
  const reqId = args.positional[0] || '';
  const nodeKey = resolveNodeKey(index, `requirement::${reqId}`) || resolveNodeKey(index, reqId);
  if (!nodeKey) {
    process.stderr.write(`Requirement not found: ${reqId}\n`);
    const suggestions = suggestSimilarKeys(index, reqId);
    if (suggestions.length > 0) {
      process.stderr.write('Did you mean:\n');
      for (const s of suggestions) process.stderr.write(`  ${s}\n`);
    }
    process.exit(1);
  }

  const filter = ['formal_model', 'invariant', 'test_file', 'code_file', 'code_line'];
  const result = reach(index, nodeKey, 4, filter);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Coverage chain for ${nodeKey}:`);
    for (const [d, nodes] of Object.entries(result)) {
      console.log(`  Depth ${d}:`);
      for (const n of nodes) {
        console.log(`    [${n.type}] ${n.key.split('::')[1]} (via ${n.rel})`);
      }
    }
    const total = Object.values(result).reduce((s, arr) => s + arr.length, 0);
    console.log(`\nTotal coverage elements: ${total}`);
  }
}

function cmdProximity(index, args) {
  const { proximity: proximityFn } = require('./formal-proximity.cjs');

  const keyA = resolveNodeKey(index, args.positional[0] || '');
  const keyB = resolveNodeKey(index, args.positional[1] || '');

  if (!keyA) {
    process.stderr.write(`Node A not found: ${args.positional[0] || '(empty)'}\n`);
    process.exit(1);
  }
  if (!keyB) {
    process.stderr.write(`Node B not found: ${args.positional[1] || '(empty)'}\n`);
    process.exit(1);
  }

  const score = proximityFn(index, keyA, keyB);
  let tier;
  if (score >= 0.8) tier = 'Definitive';
  else if (score >= 0.4) tier = 'Structural';
  else if (score >= 0.1) tier = 'Semantic';
  else tier = 'Unrelated';

  if (args.json) {
    console.log(JSON.stringify({ nodeA: keyA, nodeB: keyB, score: Math.round(score * 1000) / 1000, tier }));
  } else {
    console.log(`Proximity: ${keyA}`);
    console.log(`       to: ${keyB}`);
    console.log(`    Score: ${Math.round(score * 1000) / 1000}`);
    console.log(`     Tier: ${tier}`);
  }
}

function cmdStats(index) {
  const typeCounts = {};
  const relCounts = {};
  let orphanCount = 0;
  let totalEdges = 0;

  for (const node of Object.values(index.nodes)) {
    typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
    if (node.edges.length === 0) orphanCount++;
    totalEdges += node.edges.length;
    for (const edge of node.edges) {
      relCounts[edge.rel] = (relCounts[edge.rel] || 0) + 1;
    }
  }

  const totalNodes = Object.keys(index.nodes).length;

  console.log('Proximity Index Statistics');
  console.log('=========================');
  console.log(`Total nodes: ${totalNodes}`);
  console.log(`Total edges: ${totalEdges}`);
  console.log(`Orphan nodes: ${orphanCount}`);
  console.log(`Sources: ${Object.keys(index.sources).length}`);
  console.log(`Generated: ${index.generated}`);
  console.log('');
  console.log('Nodes by type:');
  for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
  }
  console.log('');
  console.log('Edges by relationship:');
  for (const [r, c] of Object.entries(relCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r}: ${c}`);
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const index = loadIndex();

  switch (args.command) {
    case 'reach':
      cmdReach(index, args);
      break;
    case 'path':
      cmdPath(index, args);
      break;
    case 'neighbors':
      cmdNeighbors(index, args);
      break;
    case 'impact':
      cmdImpact(index, args);
      break;
    case 'coverage':
      cmdCoverage(index, args);
      break;
    case 'proximity':
      cmdProximity(index, args);
      break;
    case 'stats':
      cmdStats(index);
      break;
    default:
      process.stderr.write(`Unknown command: ${args.command}\n`);
      printHelp();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { reach, findPath, resolveNodeKey, suggestSimilarKeys };
