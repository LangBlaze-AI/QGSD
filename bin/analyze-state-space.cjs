#!/usr/bin/env node
'use strict';
// bin/analyze-state-space.cjs
// Static analyzer for TLA+ models — estimates state-space size per model,
// classifies risk (MINIMAL/LOW/MODERATE/HIGH), and flags unbounded domains.
//
// Data sources:
//   1. .planning/formal/model-registry.json (model file inventory)
//   2. .planning/formal/tla/*.cfg (TLC model-checking constants)
//   3. .planning/formal/tla/*.tla (VARIABLES + TypeOK domain declarations)
//
// Usage:
//   node bin/analyze-state-space.cjs            # write to .planning/formal/state-space-report.json + summary
//   node bin/analyze-state-space.cjs --json     # print JSON to stdout
//   node bin/analyze-state-space.cjs --quiet    # suppress summary output
//
// Requirements: DECOMP-01, DECOMP-02

const fs   = require('fs');
const path = require('path');

const TAG = '[analyze-state-space]';
let ROOT = process.cwd();

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const REGISTRY_PATH = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
const TLA_DIR       = path.join(ROOT, '.planning', 'formal', 'tla');
const OUTPUT_PATH   = path.join(ROOT, '.planning', 'formal', 'state-space-report.json');

// ── CLI flags ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode  = args.includes('--json');
const quietMode = args.includes('--quiet');

// ── Risk thresholds (configurable) ──────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  MINIMAL: 1000,        // <= 1,000 states
  LOW: 100000,          // <= 100,000 states
  MODERATE: 10000000,   // <= 10,000,000 states
  // > 10,000,000 or unbounded = HIGH
};

// ── Cross-model merge budget (configurable) ─────────────────────────────────
// 5 minutes at ~10,000 states/second = 3,000,000 states threshold

const MERGE_BUDGET = {
  max_tlc_seconds: 300,
  throughput_states_per_sec: 10000,
  max_merged_states: 300 * 10000, // 3,000,000
};

// ── CFG → TLA module mapping ────────────────────────────────────────────────
// Reverse map: cfg base name (without .cfg) → TLA module name
// Needed because cfg naming is inconsistent (MCbreaker vs MCNFQuorum etc.)

const CFG_TO_MODULE = {
  'MCbreaker':             'NFCircuitBreaker',
  'MCoscillation':         'NFOscillation',
  'MCconvergence':         'NFConvergence',
  'MCdeliberation':        'NFDeliberation',
  'MCprefilter':           'NFPreFilter',
  'MCsafety':              'NFQuorum',
  'MCliveness':            'NFQuorum',
  'MCNFQuorum':          'NFQuorum_xstate',
  'MCaccount-manager':     'NFAccountManager',
  'MCMCPEnv':              'NFMCPEnv',
  'MCTUINavigation':       'TUINavigation',
  'MCStopHook':            'NFStopHook',
  'MCrecruiting-safety':   'NFRecruiting',
  'MCrecruiting-liveness': 'NFRecruiting',
};

// ── Parsing Utilities ───────────────────────────────────────────────────────

/**
 * Parse a TLA+ .cfg file. Extracts CONSTANTS, INVARIANT count, PROPERTY count.
 * @param {string} cfgPath — absolute path to .cfg file
 * @returns {{ constants: Array, invariant_count: number, property_count: number }}
 */
function parseCfg(cfgPath) {
  const constants = [];
  let invariantCount = 0;
  let propertyCount = 0;

  let content;
  try {
    content = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    process.stderr.write(TAG + ' warn: cannot read ' + cfgPath + ': ' + err.message + '\n');
    return { constants, invariant_count: invariantCount, property_count: propertyCount };
  }

  const lines = content.split('\n');
  let inConstants = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\\?\*.*$/, '').trim(); // strip TLA+ comments
    if (!line) continue;

    // Detect section keywords
    if (/^CONSTANTS?\b/i.test(line)) {
      inConstants = true;
      // Check for inline constant on same line: CONSTANTS\n or CONSTANTS Foo = 1
      const inlinePart = line.replace(/^CONSTANTS?\s*/i, '').trim();
      if (inlinePart) {
        parseConstantLine(inlinePart, constants);
      }
      continue;
    }

    // End of CONSTANTS block when we hit another section keyword
    if (/^(SPECIFICATION|INVARIANTS?|PROPERT(Y|IES)|CHECK_DEADLOCK|SYMMETRY|CONSTRAINT)\b/i.test(line)) {
      inConstants = false;
    }

    if (inConstants) {
      parseConstantLine(line, constants);
      continue;
    }

    if (/^INVARIANTS?\b/i.test(line)) {
      // Inline invariant on same line
      const inlinePart = line.replace(/^INVARIANTS?\s*/i, '').trim();
      if (inlinePart) invariantCount++;
      continue;
    }
    if (/^PROPERT(Y|IES)\b/i.test(line)) {
      const inlinePart = line.replace(/^PROPERT(Y|IES)\s*/i, '').trim();
      if (inlinePart) propertyCount++;
      continue;
    }

    // Lines after INVARIANT/PROPERTY keywords (multi-line format)
    // Actually, TLC cfg uses one-per-line for INVARIANT entries
    // We count each non-keyword, non-blank line in the right context
    // For simplicity, let's just count the keywords themselves
  }

  // Recount invariants and properties more carefully — each INVARIANT/PROPERTY line
  const allLines = content.split('\n');
  invariantCount = 0;
  propertyCount = 0;
  for (const rawLine of allLines) {
    const trimmed = rawLine.replace(/\\?\*.*$/, '').trim();
    if (/^INVARIANTS?\s+\S/i.test(trimmed)) {
      // Count each invariant name after INVARIANT keyword
      const names = trimmed.replace(/^INVARIANTS?\s+/i, '').trim().split(/\s+/);
      invariantCount += names.filter(n => n).length;
    } else if (/^PROPERT(Y|IES)\s+\S/i.test(trimmed)) {
      const names = trimmed.replace(/^PROPERT(Y|IES)\s+/i, '').trim().split(/\s+/);
      propertyCount += names.filter(n => n).length;
    }
    // Multi-line invariant block (INVARIANTS keyword alone, names below)
    // We handle this below
  }

  // Also handle multi-line INVARIANTS block (keyword on its own line, names below)
  let inInvBlock = false;
  let inPropBlock = false;
  for (const rawLine of allLines) {
    const trimmed = rawLine.replace(/\\?\*.*$/, '').trim();
    if (!trimmed) continue;

    if (/^INVARIANTS?\s*$/i.test(trimmed)) {
      inInvBlock = true;
      continue;
    }
    if (/^PROPERT(Y|IES)\s*$/i.test(trimmed)) {
      inPropBlock = true;
      continue;
    }
    if (/^(SPECIFICATION|CONSTANTS?|CHECK_DEADLOCK|SYMMETRY|CONSTRAINT|INVARIANTS?|PROPERT)\b/i.test(trimmed)) {
      inInvBlock = false;
      inPropBlock = false;
    }

    if (inInvBlock && /^[A-Za-z]/.test(trimmed)) {
      invariantCount++;
    }
    if (inPropBlock && /^[A-Za-z]/.test(trimmed)) {
      propertyCount++;
    }
  }

  return { constants, invariant_count: invariantCount, property_count: propertyCount };
}

/**
 * Parse a single constant assignment line like "MaxDeliberation = 10" or "Agents = {a1, a2}".
 */
function parseConstantLine(line, constants) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) return;

  const name  = trimmed.substring(0, eqIdx).trim();
  const value = trimmed.substring(eqIdx + 1).trim();

  if (!name) return;

  // Model value: a1 = a1 (name equals value exactly)
  if (value === name) {
    constants.push({ name, value, type: 'model_value' });
    return;
  }

  // Set literal: {a1, a2, a3}
  const setMatch = value.match(/^\{([^}]*)\}$/);
  if (setMatch) {
    const members = setMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    constants.push({ name, value: members, type: 'set', cardinality: members.length });
    return;
  }

  // Integer
  const intVal = parseInt(value, 10);
  if (!isNaN(intVal) && String(intVal) === value) {
    constants.push({ name, value: intVal, type: 'integer' });
    return;
  }

  // Fallback — unknown format
  constants.push({ name, value, type: 'unknown' });
}

/**
 * Extract module name from a TLA+ file's MODULE header line.
 * @param {string} tlaContent
 * @returns {string|null}
 */
function extractModuleName(tlaContent) {
  const match = tlaContent.match(/----\s*MODULE\s+(\w+)\s*----/);
  return match ? match[1] : null;
}

/**
 * Extract VARIABLES from a TLA+ file.
 * Returns array of variable names.
 */
function extractVariables(tlaContent) {
  // Find VARIABLES block — may span multiple lines
  const varMatch = tlaContent.match(/\bVARIABLES?\s*\n?([\s\S]*?)(?=\n\s*\n|\nvars\s*==|\n\\?\*\s*──)/);
  if (!varMatch) return [];

  const block = varMatch[1];
  // Variables are comma-separated, may have comments
  const vars = [];
  for (const part of block.split(',')) {
    const name = part.replace(/\\?\*.*$/gm, '').trim().replace(/\s+.*$/, '');
    if (name && /^[a-zA-Z_]\w*$/.test(name)) {
      vars.push(name);
    }
  }
  return vars;
}

/**
 * Parse TypeOK invariant to extract domain for each variable.
 * @param {string} tlaContent
 * @param {string[]} varNames — variable names from VARIABLES block
 * @param {Object[]} constants — parsed constants from .cfg
 * @returns {Object[]} — array of { name, domain, cardinality, bounded }
 */
function parseTypeOK(tlaContent, varNames, constants) {
  // Extract TypeOK block
  const typeOKMatch = tlaContent.match(/TypeOK\s*==\s*\n?([\s\S]*?)(?=\n\s*\n\s*\\?\*|^\s*\n\s*[A-Z])/m);
  if (!typeOKMatch) {
    // No TypeOK — return unknowns for all variables
    return varNames.map(name => ({
      name, domain: 'unknown', cardinality: null, bounded: false,
    }));
  }

  const typeOKBlock = typeOKMatch[1];

  // Build constant value map for resolving ranges
  const constMap = {};
  for (const c of constants) {
    if (c.type === 'integer') constMap[c.name] = c.value;
    if (c.type === 'set') constMap[c.name] = c.cardinality;
  }

  const results = [];

  for (const varName of varNames) {
    // Look for: /\ varName \in <domain>
    // Also handle: /\ varName \in <domain>  \* comment
    const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const domainRegex = new RegExp('/\\\\\\s*' + escapedVar + '\\s*\\\\in\\s+(.+?)(?:\\s*\\\\\\*.*)?$', 'm');
    const match = typeOKBlock.match(domainRegex);

    if (!match) {
      // Try alternative: variable \subseteq
      const subsetRegex = new RegExp('/\\\\\\s*' + escapedVar + '\\s*\\\\subseteq\\s+(.+?)(?:\\s*\\\\\\*.*)?$', 'm');
      const subMatch = typeOKBlock.match(subsetRegex);
      if (subMatch) {
        const domain = subMatch[1].trim();
        // SUBSET = powerset
        const baseCard = resolveCardinality(domain, constMap);
        const card = baseCard !== null ? Math.pow(2, baseCard) : null;
        results.push({
          name: varName,
          domain: 'SUBSET ' + domain,
          cardinality: card,
          bounded: card !== null,
        });
        continue;
      }

      results.push({ name: varName, domain: 'unknown', cardinality: null, bounded: false });
      continue;
    }

    const domainStr = match[1].trim();
    const parsed = parseDomain(domainStr, constMap);
    results.push({ name: varName, ...parsed });
  }

  return results;
}

/**
 * Parse a single domain expression and return { domain, cardinality, bounded }.
 */
function parseDomain(domainStr, constMap) {
  // BOOLEAN
  if (domainStr === 'BOOLEAN' || domainStr === '{TRUE, FALSE}') {
    return { domain: 'BOOLEAN', cardinality: 2, bounded: true };
  }

  // Nat / Int — unbounded
  if (/^Nat\b/.test(domainStr)) {
    return { domain: 'Nat', cardinality: null, bounded: false };
  }
  if (/^Int\b/.test(domainStr)) {
    return { domain: 'Int', cardinality: null, bounded: false };
  }

  // Seq(...) — unbounded
  if (/^Seq\(/.test(domainStr)) {
    return { domain: domainStr, cardinality: null, bounded: false };
  }

  // String set literal: {"A", "B", "C"} or {A, B, C}
  const setMatch = domainStr.match(/^\{([^}]+)\}$/);
  if (setMatch) {
    const members = setMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    return { domain: domainStr, cardinality: members.length, bounded: true };
  }

  // Range: 0..N or -(N)..N
  const rangeMatch = domainStr.match(/^(-?\d+|\(-?\w+\)|-?\w+)\.\.(-?\d+|\(-?\w+\)|-?\w+)$/);
  if (rangeMatch) {
    const lo = resolveValue(rangeMatch[1], constMap);
    const hi = resolveValue(rangeMatch[2], constMap);
    if (lo !== null && hi !== null) {
      const card = hi - lo + 1;
      return { domain: domainStr, cardinality: card > 0 ? card : null, bounded: card > 0 };
    }
    // Cannot resolve — treat as bounded but unknown size
    return { domain: domainStr, cardinality: null, bounded: false };
  }

  // SUBSET <set>
  if (/^SUBSET\s+/.test(domainStr)) {
    const inner = domainStr.replace(/^SUBSET\s+/, '');
    const innerCard = resolveCardinality(inner, constMap);
    if (innerCard !== null) {
      return { domain: domainStr, cardinality: Math.pow(2, innerCard), bounded: true };
    }
    return { domain: domainStr, cardinality: null, bounded: false };
  }

  // Function space: [S -> T]
  const funcMatch = domainStr.match(/^\[(.+)\s*->\s*(.+)\]$/);
  if (funcMatch) {
    const domCard = resolveCardinality(funcMatch[1].trim(), constMap);
    const ranCard = resolveCardinality(funcMatch[2].trim(), constMap);
    if (domCard !== null && ranCard !== null) {
      return { domain: domainStr, cardinality: Math.pow(ranCard, domCard), bounded: true };
    }
    return { domain: domainStr, cardinality: null, bounded: false };
  }

  // Named constant reference (e.g., VoteStates, FilterPhases, FsmStates)
  // These are typically defined as finite sets in the .tla — treat as bounded with unknown card
  if (/^[A-Z]\w*$/.test(domainStr)) {
    const card = resolveCardinality(domainStr, constMap);
    if (card !== null) {
      return { domain: domainStr, cardinality: card, bounded: true };
    }
    // Named constant we can't resolve — optimistic: assume bounded, small
    return { domain: domainStr, cardinality: null, bounded: true };
  }

  // Record type: [type: X, target: Y]
  const recordMatch = domainStr.match(/^\[(.+)\]$/);
  if (recordMatch && recordMatch[1].includes(':')) {
    // Parse fields
    const fields = recordMatch[1].split(',');
    let totalCard = 1;
    let allBounded = true;
    for (const field of fields) {
      const parts = field.split(':');
      if (parts.length >= 2) {
        const fieldDomain = parts.slice(1).join(':').trim();
        const fieldCard = resolveCardinality(fieldDomain, constMap);
        if (fieldCard !== null) {
          totalCard *= fieldCard;
        } else {
          allBounded = false;
        }
      }
    }
    return {
      domain: domainStr,
      cardinality: allBounded ? totalCard : null,
      bounded: allBounded,
    };
  }

  // Union: X \union Y
  if (domainStr.includes('\\union')) {
    const parts = domainStr.split('\\union').map(s => s.trim());
    let totalCard = 0;
    let allResolved = true;
    for (const part of parts) {
      const card = resolveCardinality(part, constMap);
      if (card !== null) {
        totalCard += card;
      } else {
        // Check for singleton like {NoAccount}
        const singletonMatch = part.match(/^\{(\w+)\}$/);
        if (singletonMatch) {
          totalCard += 1;
        } else {
          allResolved = false;
        }
      }
    }
    return {
      domain: domainStr,
      cardinality: allResolved ? totalCard : null,
      bounded: allResolved,
    };
  }

  // Fallback — unknown domain
  return { domain: domainStr, cardinality: null, bounded: false };
}

/**
 * Resolve a value (might be a constant name or literal number).
 */
function resolveValue(expr, constMap) {
  const cleaned = expr.replace(/[()]/g, '').trim();
  // Literal number
  const num = parseInt(cleaned, 10);
  if (!isNaN(num) && String(num) === cleaned) return num;
  // Negative number
  if (/^-\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  // Constant reference
  if (constMap[cleaned] !== undefined) return constMap[cleaned];
  return null;
}

/**
 * Resolve the cardinality of a set expression.
 */
function resolveCardinality(expr, constMap) {
  const trimmed = expr.trim();

  // Known constant cardinality
  if (constMap[trimmed] !== undefined) {
    return typeof constMap[trimmed] === 'number' ? constMap[trimmed] : null;
  }

  // Set literal
  const setMatch = trimmed.match(/^\{([^}]+)\}$/);
  if (setMatch) {
    return setMatch[1].split(',').map(s => s.trim()).filter(Boolean).length;
  }

  // Range N..M
  const rangeMatch = trimmed.match(/^(-?\d+|\w+)\.\.(-?\d+|\w+)$/);
  if (rangeMatch) {
    const lo = resolveValue(rangeMatch[1], constMap);
    const hi = resolveValue(rangeMatch[2], constMap);
    if (lo !== null && hi !== null) return hi - lo + 1;
  }

  // Nat / Int — unbounded
  if (trimmed === 'Nat' || trimmed === 'Int') return null;

  // BOOLEAN
  if (trimmed === 'BOOLEAN' || trimmed === '{TRUE, FALSE}') return 2;

  return null;
}

// ── Cross-Model Decomposition (DECOMP-05) ───────────────────────────────────

/**
 * Extract requirement ID prefixes from a requirements array.
 * E.g., ['DETECT-01', 'DETECT-02', 'CRED-03'] → Set {'DETECT', 'CRED'}
 * @param {string[]|undefined|null} requirements
 * @returns {Set<string>}
 */
function extractRequirementPrefixes(requirements) {
  if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
    return new Set();
  }
  const prefixes = new Set();
  for (const reqId of requirements) {
    if (typeof reqId !== 'string') continue;
    const parts = reqId.split('-');
    if (parts.length >= 2) {
      // Take all parts except the last (numeric suffix)
      prefixes.add(parts.slice(0, -1).join('-'));
    }
  }
  return prefixes;
}

/**
 * Find candidate model pairs that share source files or requirement prefixes.
 * @param {Object} registry — parsed model-registry.json
 * @param {Object} modelAnalyses — analyzed models keyed by path
 * @returns {Array<{model_a: string, model_b: string, shared_source_files: string[], shared_requirement_prefixes: string[], shared_requirements: string[]}>}
 */
function findCandidatePairs(registry, modelAnalyses) {
  const modelKeys = Object.keys(modelAnalyses).sort();
  const pairs = [];

  for (let i = 0; i < modelKeys.length; i++) {
    for (let j = i + 1; j < modelKeys.length; j++) {
      const a = modelKeys[i];
      const b = modelKeys[j];

      const regA = (registry.models || {})[a] || {};
      const regB = (registry.models || {})[b] || {};

      const sourceFilesA = regA.source_files || [];
      const sourceFilesB = regB.source_files || [];
      const reqsA = regA.requirements || [];
      const reqsB = regB.requirements || [];

      // Shared source files
      const sharedSourceFiles = sourceFilesA.filter(function(f) {
        return sourceFilesB.includes(f);
      });

      // Shared requirement prefixes
      const prefixesA = extractRequirementPrefixes(reqsA);
      const prefixesB = extractRequirementPrefixes(reqsB);
      const sharedPrefixes = [];
      for (const p of prefixesA) {
        if (prefixesB.has(p)) sharedPrefixes.push(p);
      }

      // Shared exact requirements
      const sharedRequirements = reqsA.filter(function(r) {
        return reqsB.includes(r);
      });

      if (sharedSourceFiles.length > 0 || sharedPrefixes.length > 0) {
        pairs.push({
          model_a: a,
          model_b: b,
          shared_source_files: sharedSourceFiles,
          shared_requirement_prefixes: sharedPrefixes.sort(),
          shared_requirements: sharedRequirements.sort(),
        });
      }
    }
  }

  return pairs;
}

/**
 * Estimate merged state-space for two models.
 * @param {Object} analysisA — model analysis from analyzeModel
 * @param {Object} analysisB — model analysis from analyzeModel
 * @returns {number|null} — merged state-space estimate, or null if either is unbounded/unresolvable
 */
function estimateMergedStateSpace(analysisA, analysisB) {
  if (analysisA.estimated_states !== null && analysisB.estimated_states !== null) {
    return analysisA.estimated_states * analysisB.estimated_states;
  }
  return null;
}

/**
 * Classify a candidate pair: recommend merge or flag interface-contract.
 * @param {Object} pair — from findCandidatePairs
 * @param {number|null} mergedStates — from estimateMergedStateSpace
 * @param {Object} budget — { max_merged_states }
 * @returns {Object} — extended pair with model_a_states, model_b_states, estimated_merged_states, recommendation, rationale
 */
function classifyPair(pair, mergedStates, budget) {
  let recommendation;
  let rationale;

  if (mergedStates !== null && mergedStates <= budget.max_merged_states) {
    recommendation = 'merge';
    rationale = 'Combined state-space (' + mergedStates + ') is within 5-minute TLC budget (' + budget.max_merged_states + ')';
  } else if (mergedStates !== null) {
    recommendation = 'interface-contract';
    rationale = 'Combined state-space (' + mergedStates + ') exceeds 5-minute TLC budget (' + budget.max_merged_states + ')';
  } else {
    recommendation = 'interface-contract';
    rationale = 'One or both models have unbounded state-space; interface contract required';
  }

  return Object.assign({}, pair, {
    estimated_merged_states: mergedStates,
    recommendation: recommendation,
    rationale: rationale,
  });
}

/**
 * Analyze cross-model relationships: detect pairs, estimate merged state-space,
 * and recommend merge or interface-contract.
 * @param {Object} registry — parsed model-registry.json
 * @param {Object} models — analyzed models (from analyzeModel)
 * @returns {{ budget: Object, pairs: Object[], summary: Object }}
 */
function analyzeCrossModel(registry, models) {
  const pairs = findCandidatePairs(registry, models);

  const classifiedPairs = pairs.map(function(pair) {
    var analysisA = models[pair.model_a];
    var analysisB = models[pair.model_b];
    var mergedStates = estimateMergedStateSpace(analysisA, analysisB);
    return classifyPair(pair, mergedStates, MERGE_BUDGET);
  });

  var mergeRecommended = 0;
  var interfaceContractNeeded = 0;
  for (var k = 0; k < classifiedPairs.length; k++) {
    if (classifiedPairs[k].recommendation === 'merge') mergeRecommended++;
    else interfaceContractNeeded++;
  }

  return {
    budget: {
      max_tlc_seconds: MERGE_BUDGET.max_tlc_seconds,
      throughput_states_per_sec: MERGE_BUDGET.throughput_states_per_sec,
      max_merged_states: MERGE_BUDGET.max_merged_states,
    },
    pairs: classifiedPairs,
    summary: {
      total_pairs_analyzed: classifiedPairs.length,
      merge_recommended: mergeRecommended,
      interface_contract_needed: interfaceContractNeeded,
    },
  };
}

// ── Model Analysis ──────────────────────────────────────────────────────────

/**
 * Build reverse map: TLA module name → cfg file path(s)
 */
function buildModuleToCfgMap() {
  const map = {}; // moduleName -> [cfgPath, ...]

  // Derive the tla dir from the CURRENT ROOT, not the module-load-time TLA_DIR const —
  // analyzeModel() overrides ROOT per call, and the cfg map must follow it (previously
  // it read the stale dir, so a per-call projectRoot only half-worked).
  const TLA_DIR = path.join(ROOT, '.planning', 'formal', 'tla');
  if (!fs.existsSync(TLA_DIR)) return map;

  const cfgFiles = fs.readdirSync(TLA_DIR).filter(f => f.endsWith('.cfg'));

  for (const cfgFile of cfgFiles) {
    const baseName = cfgFile.replace('.cfg', '');
    // Static map first; fall back to deriving the module for FSM-transpiled MC* cfgs
    // (68 exist, only ~13 are hand-listed). Without this the derived cfg is dropped,
    // its CONSTANTS never link, and 0..MaxN domains read as unbounded → HIGH → the
    // state-space guard falsely blocks every transpiled model (the 46 "crash" failures).
    const moduleName = CFG_TO_MODULE[baseName] || deriveModuleFromCfg(path.join(TLA_DIR, cfgFile), baseName);

    if (moduleName) {
      if (!map[moduleName]) map[moduleName] = [];
      map[moduleName].push(path.join(TLA_DIR, cfgFile));
    }
  }

  return map;
}

/**
 * Derive the TLA+ module name for a .cfg not in the static CFG_TO_MODULE table.
 * Mirrors check-fsm-models.cjs resolveSpec: (1) the cfg header's `.tla` reference,
 * (2) MC-prefix strip, (3) the cfg basename — each gated on the .tla file existing.
 * Returns null if none resolve (the cfg is then skipped, as before).
 */
function deriveModuleFromCfg(cfgPath, baseName) {
  const TLA_DIR = path.join(ROOT, '.planning', 'formal', 'tla'); // follow current ROOT
  try {
    const header = fs.readFileSync(cfgPath, 'utf8').split('\n').slice(0, 12).join('\n');
    // (a) explicit `Foo.tla` reference in the header
    const m = header.match(/\b([A-Z]\w+)\.tla\b/);
    if (m && m[1] !== baseName && fs.existsSync(path.join(TLA_DIR, m[1] + '.tla'))) return m[1];
    // (b) prose `... for NFConvergenceTest` (module named without the .tla suffix)
    const f = header.match(/\bfor\s+([A-Z]\w+)/);
    if (f && f[1] !== baseName && fs.existsSync(path.join(TLA_DIR, f[1] + '.tla'))) return f[1];
  } catch (_) { /* fall through */ }
  const stripped = baseName.replace(/^MC/, '');
  if (stripped && stripped !== baseName && fs.existsSync(path.join(TLA_DIR, stripped + '.tla'))) return stripped;
  if (fs.existsSync(path.join(TLA_DIR, baseName + '.tla'))) return baseName;
  return null;
}

/**
 * Choose the best .cfg for a module (prefer one with CONSTANTS).
 */
function chooseBestCfg(cfgPaths) {
  if (!cfgPaths || cfgPaths.length === 0) return null;
  if (cfgPaths.length === 1) return cfgPaths[0];

  // Prefer cfg with CONSTANTS
  for (const cfgPath of cfgPaths) {
    try {
      const content = fs.readFileSync(cfgPath, 'utf8');
      if (/^CONSTANTS?\b/im.test(content)) return cfgPath;
    } catch (_) { /* ignore */ }
  }

  return cfgPaths[0];
}

/**
 * Analyze a single TLA+ model by relative path.
 * @internal Used by main() for full registry analysis.
 */
function analyzeModelByPath(tlaRelPath, moduleToCfg) {
  const tlaAbsPath = path.join(ROOT, tlaRelPath);

  let tlaContent;
  try {
    tlaContent = fs.readFileSync(tlaAbsPath, 'utf8');
  } catch (err) {
    process.stderr.write(TAG + ' warn: cannot read ' + tlaRelPath + ': ' + err.message + '\n');
    return {
      module_name: path.basename(tlaRelPath, '.tla'),
      cfg_file: null,
      variables: [],
      constants: [],
      estimated_states: null,
      has_unbounded: false,
      unbounded_domains: [],
      risk_level: 'MODERATE',
      risk_reason: 'Parse error — conservative default',
      invariant_count: 0,
      property_count: 0,
    };
  }

  const moduleName = extractModuleName(tlaContent) || path.basename(tlaRelPath, '.tla');

  // Find cfg
  const cfgPaths = moduleToCfg[moduleName] || [];
  const cfgPath = chooseBestCfg(cfgPaths);
  const cfgRelPath = cfgPath ? path.relative(ROOT, cfgPath) : null;

  // Parse cfg
  let cfgData = { constants: [], invariant_count: 0, property_count: 0 };
  if (cfgPath) {
    cfgData = parseCfg(cfgPath);
  }

  // Filter out model_value constants (symmetry set members)
  const meaningfulConstants = cfgData.constants.filter(c => c.type !== 'model_value');

  // Parse TLA+ variables
  const varNames = extractVariables(tlaContent);

  // Parse TypeOK domains
  const variables = parseTypeOK(tlaContent, varNames, cfgData.constants);

  // Compute state-space estimate
  let estimatedStates = 1;
  let hasUnbounded = false;
  const unboundedDomains = [];

  for (const v of variables) {
    if (!v.bounded) {
      hasUnbounded = true;
      unboundedDomains.push(v.name + ': ' + v.domain);
      estimatedStates = null;
    } else if (v.cardinality !== null && estimatedStates !== null) {
      estimatedStates *= v.cardinality;
    } else if (v.cardinality === null && estimatedStates !== null) {
      // Bounded but unknown cardinality — can't compute total
      // Don't mark as unbounded, but we can't estimate
      estimatedStates = null;
    }
  }

  if (variables.length === 0) {
    estimatedStates = null;
  }

  // Risk classification
  let riskLevel;
  let riskReason;

  if (hasUnbounded) {
    riskLevel = 'HIGH';
    riskReason = 'Unbounded domains: ' + unboundedDomains.join(', ');
  } else if (estimatedStates === null) {
    riskLevel = 'MODERATE';
    riskReason = 'State-space could not be fully estimated (some domains unresolvable)';
  } else if (estimatedStates <= DEFAULT_THRESHOLDS.MINIMAL) {
    riskLevel = 'MINIMAL';
    riskReason = 'Estimated ' + estimatedStates + ' states (<= ' + DEFAULT_THRESHOLDS.MINIMAL + ')';
  } else if (estimatedStates <= DEFAULT_THRESHOLDS.LOW) {
    riskLevel = 'LOW';
    riskReason = 'Estimated ' + estimatedStates + ' states (<= ' + DEFAULT_THRESHOLDS.LOW + ')';
  } else if (estimatedStates <= DEFAULT_THRESHOLDS.MODERATE) {
    riskLevel = 'MODERATE';
    riskReason = 'Estimated ' + estimatedStates + ' states (<= ' + DEFAULT_THRESHOLDS.MODERATE + ')';
  } else {
    riskLevel = 'HIGH';
    riskReason = 'Estimated ' + estimatedStates + ' states (> ' + DEFAULT_THRESHOLDS.MODERATE + ')';
  }

  return {
    module_name: moduleName,
    cfg_file: cfgRelPath,
    variables,
    constants: meaningfulConstants,
    estimated_states: estimatedStates,
    has_unbounded: hasUnbounded,
    unbounded_domains: unboundedDomains,
    risk_level: riskLevel,
    risk_reason: riskReason,
    invariant_count: cfgData.invariant_count,
    property_count: cfgData.property_count,
  };
}

// ── Exported API for programmatic use ────────────────────────────────────────

/**
 * Analyze a single TLA+ model by config name.
 * Used programmatically by run-tlc.cjs and other tools.
 * @param {string} configName - Config name (e.g., 'MCsafety', 'MCliveness')
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Analysis result with { estimated_states, risk_level, risk_reason, has_unbounded }
 */
function analyzeModel(configName, projectRoot) {
  // Fail open on invalid project root — match the conservative defaults used by
  // the parse-error / config-not-found paths rather than throwing to the caller.
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return {
      estimated_states: null,
      risk_level: 'MODERATE',
      risk_reason: 'Invalid project root — conservative default',
      has_unbounded: false,
    };
  }
  // Temporarily override ROOT for this call
  const savedROOT = ROOT;
  ROOT = projectRoot;

  try {
    // Build the module-to-cfg map for this project
    const moduleToCfg = buildModuleToCfgMap();

    // Look up the .cfg file for this config
    const cfgPath = path.join(ROOT, '.planning', 'formal', 'tla', configName + '.cfg');
    if (!fs.existsSync(cfgPath)) {
      return {
        estimated_states: null,
        risk_level: 'MODERATE',
        risk_reason: 'Config file not found: ' + configName + '.cfg',
        has_unbounded: false,
      };
    }

    // Try to find the spec file (reuse run-tlc.cjs logic approximation)
    const tlaDir = path.join(ROOT, '.planning', 'formal', 'tla');
    let specFile = null;

    // Strategy 1: read cfg header for .tla reference
    try {
      const cfgContent = fs.readFileSync(cfgPath, 'utf8');
      const headerLines = cfgContent.split('\n').slice(0, 10).join('\n');
      const refMatch = headerLines.match(/\b([A-Z]\w+)\.tla\b/);
      if (refMatch) {
        const candidate = refMatch[1] + '.tla';
        if (fs.existsSync(path.join(tlaDir, candidate))) {
          specFile = candidate;
        }
      }
      if (!specFile) {
        const forMatch = headerLines.match(/\bfor\s+([A-Z]\w+)/);
        if (forMatch) {
          const candidate = forMatch[1] + '.tla';
          if (fs.existsSync(path.join(tlaDir, candidate))) {
            specFile = candidate;
          }
        }
      }
    } catch (_) { /* fall through */ }

    // Strategy 3: MC-prefix strip (MCFoo → Foo.tla) — consistent with the cfg-map
    // derivation, so a transpiled cfg without a header .tla ref resolves its own spec
    // instead of falling through to the wrong NFQuorum.tla default.
    if (!specFile) {
      const stripped = configName.replace(/^MC/, '');
      if (stripped && stripped !== configName && fs.existsSync(path.join(tlaDir, stripped + '.tla'))) {
        specFile = stripped + '.tla';
      }
    }

    // Fallback
    if (!specFile) {
      specFile = 'NFQuorum.tla';
    }

    const tlaRelPath = '.planning/formal/tla/' + specFile;

    // Analyze using internal function
    const result = analyzeModelByPath(tlaRelPath, moduleToCfg);

    // Return only the analysis fields needed by run-tlc
    return {
      estimated_states: result.estimated_states,
      risk_level: result.risk_level,
      risk_reason: result.risk_reason,
      has_unbounded: result.has_unbounded,
    };
  } finally {
    // Restore original ROOT
    ROOT = savedROOT;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  // Load model registry
  if (!fs.existsSync(REGISTRY_PATH)) {
    process.stderr.write(TAG + ' FATAL: model-registry.json not found at ' + REGISTRY_PATH + '\n');
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  // Find TLA+ models (filter out TTrace files and non-local paths)
  const tlaModels = Object.keys(registry.models || {}).filter(key => {
    return key.endsWith('.tla')
      && !key.includes('_TTrace_')
      && key.startsWith('.planning/formal/tla/')
      && !key.startsWith('../../../../');  // skip test paths
  });

  // Build cfg lookup
  const moduleToCfg = buildModuleToCfgMap();

  // Analyze each model
  const models = {};
  for (const tlaRelPath of tlaModels) {
    try {
      models[tlaRelPath] = analyzeModelByPath(tlaRelPath, moduleToCfg);
    } catch (err) {
      process.stderr.write(TAG + ' warn: error analyzing ' + tlaRelPath + ': ' + err.message + '\n');
      models[tlaRelPath] = {
        module_name: path.basename(tlaRelPath, '.tla'),
        cfg_file: null,
        variables: [],
        constants: [],
        estimated_states: null,
        has_unbounded: false,
        unbounded_domains: [],
        risk_level: 'MODERATE',
        risk_reason: 'Analysis error — conservative default',
        invariant_count: 0,
        property_count: 0,
      };
    }
  }

  // Build summary
  const byRisk = { MINIMAL: 0, LOW: 0, MODERATE: 0, HIGH: 0 };
  let unboundedCount = 0;
  let modelsWithoutCfg = 0;

  for (const m of Object.values(models)) {
    byRisk[m.risk_level] = (byRisk[m.risk_level] || 0) + 1;
    if (m.has_unbounded) unboundedCount++;
    if (!m.cfg_file) modelsWithoutCfg++;
  }

  // Cross-model decomposition analysis (DECOMP-05)
  const crossModel = analyzeCrossModel(registry, models);

  const report = {
    metadata: {
      generated_at: new Date().toISOString(),
      generator: 'analyze-state-space',
      version: '1.0',
      thresholds: { ...DEFAULT_THRESHOLDS },
    },
    models,
    summary: {
      total_models: tlaModels.length,
      by_risk: byRisk,
      unbounded_count: unboundedCount,
      models_without_cfg: modelsWithoutCfg,
    },
    cross_model: crossModel,
  };

  const jsonStr = JSON.stringify(report, null, 2);

  if (jsonMode) {
    process.stdout.write(jsonStr + '\n');
    return;
  }

  // Write to file
  fs.writeFileSync(OUTPUT_PATH, jsonStr + '\n', 'utf8');

  if (!quietMode) {
    process.stdout.write(TAG + ' Analyzed ' + tlaModels.length + ' TLA+ models\n');
    process.stdout.write(TAG + '   MINIMAL: ' + byRisk.MINIMAL + '  LOW: ' + byRisk.LOW + '  MODERATE: ' + byRisk.MODERATE + '  HIGH: ' + byRisk.HIGH + '\n');
    process.stdout.write(TAG + '   Unbounded domains: ' + unboundedCount + ' model(s)\n');
    process.stdout.write(TAG + '   Models without .cfg: ' + modelsWithoutCfg + '\n');
    process.stdout.write(TAG + '   Cross-model pairs: ' + crossModel.summary.total_pairs_analyzed + ' (merge: ' + crossModel.summary.merge_recommended + ', interface-contract: ' + crossModel.summary.interface_contract_needed + ')\n');
    process.stdout.write(TAG + ' Report: .planning/formal/state-space-report.json\n');
  }
}

// Only run main if invoked as CLI
if (require.main === module) {
  main();
}

// Export for use as a module
module.exports = { analyzeModel, CFG_TO_MODULE };
