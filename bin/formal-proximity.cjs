#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAL_DIR = path.join(process.cwd(), '.planning', 'formal');
const SPEC_DIR = path.join(FORMAL_DIR, 'spec');
const OUTPUT_FILE = path.join(FORMAL_DIR, 'proximity-index.json');

// ─────────────────────────────────────────────────────────────────────────────
// Scoring method: "semantic" — weights edges by semantic coverage strength
// ─────────────────────────────────────────────────────────────────────────────
const SEMANTIC_WEIGHTS = {
  verifies: 1.0, verified_by: 1.0,       // direct formal coverage
  models: 1.0, modeled_by: 1.0,          // formal model link
  tests: 0.8, tested_by: 0.8,            // test coverage implies understanding
  declares: 0.7, declared_in: 0.7,       // annotation link
  emits: 0.6, emitted_by: 0.6,           // instrumentation
  maps_to: 0.6, mapped_from: 0.6,        // constant mapping
  triggers: 0.5, triggered_by: 0.5,      // event trigger
  transitions: 0.4, transitioned_by: 0.4, // FSM transition
  constrains: 0.4, constrained_by: 0.4,  // constraint
  from_state: 0.4, from_state_of: 0.4,   // FSM state
  describes: 0.2, described_by: 0.2,     // conceptual, loose
  scores: 0.2, scored_by: 0.2,           // risk scoring
  affects: 0.2, affected_by: 0.2,        // debt linkage
  owns: 0.1, owned_by: 0.1,             // structural containment
  contains: 0.1, in_file: 0.1,          // structural containment
};

// Original edge weights (legacy default)
const EDGE_WEIGHTS = {
  owns: 1.0,
  owned_by: 1.0,
  contains: 1.0,
  in_file: 1.0,
  emits: 0.9,
  emitted_by: 0.9,
  maps_to: 0.9,
  mapped_from: 0.9,
  declared_in: 0.9,
  modeled_by: 0.8,
  models: 0.8,
  declares: 0.8,
  verified_by: 0.8,
  verifies: 0.8,
  tested_by: 0.7,
  tests: 0.7,
  triggers: 0.7,
  triggered_by: 0.7,
  transitions: 0.6,
  transitioned_by: 0.6,
  describes: 0.5,
  described_by: 0.5,
  constrains: 0.5,
  constrained_by: 0.5,
  scores: 0.4,
  scored_by: 0.4,
  affects: 0.4,
  affected_by: 0.4,
  from_state: 0.6,
  from_state_of: 0.6,
};

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Scoring methods registry
// ─────────────────────────────────────────────────────────────────────────────
const SCORING_METHODS = {
  legacy:   { weights: EDGE_WEIGHTS,    hubDampen: false, tfidf: false, categoryBoost: false, embedding: false },
  semantic: { weights: SEMANTIC_WEIGHTS, hubDampen: false, tfidf: false, categoryBoost: false, embedding: false },
  hub:      { weights: EDGE_WEIGHTS,    hubDampen: true,  tfidf: false, categoryBoost: false, embedding: false },
  tfidf:    { weights: EDGE_WEIGHTS,    hubDampen: false, tfidf: true,  categoryBoost: false, embedding: false },
  category: { weights: EDGE_WEIGHTS,    hubDampen: false, tfidf: false, categoryBoost: true,  embedding: false },
  // Combos (graph-only)
  'semantic+tfidf':     { weights: SEMANTIC_WEIGHTS, hubDampen: false, tfidf: true,  categoryBoost: false, embedding: false },
  'semantic+hub':       { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: false, categoryBoost: false, embedding: false },
  'semantic+hub+tfidf': { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: true,  categoryBoost: false, embedding: false },
  'semantic+hub+cat':   { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: false, categoryBoost: true,  embedding: false },
  full:                 { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: true,  categoryBoost: true,  embedding: false },
  // Embedding-amplified combos — blend neural cosine similarity with graph traversal
  'semantic+embed':           { weights: SEMANTIC_WEIGHTS, hubDampen: false, tfidf: false, categoryBoost: false, embedding: true },
  'semantic+hub+embed':       { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: false, categoryBoost: false, embedding: true },
  'semantic+hub+tfidf+embed': { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: true,  categoryBoost: false, embedding: true },
  'full+embed':               { weights: SEMANTIC_WEIGHTS, hubDampen: true,  tfidf: true,  categoryBoost: true,  embedding: true },
};

const DEFAULT_SCORING_METHOD = 'semantic+hub+tfidf';

// Ensemble: complementary methods whose union maximizes true-positive recall.
// Benchmark (93 candidates, Haiku verdicts) showed each method finds different TPs:
//   sem+hub+tfidf → CI-06       (hub dampening + keyword granularity, best noise rejection)
//   sem+tfidf     → TRACE-01, LTCY-01 (keyword similarity catches pairs hub dampening penalizes)
// Legacy (no hub dampening) was dropped: finds same TPs as sem+tfidf but with 85% false positive rate.
const ENSEMBLE_METHODS = ['semantic+hub+tfidf', 'semantic+tfidf'];

// Amplified ensemble: adds embedding method to surface pairs the graph can't reach.
// The embedding method finds high-cosine pairs with zero graph path — graph-only methods miss these entirely.
const AMPLIFIED_ENSEMBLE_METHODS = ['semantic+hub+tfidf', 'semantic+tfidf', 'semantic+hub+embed'];

// Forward -> reverse relationship mapping
const REVERSE_RELS = {
  owns: 'owned_by',
  owned_by: 'owns',
  contains: 'in_file',
  in_file: 'contains',
  emits: 'emitted_by',
  emitted_by: 'emits',
  maps_to: 'mapped_from',
  mapped_from: 'maps_to',
  declared_in: 'declares',
  declares: 'declared_in',
  modeled_by: 'models',
  models: 'modeled_by',
  verified_by: 'verifies',
  verifies: 'verified_by',
  tested_by: 'tests',
  tests: 'tested_by',
  triggers: 'triggered_by',
  triggered_by: 'triggers',
  transitions: 'transitioned_by',
  transitioned_by: 'transitions',
  describes: 'described_by',
  described_by: 'describes',
  constrains: 'constrained_by',
  constrained_by: 'constrains',
  scores: 'scored_by',
  scored_by: 'scores',
  affects: 'affected_by',
  affected_by: 'affects',
  from_state: 'from_state_of',
  from_state_of: 'from_state',
};

const DECAY = 0.7;

function parseArgs(argv) {
  const args = { dryRun: false, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/formal-proximity.cjs [options]

Options:
  --dry-run    Build index but don't write to disk
  --json       Print index to stdout instead of file
  --help       Show this help message

Builds .planning/formal/proximity-index.json from all 12 source artifact types.
`);
}

function readJsonSafe(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function fileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  } catch {
    return null;
  }
}

function fileMtime(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

function ensureNode(nodes, key, type, id, meta) {
  if (!nodes[key]) {
    nodes[key] = { type, id, edges: [] };
  }
  if (meta) {
    Object.assign(nodes[key], meta);
  }
  return nodes[key];
}

function addEdge(node, to, rel, source) {
  // Avoid duplicate edges
  const exists = node.edges.some(e => e.to === to && e.rel === rel && e.source === source);
  if (!exists) {
    node.edges.push({ to, rel, source });
  }
}

function buildIndex() {
  const nodes = {};
  const sources = {};
  const warnings = [];

  // Step 1: scope.json files
  if (fs.existsSync(SPEC_DIR)) {
    const specDirs = fs.readdirSync(SPEC_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of specDirs) {
      const scopePath = path.join(SPEC_DIR, dir, 'scope.json');
      const scope = readJsonSafe(scopePath);
      if (!scope) continue;

      const sourceKey = `scope.json:${dir}`;
      sources[sourceKey] = { mtime: fileMtime(scopePath), hash: fileHash(scopePath) };

      const moduleKey = `formal_module::${dir}`;
      ensureNode(nodes, moduleKey, 'formal_module', dir);

      // source_files -> code_file nodes with owns edges
      if (Array.isArray(scope.source_files)) {
        for (const sf of scope.source_files) {
          const cfKey = `code_file::${sf}`;
          ensureNode(nodes, cfKey, 'code_file', sf);
          addEdge(nodes[cfKey], moduleKey, 'owns', 'scope.json');
        }
      }

      // concepts -> concept nodes with describes edges
      if (Array.isArray(scope.concepts)) {
        for (const c of scope.concepts) {
          const cKey = `concept::${c}`;
          ensureNode(nodes, cKey, 'concept', c);
          addEdge(nodes[cKey], moduleKey, 'describes', 'scope.json');
        }
      }
    }
  }

  // Step 2: constants-mapping.json
  const constPath = path.join(FORMAL_DIR, 'constants-mapping.json');
  const constData = readJsonSafe(constPath);
  if (constData && Array.isArray(constData.mappings)) {
    sources['constants-mapping.json'] = { mtime: fileMtime(constPath), hash: fileHash(constPath) };
    for (const m of constData.mappings) {
      const constKey = `constant::${m.constant}`;
      const meta = {};
      if (m.formal_value !== undefined) meta.formal_value = m.formal_value;
      ensureNode(nodes, constKey, 'constant', m.constant, meta);

      if (m.config_path) {
        const cpKey = `config_path::${m.config_path}`;
        ensureNode(nodes, cpKey, 'config_path', m.config_path);
        addEdge(nodes[constKey], cpKey, 'maps_to', 'constants-mapping');
      }

      if (m.source) {
        const fmKey = `formal_model::${m.source}`;
        ensureNode(nodes, fmKey, 'formal_model', m.source);
        addEdge(nodes[constKey], fmKey, 'declared_in', 'constants-mapping');
      }
    }
  } else {
    warnings.push('constants-mapping.json not found or invalid, skipping');
  }

  // Step 3: model-registry.json
  const regPath = path.join(FORMAL_DIR, 'model-registry.json');
  const regData = readJsonSafe(regPath);
  if (regData && regData.models) {
    sources['model-registry.json'] = { mtime: fileMtime(regPath), hash: fileHash(regPath) };
    for (const [modelPath, modelInfo] of Object.entries(regData.models)) {
      const fmKey = `formal_model::${modelPath}`;
      const meta = {};
      if (modelInfo.source_layer) meta.source_layer = modelInfo.source_layer;
      if (modelInfo.gate_maturity) meta.gate_maturity = modelInfo.gate_maturity;
      ensureNode(nodes, fmKey, 'formal_model', modelPath, meta);

      if (Array.isArray(modelInfo.requirements)) {
        for (const reqId of modelInfo.requirements) {
          const reqKey = `requirement::${reqId}`;
          ensureNode(nodes, reqKey, 'requirement', reqId);
          addEdge(nodes[reqKey], fmKey, 'modeled_by', 'model-registry');
        }
      }
    }
  } else {
    warnings.push('model-registry.json not found or invalid, skipping');
  }

  // Step 4: invariant-catalog.json
  const invPath = path.join(FORMAL_DIR, 'semantics', 'invariant-catalog.json');
  const invData = readJsonSafe(invPath);
  if (invData && Array.isArray(invData.invariants)) {
    sources['invariant-catalog.json'] = { mtime: fileMtime(invPath), hash: fileHash(invPath) };
    for (const inv of invData.invariants) {
      // Use config or name+source_file for uniqueness since invariant names repeat (TypeOK)
      const invId = inv.config ? `${inv.name}@${inv.config}` : inv.name;
      const invKey = `invariant::${invId}`;
      ensureNode(nodes, invKey, 'invariant', invId);

      if (inv.source_file) {
        const fmPath = `.planning/formal/${inv.source_file}`;
        const fmKey = `formal_model::${fmPath}`;
        ensureNode(nodes, fmKey, 'formal_model', fmPath);
        addEdge(nodes[invKey], fmKey, 'declared_in', 'invariant-catalog');
      }
    }
  } else {
    warnings.push('invariant-catalog.json not found or invalid, skipping');
  }

  // Step 5: traceability-matrix.json
  const tmPath = path.join(FORMAL_DIR, 'traceability-matrix.json');
  const tmData = readJsonSafe(tmPath);
  if (tmData && tmData.requirements) {
    sources['traceability-matrix.json'] = { mtime: fileMtime(tmPath), hash: fileHash(tmPath) };
    for (const [reqId, reqInfo] of Object.entries(tmData.requirements)) {
      const reqKey = `requirement::${reqId}`;
      ensureNode(nodes, reqKey, 'requirement', reqId);

      if (Array.isArray(reqInfo.properties)) {
        for (const prop of reqInfo.properties) {
          if (prop.property_name) {
            const invKey = `invariant::${prop.property_name}`;
            // Only add edge if invariant exists or create it
            ensureNode(nodes, invKey, 'invariant', prop.property_name);
            addEdge(nodes[reqKey], invKey, 'verified_by', 'traceability-matrix');
          }
        }
      }
    }
  } else {
    warnings.push('traceability-matrix.json not found or invalid, skipping');
  }

  // Step 6: unit-test-coverage.json
  const utcPath = path.join(FORMAL_DIR, 'unit-test-coverage.json');
  const utcData = readJsonSafe(utcPath);
  if (utcData && utcData.requirements) {
    sources['unit-test-coverage.json'] = { mtime: fileMtime(utcPath), hash: fileHash(utcPath) };
    for (const [reqId, reqInfo] of Object.entries(utcData.requirements)) {
      if (!reqInfo.covered) continue;
      const reqKey = `requirement::${reqId}`;
      ensureNode(nodes, reqKey, 'requirement', reqId);

      if (Array.isArray(reqInfo.test_cases)) {
        for (const tc of reqInfo.test_cases) {
          if (tc.test_file) {
            const tfKey = `test_file::${tc.test_file}`;
            ensureNode(nodes, tfKey, 'test_file', tc.test_file);
            addEdge(nodes[reqKey], tfKey, 'tested_by', 'unit-test-coverage');
          }
        }
      }
    }
  } else {
    warnings.push('unit-test-coverage.json not found or invalid, skipping');
  }

  // Step 7: instrumentation-map.json
  const imPath = path.join(FORMAL_DIR, 'evidence', 'instrumentation-map.json');
  const imData = readJsonSafe(imPath);
  if (imData && Array.isArray(imData.emission_points)) {
    sources['instrumentation-map.json'] = { mtime: fileMtime(imPath), hash: fileHash(imPath) };
    for (const ep of imData.emission_points) {
      const clId = `${ep.file}:${ep.line_number}`;
      const clKey = `code_line::${clId}`;
      ensureNode(nodes, clKey, 'code_line', clId);

      const faKey = `formal_action::${ep.action}`;
      ensureNode(nodes, faKey, 'formal_action', ep.action);
      addEdge(nodes[clKey], faKey, 'emits', 'instrumentation-map');

      // contains edge from code_file to code_line
      const cfKey = `code_file::${ep.file}`;
      ensureNode(nodes, cfKey, 'code_file', ep.file);
      addEdge(nodes[cfKey], clKey, 'contains', 'instrumentation-map');
    }
  } else {
    warnings.push('instrumentation-map.json not found or invalid, skipping');
  }

  // Step 8: event-vocabulary.json
  const evPath = path.join(FORMAL_DIR, 'evidence', 'event-vocabulary.json');
  const evData = readJsonSafe(evPath);
  if (evData && evData.vocabulary) {
    sources['event-vocabulary.json'] = { mtime: fileMtime(evPath), hash: fileHash(evPath) };
    for (const [actionName, info] of Object.entries(evData.vocabulary)) {
      if (actionName === 'undefined') continue;
      const faKey = `formal_action::${actionName}`;
      ensureNode(nodes, faKey, 'formal_action', actionName);

      if (info.xstate_event) {
        const xeKey = `xstate_event::${info.xstate_event}`;
        ensureNode(nodes, xeKey, 'xstate_event', info.xstate_event);
        addEdge(nodes[faKey], xeKey, 'triggers', 'event-vocabulary');
      }
    }
  } else {
    warnings.push('event-vocabulary.json not found or invalid, skipping');
  }

  // Step 9: observed-fsm.json
  const fsmPath = path.join(FORMAL_DIR, 'semantics', 'observed-fsm.json');
  const fsmData = readJsonSafe(fsmPath);
  if (fsmData && fsmData.observed_transitions) {
    sources['observed-fsm.json'] = { mtime: fileMtime(fsmPath), hash: fileHash(fsmPath) };
    for (const [state, events] of Object.entries(fsmData.observed_transitions)) {
      const fromStateKey = `fsm_state::${state}`;
      ensureNode(nodes, fromStateKey, 'fsm_state', state);

      for (const [event, info] of Object.entries(events)) {
        const xeKey = `xstate_event::${event}`;
        ensureNode(nodes, xeKey, 'xstate_event', event);

        const toStateKey = `fsm_state::${info.to_state}`;
        ensureNode(nodes, toStateKey, 'fsm_state', info.to_state);

        addEdge(nodes[xeKey], toStateKey, 'transitions', 'observed-fsm');
        addEdge(nodes[xeKey], fromStateKey, 'from_state', 'observed-fsm');
      }
    }
  } else {
    warnings.push('observed-fsm.json not found or invalid, skipping');
  }

  // Step 10: risk-heatmap.json
  const rhPath = path.join(FORMAL_DIR, 'reasoning', 'risk-heatmap.json');
  const rhData = readJsonSafe(rhPath);
  if (rhData && Array.isArray(rhData.transitions)) {
    sources['risk-heatmap.json'] = { mtime: fileMtime(rhPath), hash: fileHash(rhPath) };
    for (const t of rhData.transitions) {
      // Composite key: risk_transition::FROM_STATE-EVENT-TO_STATE with hyphens
      const rtId = `${t.state}-${t.event}-${t.to_state}`;
      const rtKey = `risk_transition::${rtId}`;
      const meta = { risk_score: t.risk_score, risk_tier: t.risk_tier };
      ensureNode(nodes, rtKey, 'risk_transition', rtId, meta);

      const fromKey = `fsm_state::${t.state}`;
      ensureNode(nodes, fromKey, 'fsm_state', t.state);
      addEdge(nodes[rtKey], fromKey, 'scores', 'risk-heatmap');

      const toKey = `fsm_state::${t.to_state}`;
      ensureNode(nodes, toKey, 'fsm_state', t.to_state);
      addEdge(nodes[rtKey], toKey, 'scores', 'risk-heatmap');
    }
  } else {
    warnings.push('risk-heatmap.json not found or invalid, skipping');
  }

  // Step 11: git-heatmap.json
  const ghPath = path.join(FORMAL_DIR, 'evidence', 'git-heatmap.json');
  const ghData = readJsonSafe(ghPath);
  if (ghData && ghData.signals && Array.isArray(ghData.signals.numerical_adjustments)) {
    sources['git-heatmap.json'] = { mtime: fileMtime(ghPath), hash: fileHash(ghPath) };
    for (const signal of ghData.signals.numerical_adjustments) {
      const constKey = `constant::${signal.constant_name}`;
      if (nodes[constKey]) {
        nodes[constKey].drift = {
          direction: signal.drift_direction || 'unknown',
          touch_count: signal.touch_count || 0,
        };
      }
    }
  } else {
    warnings.push('git-heatmap.json not found or invalid, skipping');
  }

  // Step 12: debt.json
  const debtPath = path.join(FORMAL_DIR, 'debt.json');
  const debtData = readJsonSafe(debtPath);
  if (debtData) {
    sources['debt.json'] = { mtime: fileMtime(debtPath), hash: fileHash(debtPath) };
    if (Array.isArray(debtData.debt_entries)) {
      for (const entry of debtData.debt_entries) {
        const deKey = `debt_entry::${entry.id || entry.title || 'unknown'}`;
        ensureNode(nodes, deKey, 'debt_entry', entry.id || entry.title || 'unknown');

        if (Array.isArray(entry.requirements)) {
          for (const reqId of entry.requirements) {
            const reqKey = `requirement::${reqId}`;
            ensureNode(nodes, reqKey, 'requirement', reqId);
            addEdge(nodes[deKey], reqKey, 'affects', 'debt');
          }
        }
      }
    }
  } else {
    warnings.push('debt.json not found or invalid, skipping');
  }

  // Step 12b: Parse @requirement annotations from formal model source files
  const SOURCE_DIRS = [
    { dir: path.join(FORMAL_DIR, 'alloy'), glob: '*.als' },
    { dir: path.join(FORMAL_DIR, 'tla'), glob: '*.tla' },
    { dir: path.join(FORMAL_DIR, 'prism'), glob: '*.pm' },
    { dir: path.join(FORMAL_DIR, 'prism'), glob: '*.props' },
  ];
  const annotationRegex = /[@]requirement\s+([A-Z][A-Z0-9_-]+)/g;
  let annotationEdgeCount = 0;
  let annotationFileCount = 0;
  let latestAnnotationMtime = null;

  for (const { dir, glob: globPattern } of SOURCE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const ext = globPattern.replace('*', '');
    const files = fs.readdirSync(dir).filter(f => f.endsWith(ext));
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }

      const mtime = fileMtime(fullPath);
      if (mtime && (!latestAnnotationMtime || mtime > latestAnnotationMtime)) {
        latestAnnotationMtime = mtime;
      }

      // Extract unique requirement IDs from this file
      const reqIds = new Set();
      let match;
      while ((match = annotationRegex.exec(content)) !== null) {
        reqIds.add(match[1]);
      }

      if (reqIds.size === 0) continue;
      annotationFileCount++;

      const relativePath = path.relative(process.cwd(), fullPath);
      const fmKey = `formal_model::${relativePath}`;
      ensureNode(nodes, fmKey, 'formal_model', relativePath);

      for (const reqId of reqIds) {
        const reqKey = `requirement::${reqId}`;
        ensureNode(nodes, reqKey, 'requirement', reqId);
        addEdge(nodes[reqKey], fmKey, 'modeled_by', 'source-annotation');
        annotationEdgeCount++;
      }
    }
  }

  if (latestAnnotationMtime) {
    sources['source-annotations'] = { mtime: latestAnnotationMtime };
  }
  process.stderr.write('[proximity] Extracted ' + annotationEdgeCount + ' requirement annotations from ' + annotationFileCount + ' formal model files\n');

  // Step 12c: Parse @requirement annotations from JavaScript source files (bin/, hooks/)
  const SOURCE_CODE_DIRS = [
    { dir: path.join(process.cwd(), 'bin'), ext: '.cjs' },
    { dir: path.join(process.cwd(), 'bin'), ext: '.mjs' },
    { dir: path.join(process.cwd(), 'hooks'), ext: '.js' },
  ];
  const codeAnnotationRegex = /@requirement\s+([A-Z][A-Z0-9_-]+)/g;
  const codeReqHeaderRegex = /\/\/\s*Requirements:\s*(.+)/;
  let codeAnnotationEdgeCount = 0;
  let codeAnnotationFileCount = 0;
  let latestCodeAnnotationMtime = null;

  for (const { dir, ext } of SOURCE_CODE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    let dirFiles;
    try { dirFiles = fs.readdirSync(dir); } catch { continue; }
    const filtered = dirFiles.filter(f => f.endsWith(ext) && !f.endsWith('.test.cjs') && !f.endsWith('.test.js'));
    for (const file of filtered) {
      const fullPath = path.join(dir, file);
      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }

      const mtime = fileMtime(fullPath);
      if (mtime && (!latestCodeAnnotationMtime || mtime > latestCodeAnnotationMtime)) {
        latestCodeAnnotationMtime = mtime;
      }

      // Only parse first 30 lines — annotations belong in file headers only
      const headerLines = content.split('\n').slice(0, 30).join('\n');
      const reqIds = new Set();

      // Pattern 1: // @requirement REQ-ID
      let codeMatch;
      while ((codeMatch = codeAnnotationRegex.exec(headerLines)) !== null) {
        reqIds.add(codeMatch[1]);
      }

      // Pattern 2: // Requirements: REQ-01, REQ-02
      const headerMatch = headerLines.match(codeReqHeaderRegex);
      if (headerMatch) {
        const ids = headerMatch[1].split(/[,\s]+/).map(s => s.trim()).filter(s => /^[A-Z][A-Z0-9_-]+/.test(s));
        for (const id of ids) reqIds.add(id);
      }

      if (reqIds.size === 0) continue;
      codeAnnotationFileCount++;

      const relativePath = path.relative(process.cwd(), fullPath);
      const cfKey = `code_file::${relativePath}`;
      ensureNode(nodes, cfKey, 'code_file', relativePath);

      for (const reqId of reqIds) {
        const reqKey = `requirement::${reqId}`;
        ensureNode(nodes, reqKey, 'requirement', reqId);
        addEdge(nodes[cfKey], reqKey, 'declares', 'source-annotation');
        codeAnnotationEdgeCount++;
      }
    }
  }

  if (latestCodeAnnotationMtime) {
    sources['code-source-annotations'] = { mtime: latestCodeAnnotationMtime };
  }
  process.stderr.write('[proximity] Extracted ' + codeAnnotationEdgeCount + ' code-requirement annotations from ' + codeAnnotationFileCount + ' source files\n');

  // Step 13: REVERSE PASS
  const reverseEdges = [];
  for (const [nodeKey, node] of Object.entries(nodes)) {
    for (const edge of node.edges) {
      const reverseRel = REVERSE_RELS[edge.rel];
      if (!reverseRel) continue;
      const targetNode = nodes[edge.to];
      if (!targetNode) continue;
      // Check if reverse already exists
      const hasReverse = targetNode.edges.some(
        e => e.to === nodeKey && e.rel === reverseRel && e.source === edge.source
      );
      if (!hasReverse) {
        reverseEdges.push({ targetKey: edge.to, from: nodeKey, rel: reverseRel, source: edge.source });
      }
    }
  }
  for (const re of reverseEdges) {
    if (nodes[re.targetKey]) {
      addEdge(nodes[re.targetKey], re.from, re.rel, re.source);
    }
  }

  // Step 14: VALIDATE - count orphans
  let orphanCount = 0;
  const orphans = [];
  for (const [key, node] of Object.entries(nodes)) {
    if (node.edges.length === 0) {
      orphanCount++;
      orphans.push(key);
    }
  }

  // Count totals
  const totalNodes = Object.keys(nodes).length;
  let totalEdges = 0;
  for (const node of Object.values(nodes)) {
    totalEdges += node.edges.length;
  }

  const index = {
    schema_version: '1',
    generated: new Date().toISOString(),
    node_key_format: 'type::id',
    sources,
    nodes,
  };

  return { index, totalNodes, totalEdges, orphanCount, orphans, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// TF-IDF keyword similarity (method #5)
// ─────────────────────────────────────────────────────────────────────────────
const _tfidfCache = new Map();

function extractTerms(text) {
  if (!text) return [];
  const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'was', 'one', 'our', 'out', 'with', 'that', 'this', 'from', 'they', 'been', 'have', 'its', 'will', 'would', 'could', 'should', 'each', 'which', 'their', 'there', 'when', 'must', 'shall', 'into', 'also', 'than', 'only', 'such', 'other', 'more', 'some']);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

function tfidfSimilarity(modelPath, reqText) {
  if (!reqText) return 0;

  // Read model file (cached)
  let modelTerms;
  if (_tfidfCache.has(modelPath)) {
    modelTerms = _tfidfCache.get(modelPath);
  } else {
    try {
      const fullPath = path.join(process.cwd(), modelPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      modelTerms = extractTerms(content);
    } catch {
      modelTerms = [];
    }
    _tfidfCache.set(modelPath, modelTerms);
  }
  if (modelTerms.length === 0) return 0;

  const reqTerms = extractTerms(reqText);
  if (reqTerms.length === 0) return 0;

  // Simple TF overlap: count shared unique terms / max unique terms
  const modelSet = new Set(modelTerms);
  const reqSet = new Set(reqTerms);
  let overlap = 0;
  for (const t of reqSet) {
    if (modelSet.has(t)) overlap++;
  }
  // Jaccard similarity
  const union = new Set([...modelSet, ...reqSet]).size;
  return union > 0 ? overlap / union : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding similarity (amplified scoring via sentence-transformer cache)
// Cache is built by `node bin/proximity-embed.mjs` and stored at
// .planning/formal/embedding-cache.json. Loaded lazily on first use.
// ─────────────────────────────────────────────────────────────────────────────
let _embeddingCache = null;
let _embeddingCacheLoaded = false;

function loadEmbeddingCache() {
  if (_embeddingCacheLoaded) return _embeddingCache;
  _embeddingCacheLoaded = true;
  const cachePath = path.join(process.cwd(), '.planning', 'formal', 'embedding-cache.json');
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (data && data.vectors && data.schema_version === '1') {
      _embeddingCache = data;
      process.stderr.write('[proximity] Loaded embedding cache: ' + data.count + ' vectors × ' + data.dim + 'd\n');
    }
  } catch {
    // fail-open: embedding cache is optional
    if (!fs.existsSync(cachePath)) {
      process.stderr.write('[proximity] No embedding cache found. Embedding methods will degrade to graph-only.\n');
      process.stderr.write('[proximity] To build: node bin/proximity-embed.mjs --cache-only\n');
    }
  }
  return _embeddingCache;
}

/**
 * Compute cosine similarity between two nodes using pre-computed embeddings.
 * Returns 0 if either node has no embedding vector.
 * Vectors are pre-normalized, so dot product = cosine similarity.
 */
function embeddingSimilarity(nodeKeyA, nodeKeyB) {
  const cache = loadEmbeddingCache();
  if (!cache) return 0;

  const vecA = cache.vectors[nodeKeyA];
  const vecB = cache.vectors[nodeKeyB];
  if (!vecA || !vecB) return 0;

  let dot = 0;
  for (let i = 0; i < vecA.length; i++) dot += vecA[i] * vecB[i];
  return dot;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category boost (method #4)
// ─────────────────────────────────────────────────────────────────────────────
let _categoryGroupsCache = null;
let _modelCategoryCache = null;

function loadCategoryGroups() {
  if (_categoryGroupsCache !== null) return _categoryGroupsCache;
  try {
    _categoryGroupsCache = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), '.planning', 'formal', 'category-groups.json'), 'utf8'));
  } catch {
    _categoryGroupsCache = {};
  }
  return _categoryGroupsCache;
}

function getModelCategoryGroups(index, modelKey) {
  if (!_modelCategoryCache) _modelCategoryCache = new Map();
  if (_modelCategoryCache.has(modelKey)) return _modelCategoryCache.get(modelKey);

  const cg = loadCategoryGroups();
  const groups = new Set();
  // Find requirements linked to this model via modeled_by edges
  const node = index.nodes[modelKey];
  if (node) {
    for (const edge of node.edges) {
      if (edge.rel === 'models' && edge.to.startsWith('requirement::')) {
        const reqId = edge.to.replace('requirement::', '');
        // Look up requirement category in the requirements data
        // We rely on the requirement node existing; category comes from external data
      }
    }
  }
  _modelCategoryCache.set(modelKey, groups);
  return groups;
}

function categoryBoostScore(index, modelKey, reqKey, reqsData) {
  if (!reqsData) return 1.0; // no data, no boost/penalty
  const cg = loadCategoryGroups();

  // Get model's category groups from its declared requirements
  const modelNode = index.nodes[modelKey];
  const modelGroups = new Set();
  if (modelNode) {
    for (const edge of modelNode.edges) {
      if (edge.rel === 'models' && edge.to.startsWith('requirement::')) {
        const rId = edge.to.replace('requirement::', '');
        const req = reqsData.find(r => r.id === rId);
        if (req && req.category && cg[req.category]) {
          modelGroups.add(cg[req.category]);
        }
      }
    }
  }

  // Get requirement's category group
  const reqId = reqKey.replace('requirement::', '');
  const req = reqsData.find(r => r.id === reqId);
  const reqGroup = req && req.category && cg[req.category] ? cg[req.category] : null;

  if (modelGroups.size === 0 || !reqGroup) return 1.0;
  return modelGroups.has(reqGroup) ? 1.3 : 0.5; // same domain boost / cross-domain penalty
}

// ─────────────────────────────────────────────────────────────────────────────
// Precomputed node degree map for hub dampening
// ─────────────────────────────────────────────────────────────────────────────
let _degreeCache = null;

function getNodeDegree(index, nodeKey) {
  if (!_degreeCache) {
    _degreeCache = new Map();
    for (const [key, node] of Object.entries(index.nodes)) {
      _degreeCache.set(key, (node.edges || []).length);
    }
  }
  return _degreeCache.get(nodeKey) || 0;
}

/**
 * Compute proximity score between two nodes using BFS with configurable scoring method.
 *
 * @param {object} index      - The proximity-index.json object
 * @param {string} nodeKeyA   - Source node key (e.g. "formal_model::path")
 * @param {string} nodeKeyB   - Target node key (e.g. "requirement::REQ-01")
 * @param {number} maxDepth   - Maximum BFS depth (default: 5)
 * @param {object} opts       - { method: string, reqsData: Array, reqText: string }
 *                               method defaults to DEFAULT_SCORING_METHOD
 *                               reqsData needed for category boost
 *                               reqText needed for tfidf
 */
function proximity(index, nodeKeyA, nodeKeyB, maxDepth, opts) {
  if (typeof maxDepth === 'undefined') maxDepth = 5;
  if (nodeKeyA === nodeKeyB) return 1.0;
  if (!index || !index.nodes || !index.nodes[nodeKeyA] || !index.nodes[nodeKeyB]) return 0;

  let config = (opts && opts.methodConfig) ||
    SCORING_METHODS[(opts && opts.method) || DEFAULT_SCORING_METHOD];
  if (!config || !config.weights) config = SCORING_METHODS[DEFAULT_SCORING_METHOD];
  const weights = config.weights;
  const useHubDampen = config.hubDampen;
  const useTfidf = config.tfidf;
  const useCategoryBoost = config.categoryBoost;
  const useEmbedding = config.embedding;

  // BFS collecting paths to B within maxDepth
  let score = 0;
  // Queue entries: [currentNode, depth, pathWeight]
  const queue = [[nodeKeyA, 0, 1.0]];
  const visited = new Map(); // node -> best depth seen

  while (queue.length > 0) {
    const [current, depth, pathWeight] = queue.shift();

    if (depth > maxDepth) continue;

    if (current === nodeKeyB && depth > 0) {
      score += pathWeight * Math.pow(DECAY, depth);
      continue;
    }

    if (visited.has(current) && visited.get(current) <= depth) continue;
    visited.set(current, depth);

    const node = index.nodes[current];
    if (!node) continue;

    for (const edge of node.edges) {
      let edgeWeight = weights[edge.rel] || 0.1;

      // Hub dampening: penalize traversal through high-degree nodes
      if (useHubDampen && edge.to !== nodeKeyB) {
        const targetDegree = getNodeDegree(index, edge.to);
        if (targetDegree > 10) {
          edgeWeight *= 1 / Math.log2(targetDegree + 1);
        }
      }

      const newPathWeight = Math.min(pathWeight, edgeWeight);
      if (depth + 1 <= maxDepth) {
        queue.push([edge.to, depth + 1, newPathWeight]);
      }
    }
  }

  let finalScore = Math.min(score, 1.0);

  // TF-IDF blend: mix graph score with keyword similarity
  if (useTfidf && nodeKeyA.startsWith('formal_model::')) {
    const modelPath = nodeKeyA.replace('formal_model::', '');
    const reqText = (opts && opts.reqText) || '';
    const tfidf = tfidfSimilarity(modelPath, reqText);
    finalScore = 0.6 * finalScore + 0.4 * tfidf;
  }

  // Embedding blend: mix graph score with neural cosine similarity.
  // When graph score is 0 (no path exists), embedding provides the only signal.
  // When graph score > 0, embedding amplifies or dampens based on semantic alignment.
  if (useEmbedding) {
    const embedSim = embeddingSimilarity(nodeKeyA, nodeKeyB);
    if (embedSim > 0) {
      if (finalScore === 0) {
        // No graph path — embedding is the sole signal (scaled to proximity range)
        finalScore = embedSim * 0.5;
      } else {
        // Graph path exists — blend: 60% graph, 40% embedding
        finalScore = 0.6 * finalScore + 0.4 * embedSim;
      }
    }
  }

  // Category boost: multiply by same-domain boost or cross-domain penalty
  if (useCategoryBoost && opts && opts.reqsData) {
    const boost = categoryBoostScore(index, nodeKeyA, nodeKeyB, opts.reqsData);
    finalScore *= boost;
  }

  return Math.min(finalScore, 1.0);
}

/**
 * Count total edges embedded in index nodes.
 * The proximity-index.json has no top-level edges array -- edges are inside each node.
 * @param {object} index - The proximity-index.json object
 * @returns {{ totalEdges: number, byType: Record<string, number> }}
 */
function countEmbeddedEdges(index) {
  let totalEdges = 0;
  const byType = {};
  for (const node of Object.values((index && index.nodes) || {})) {
    const count = (node.edges || []).length;
    totalEdges += count;
    byType[node.type] = (byType[node.type] || 0) + count;
  }
  return { totalEdges, byType };
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const { index, totalNodes, totalEdges, orphanCount, orphans, warnings } = buildIndex();

    // Print warnings to stderr
    for (const w of warnings) {
      process.stderr.write(`[WARN] ${w}\n`);
    }

    // Print orphan warnings to stderr
    for (const o of orphans) {
      process.stderr.write(`[WARN] Orphan node (0 edges): ${o}\n`);
    }

    // Print summary to stderr
    process.stderr.write(`\nProximity Index Summary:\n`);
    process.stderr.write(`  Nodes: ${totalNodes}\n`);
    process.stderr.write(`  Edges: ${totalEdges}\n`);
    process.stderr.write(`  Orphans: ${orphanCount}\n`);
    process.stderr.write(`  Sources: ${Object.keys(index.sources).length}\n`);

    // Node type breakdown
    const typeCounts = {};
    for (const node of Object.values(index.nodes)) {
      typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
    }
    process.stderr.write(`  By type:\n`);
    for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      process.stderr.write(`    ${t}: ${c}\n`);
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(index, null, 2) + '\n');
    } else if (!args.dryRun) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index, null, 2) + '\n');
      process.stderr.write(`\nWritten to: ${OUTPUT_FILE}\n`);
    } else {
      process.stderr.write(`\n[DRY RUN] Would write to: ${OUTPUT_FILE}\n`);
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`[FATAL] ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

/**
 * Parse @requirement annotations from JavaScript source file header (first 30 lines).
 * Returns Set of requirement IDs found.
 * @param {string} content - Full file content
 * @returns {Set<string>} requirement IDs
 */
function parseSourceAnnotations(content) {
  const headerLines = content.split('\n').slice(0, 30).join('\n');
  const reqIds = new Set();
  const annotationRe = /@requirement\s+([A-Z][A-Z0-9_-]+)/g;
  let m;
  while ((m = annotationRe.exec(headerLines)) !== null) {
    reqIds.add(m[1]);
  }
  const headerMatch = headerLines.match(/\/\/\s*Requirements:\s*(.+)/);
  if (headerMatch) {
    const ids = headerMatch[1].split(/[,\s]+/).map(s => s.trim()).filter(s => /^[A-Z][A-Z0-9_-]+/.test(s));
    for (const id of ids) reqIds.add(id);
  }
  return reqIds;
}

module.exports = { buildIndex, proximity, countEmbeddedEdges, parseSourceAnnotations, loadEmbeddingCache, EDGE_WEIGHTS, SEMANTIC_WEIGHTS, REVERSE_RELS, SCORING_METHODS, DEFAULT_SCORING_METHOD, ENSEMBLE_METHODS, AMPLIFIED_ENSEMBLE_METHODS, embeddingSimilarity, tfidfSimilarity };
