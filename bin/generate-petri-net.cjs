#!/usr/bin/env node
'use strict';
// bin/generate-petri-net.cjs
// Generates a Graphviz DOT + SVG Petri Net for the nForma quorum token-passing model.
// Requirements: PET-01, PET-02, PET-03
//
// Usage:
//   node bin/generate-petri-net.cjs
//
// Output:
//   .planning/formal/petri/quorum-petri-net.dot  — Graphviz DOT source
//   .planning/formal/petri/quorum-petri-net.svg  — Rendered SVG (via @hpcc-js/wasm-graphviz)
//
// No system Graphviz install required — uses @hpcc-js/wasm-graphviz WASM build.

const fs   = require('fs');
const path = require('path');

// Quorum configuration
const QUORUM_SLOTS    = ['gemini', 'opencode', 'copilot', 'codex', 'claude'];
const MIN_QUORUM_SIZE = Math.ceil(QUORUM_SLOTS.length / 2);  // = 3

// Optional --min-quorum=N override (makes PET-03 deadlock check exercisable at runtime)
const minQuorumArg = process.argv.slice(2).find(a => a.startsWith('--min-quorum='));
const parsedMinQuorum = minQuorumArg ? parseInt(minQuorumArg.split('=')[1], 10) : MIN_QUORUM_SIZE;
const effectiveMinQuorum = Number.isFinite(parsedMinQuorum) ? parsedMinQuorum : MIN_QUORUM_SIZE;

// PET-03: structural deadlock check (pure logic — before any rendering)
// A structural deadlock occurs when the quorum transition can NEVER fire because
// min_quorum_size > available_slots (more approvals needed than slots available)
if (effectiveMinQuorum > QUORUM_SLOTS.length) {
  process.stderr.write(
    '[generate-petri-net] WARNING: Structural deadlock detected.\n' +
    '[generate-petri-net] min_quorum_size (' + effectiveMinQuorum + ') > ' +
    'available_slots (' + QUORUM_SLOTS.length + ').\n' +
    '[generate-petri-net] Quorum transition can never fire.\n'
  );
  // Do NOT exit 1 — still emit the net for documentation purposes (per PET-03)
}

// buildDot: pure function — exported via _pure for unit testing
function buildDot(slots, minQuorum) {
  return [
    'digraph quorum_petri_net {',
    '  rankdir=LR;',
    '  label="nForma Quorum Petri Net (min_quorum=' + minQuorum + '/' + slots.length + ')";',
    '  node [fontname="Helvetica"];',
    '',
    '  // Places (circles)',
    '  node [shape=circle, fixedsize=true, width=1.2];',
    '  idle         [label="idle"];',
    '  collecting   [label="collecting\\nvotes"];',
    '  deliberating [label="deliberating"];',
    '  decided      [label="decided"];',
    '',
    '  // Transitions (filled rectangles)',
    '  node [shape=rect, height=0.3, width=1.5, style=filled, fillcolor=black, fontcolor=white];',
    '  t_start      [label="start quorum"];',
    '  t_approve    [label="approve\\n(>=' + minQuorum + '/' + slots.length + ')"];',
    '  t_deliberate [label="deliberate"];',
    '  t_force      [label="force decide\\n(max rounds)"];',
    '',
    '  // Arcs (bipartite: place->transition or transition->place only)',
    '  idle -> t_start;',
    '  t_start -> collecting;',
    '  collecting -> t_approve;',
    '  collecting -> t_deliberate;',
    '  t_approve -> decided;',
    '  t_deliberate -> deliberating;',
    '  deliberating -> t_approve;',
    '  deliberating -> t_force;',
    '  t_force -> decided;',
    '}',
  ].join('\n');
}

// ── Roadmap Petri Net (SIG-02) ───────────────────────────────────────────────

/**
 * parseRoadmapPhases(roadmapContent) — parses ROADMAP.md to extract phases and dependencies.
 * @param {string} roadmapContent - Raw ROADMAP.md content
 * @returns {Array<{ number: string, name: string, dependsOn: string[], completed: boolean }>}
 */
function parseRoadmapPhases(roadmapContent) {
  if (typeof roadmapContent !== 'string') return [];
  const lines = roadmapContent.split('\n');
  const phases = [];
  let currentPhase = null;

  const phaseHeaderRe = /^### Phase (v[\d.]+-\d+):\s*(.+)/;
  const dependsOnRe = /^\*\*Depends on\*\*:\s*(.+)/;
  const checkboxRe = /^- \[(x| )\].*(?:Phase )?(v[\d.]+-\d+)/;

  const completedFromCheckboxes = new Set();

  for (const line of lines) {
    const headerMatch = phaseHeaderRe.exec(line);
    if (headerMatch) {
      if (currentPhase) phases.push(currentPhase);
      currentPhase = {
        number: headerMatch[1],
        name: headerMatch[2].trim(),
        dependsOn: [],
        completed: false,
      };
      if (line.includes('completed')) currentPhase.completed = true;
      continue;
    }

    if (currentPhase) {
      const depsMatch = dependsOnRe.exec(line);
      if (depsMatch) {
        const depsStr = depsMatch[1];
        const phaseRefs = depsStr.match(/v[\d.]+-\d+/g);
        if (phaseRefs) {
          currentPhase.dependsOn = phaseRefs;
        }
        continue;
      }
    }

    const cbMatch = checkboxRe.exec(line);
    if (cbMatch && cbMatch[1] === 'x') {
      completedFromCheckboxes.add(cbMatch[2]);
    }
  }
  if (currentPhase) phases.push(currentPhase);

  // Mark completed from checkboxes and content patterns
  for (const phase of phases) {
    if (completedFromCheckboxes.has(phase.number)) {
      phase.completed = true;
    }
  }

  // Second pass: detect "(completed YYYY-MM-DD)" near phase headers
  let currentPhaseIdx = -1;
  for (const line of lines) {
    const headerMatch = phaseHeaderRe.exec(line);
    if (headerMatch) {
      currentPhaseIdx = phases.findIndex(function(p) { return p.number === headerMatch[1]; });
      continue;
    }
    if (currentPhaseIdx >= 0 && /completed\s+\d{4}-\d{2}-\d{2}/.test(line)) {
      phases[currentPhaseIdx].completed = true;
    }
  }

  return phases;
}

/**
 * buildRoadmapDot(phases) — generates a Petri net DOT from parsed phases.
 * @param {Array<{ number: string, name: string, dependsOn: string[], completed: boolean }>} phases
 * @returns {string} DOT source
 */
function buildRoadmapDot(phases) {
  const lines = [
    'digraph roadmap_petri_net {',
    '  rankdir=LR;',
    '  label="nForma Roadmap Petri Net (' + phases.length + ' phases)";',
    '  node [fontname="Helvetica"];',
    '',
  ];

  if (phases.length === 0) {
    lines.push('}');
    return lines.join('\n');
  }

  const phaseNumbers = new Set(phases.map(function(p) { return p.number; }));
  const hasDependents = new Set();
  for (const phase of phases) {
    for (const dep of phase.dependsOn) {
      if (phaseNumbers.has(dep)) hasDependents.add(dep);
    }
  }

  lines.push('  // Places (circles)');
  lines.push('  node [shape=circle, fixedsize=true, width=0.8];');

  const sourcesExist = phases.some(function(p) { return p.dependsOn.length === 0; });
  if (sourcesExist) {
    lines.push('  p_start [label="start"];');
  }

  for (const phase of phases) {
    for (const dep of phase.dependsOn) {
      if (!phaseNumbers.has(dep)) continue;
      const placeId = 'p_' + dep.replace(/[.-]/g, '_') + '__' + phase.number.replace(/[.-]/g, '_');
      lines.push('  ' + placeId + ' [label=""];');
    }
  }

  const sinksExist = phases.some(function(p) { return !hasDependents.has(p.number); });
  if (sinksExist) {
    lines.push('  p_done [label="done"];');
  }

  lines.push('');
  lines.push('  // Transitions (rectangles) -- phases');
  for (const phase of phases) {
    const nodeId = 't_' + phase.number.replace(/[.-]/g, '_');
    const safeName = String(phase.name == null ? '' : phase.name)
      .substring(0, 30)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    const label = phase.number + '\\n' + safeName;
    if (phase.completed) {
      lines.push('  ' + nodeId + ' [shape=rect, height=0.5, width=2.0, style=filled, fillcolor="#4CAF50", fontcolor=white, label="' + label + '"];');
    } else {
      lines.push('  ' + nodeId + ' [shape=rect, height=0.5, width=2.0, style=filled, fillcolor=black, fontcolor=white, label="' + label + '"];');
    }
  }

  lines.push('');
  lines.push('  // Arcs');
  for (const phase of phases) {
    const nodeId = 't_' + phase.number.replace(/[.-]/g, '_');

    if (phase.dependsOn.length === 0 && sourcesExist) {
      lines.push('  p_start -> ' + nodeId + ';');
    }

    for (const dep of phase.dependsOn) {
      if (!phaseNumbers.has(dep)) continue;
      const placeId = 'p_' + dep.replace(/[.-]/g, '_') + '__' + phase.number.replace(/[.-]/g, '_');
      lines.push('  ' + placeId + ' -> ' + nodeId + ';');
    }

    for (const downstream of phases) {
      if (downstream.dependsOn.includes(phase.number)) {
        const placeId = 'p_' + phase.number.replace(/[.-]/g, '_') + '__' + downstream.number.replace(/[.-]/g, '_');
        lines.push('  ' + nodeId + ' -> ' + placeId + ';');
      }
    }

    if (!hasDependents.has(phase.number) && sinksExist) {
      lines.push('  ' + nodeId + ' -> p_done;');
    }
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * computeCriticalPath(phases) — finds the longest path through the phase DAG.
 * @param {Array<{ number: string, name: string, dependsOn: string[], completed: boolean }>} phases
 * @returns {{ path: string[], length: number }}
 */
function computeCriticalPath(phases) {
  if (phases.length === 0) return { path: [], length: 0 };

  const phaseMap = new Map();
  for (const p of phases) phaseMap.set(p.number, p);

  // Kahn's algorithm for topological sort + longest path DP
  const inDegree = new Map();
  const adj = new Map();

  for (const p of phases) {
    if (!inDegree.has(p.number)) inDegree.set(p.number, 0);
    if (!adj.has(p.number)) adj.set(p.number, []);
  }

  for (const p of phases) {
    for (const dep of p.dependsOn) {
      if (!phaseMap.has(dep)) continue;
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep).push(p.number);
      inDegree.set(p.number, (inDegree.get(p.number) || 0) + 1);
    }
  }

  const queue = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }

  const dist = new Map();
  const pred = new Map();
  for (const p of phases) {
    dist.set(p.number, 1);
    pred.set(p.number, null);
  }

  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of (adj.get(node) || [])) {
      if (dist.get(node) + 1 > dist.get(next)) {
        dist.set(next, dist.get(node) + 1);
        pred.set(next, node);
      }
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }

  let maxDist = 0;
  let endNode = null;
  for (const [node, d] of dist) {
    if (d > maxDist) {
      maxDist = d;
      endNode = node;
    }
  }

  const criticalPath = [];
  let current = endNode;
  while (current !== null) {
    criticalPath.unshift(current);
    current = pred.get(current);
  }

  return { path: criticalPath, length: criticalPath.length };
}

// Export pure functions for unit testing
module.exports._pure = { buildDot, buildRoadmapDot, computeCriticalPath, parseRoadmapPhases };

// Guard against running main logic when required as a module (test imports)
if (require.main === module) {
  const isRoadmap = process.argv.includes('--roadmap');

  if (isRoadmap) {
    // ── Roadmap Petri Net mode ──────────────────────────────────────────────
    const roadmapPath = path.join(process.cwd(), '.planning', 'ROADMAP.md');
    if (!fs.existsSync(roadmapPath)) {
      process.stderr.write('[generate-petri-net] ROADMAP.md not found at: ' + roadmapPath + '\n');
      process.exit(1);
    }

    const content = fs.readFileSync(roadmapPath, 'utf8');
    const phases = parseRoadmapPhases(content);
    const dotContent = buildRoadmapDot(phases);
    const criticalPath = computeCriticalPath(phases);

    const outDir  = path.join(process.cwd(), '.planning', 'formal', 'petri');
    const dotPath = path.join(outDir, 'roadmap-petri-net.dot');
    const svgPath = path.join(outDir, 'roadmap-petri-net.svg');

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(dotPath, dotContent);
    process.stdout.write('[generate-petri-net] Roadmap DOT written to: ' + dotPath + '\n');
    process.stdout.write('[generate-petri-net] Phases: ' + phases.length + '\n');
    process.stdout.write('[generate-petri-net] Critical path (' + criticalPath.length + '): ' + criticalPath.path.join(' -> ') + '\n');

    // Render SVG
    (async () => {
      let Graphviz;
      try {
        ({ Graphviz } = await import('@hpcc-js/wasm-graphviz'));
      } catch (_e) {
        process.stderr.write('[generate-petri-net] @hpcc-js/wasm-graphviz not installed -- SVG skipped.\n');
        process.exit(0);
      }
      try {
        const graphviz = await Graphviz.load();
        const svg      = graphviz.dot(dotContent);
        fs.writeFileSync(svgPath, svg);
        process.stdout.write('[generate-petri-net] Roadmap SVG written to: ' + svgPath + '\n');
      } catch (renderErr) {
        process.stderr.write('[generate-petri-net] SVG render failed: ' + renderErr.message + '\n');
        process.exit(1);
      }
    })();
  } else {
    // ── Quorum Petri Net mode (existing) ────────────────────────────────────
    const dotContent = buildDot(QUORUM_SLOTS, effectiveMinQuorum);
    const outDir     = path.join(process.cwd(), '.planning', 'formal', 'petri');
    const dotPath    = path.join(outDir, 'quorum-petri-net.dot');
    const svgPath    = path.join(outDir, 'quorum-petri-net.svg');

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(dotPath, dotContent);
    process.stdout.write('[generate-petri-net] DOT written to: ' + dotPath + '\n');

    (async () => {
      let Graphviz;
      try {
        ({ Graphviz } = await import('@hpcc-js/wasm-graphviz'));
      } catch (importErr) {
        process.stderr.write(
          '[generate-petri-net] @hpcc-js/wasm-graphviz not installed.\n' +
          '[generate-petri-net] Run: npm install --save-dev @hpcc-js/wasm-graphviz\n'
        );
        process.exit(1);
      }
      try {
        const graphviz = await Graphviz.load();
        const svg      = graphviz.dot(dotContent);
        fs.writeFileSync(svgPath, svg);
        process.stdout.write('[generate-petri-net] SVG written to: ' + svgPath + '\n');
      } catch (renderErr) {
        process.stderr.write('[generate-petri-net] SVG render failed: ' + renderErr.message + '\n');
        process.exit(1);
      }
    })();
  }
}
