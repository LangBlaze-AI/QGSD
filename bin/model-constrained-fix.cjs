#!/usr/bin/env node
'use strict';

/**
 * model-constrained-fix.cjs
 *
 * Parses TLA+ and Alloy specs to extract constraint definitions
 * (invariants, state variables, transition predicates, assertions,
 * signature constraints) and renders them as plain-English fix
 * constraint summaries.
 *
 * Usage:
 *   node bin/model-constrained-fix.cjs --spec <path> [--max-constraints N] [--format json|text]
 *
 * Module exports:
 *   { extractTlaConstraints, extractAlloyConstraints, renderConstraintSummary }
 */

const fs = require('fs');
const path = require('path');

// ---- TLA+ Operator Simplification ----

/**
 * Simplify TLA+ formal text to readable English approximations.
 */
function simplifyTla(formal) {
  if (!formal || typeof formal !== 'string') return '';
  let s = formal;
  // Order matters: longer patterns first
  s = s.replace(/\\in/g, 'is in');
  s = s.replace(/=\s*TRUE/g, 'is active');
  s = s.replace(/=\s*FALSE/g, 'is inactive');
  s = s.replace(/\/\\/g, 'AND');
  s = s.replace(/\\\//g, 'OR');
  s = s.replace(/~/g, 'NOT');
  // Primed variables: word' -> word(next state)
  s = s.replace(/(\w+)'/g, '$1(next state)');
  // UNCHANGED
  s = s.replace(/UNCHANGED\s+<<([^>]+)>>/g, '($1 unchanged)');
  s = s.replace(/UNCHANGED\s+(\w+)/g, '($1 unchanged)');
  // Clean up excess whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---- Alloy Operator Simplification ----

/**
 * Simplify Alloy formal text to readable English approximations.
 */
function simplifyAlloy(formal) {
  if (!formal || typeof formal !== 'string') return '';
  let s = formal;
  // Alloy => implies
  s = s.replace(/=>/g, 'implies');
  // some/no/lone as quantifiers (word boundary)
  s = s.replace(/\bsome\b/g, 'there exists');
  s = s.replace(/\bno\b/g, 'there is no');
  s = s.replace(/\blone\b/g, 'at most one');
  // 'in' as membership (but not 'in' inside words)
  s = s.replace(/\bin\b/g, 'is a member of');
  // Clean up excess whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---- Requirement Marker Scanner ----

/**
 * Scan for @requirement markers in text preceding a definition.
 * Looks back up to `lookback` characters before the definition start.
 */
function findRequirementMarkers(fullText, defStart, lookback) {
  lookback = lookback || 200;
  const start = Math.max(0, defStart - lookback);
  const prefix = fullText.substring(start, defStart);
  const markers = [];
  const re = /@requirement\s+(\w+-\d+)/g;
  let m;
  while ((m = re.exec(prefix)) !== null) {
    markers.push(m[1]);
  }
  return markers;
}

// ---- TLA+ Constraint Extraction (CEX-01) ----

/**
 * Extract constraints from a TLA+ spec file.
 * @param {string} specContent - The TLA+ file content
 * @param {string} specPath - Path to the spec file
 * @returns {Array} Array of constraint objects
 */
function extractTlaConstraints(specContent, specPath) {
  if (!specContent || typeof specContent !== 'string') return [];

  const constraints = [];

  // 1. Extract VARIABLES (single line: VARIABLES name1, name2, ...)
  const varsMatch = specContent.match(/VARIABLES\s+([^\n]+)/);
  if (varsMatch) {
    const varsLine = varsMatch[1].trim();
    // Split by commas, extract only valid identifier names
    const varNames = varsLine.split(/\s*,\s*/).map(v => v.trim()).filter(v => v && /^[a-z]\w*$/i.test(v));
    for (const varName of varNames) {
      constraints.push({
        type: 'state_variable',
        name: varName,
        formal: varName,
        requirement_id: null,
        confidence: 0.7,
        spec_path: specPath
      });
    }
  }

  // 2. Extract named definitions (invariants and actions)
  // Strategy: find all "Name ==" positions, then extract body between them.
  // This avoids regex bleeding across definition boundaries.
  const defPositions = [];
  const defPosRegex = /^([A-Z]\w*)\s*==/gm;
  let posMatch;
  while ((posMatch = defPosRegex.exec(specContent)) !== null) {
    defPositions.push({ name: posMatch[1], index: posMatch.index });
  }

  // Also find boundary markers: section headers, end of module, blank lines followed by comments
  const boundaryPositions = [];
  const boundaryRegex = /^(?:\\\*\s*──|====|\n\\\*)/gm;
  let secMatch;
  while ((secMatch = boundaryRegex.exec(specContent)) !== null) {
    boundaryPositions.push(secMatch.index);
  }
  // Also treat double newlines as boundaries (definitions separated by blank lines)
  const dblNewlineRegex = /\n\n/g;
  while ((secMatch = dblNewlineRegex.exec(specContent)) !== null) {
    boundaryPositions.push(secMatch.index);
  }
  boundaryPositions.sort((a, b) => a - b);

  // For each definition, extract body up to next definition or section marker
  for (let di = 0; di < defPositions.length; di++) {
    const def = defPositions[di];
    const defLine = specContent.substring(def.index);
    const eqMatch = defLine.match(/^[A-Z]\w*\s*==\s*/);
    if (!eqMatch) continue;
    const bodyStart = def.index + eqMatch[0].length;

    // Find next boundary
    let bodyEnd = specContent.length;
    // Next definition
    if (di + 1 < defPositions.length) {
      bodyEnd = Math.min(bodyEnd, defPositions[di + 1].index);
    }
    // Next boundary marker (section header, blank line, etc.)
    for (const sm of boundaryPositions) {
      if (sm > bodyStart && sm < bodyEnd) {
        bodyEnd = sm;
      }
    }

    const body = specContent.substring(bodyStart, bodyEnd).trim();
    const name = def.name;
    const defStart = def.index;

    // Skip helper definitions
    if (/^(vars|Next|Spec)$/i.test(name)) continue;

    // Determine type
    const hasPrimed = /\w+'/.test(body);
    const isInvariant = /invariant|TypeOK|Safety|Inv\b|Guarantee|Reachable|Excludes|AlwaysHas/i.test(name);

    let type;
    if (isInvariant && !hasPrimed) {
      type = 'invariant';
    } else if (hasPrimed) {
      type = 'action';
    } else if (name === 'Init') {
      type = 'action';
    } else {
      type = 'invariant';
    }

    const reqMarkers = findRequirementMarkers(specContent, defStart, 200);
    const requirement_id = reqMarkers.length > 0 ? reqMarkers[reqMarkers.length - 1] : null;
    const confidence = requirement_id ? 0.95 : 0.7;

    constraints.push({
      type,
      name,
      formal: body,
      requirement_id,
      confidence,
      spec_path: specPath
    });
  }

  // (position-based extraction above replaces old regex approach)

  return constraints;
}

// ---- Alloy Constraint Extraction (CEX-02) ----

/**
 * Extract constraints from an Alloy spec file.
 * @param {string} specContent - The Alloy file content
 * @param {string} specPath - Path to the spec file
 * @returns {Array} Array of constraint objects
 */
function extractAlloyConstraints(specContent, specPath) {
  if (!specContent || typeof specContent !== 'string') return [];

  const constraints = [];

  // 1. Signature definitions: sig Name { fields }
  // Handle abstract sig, one sig, and plain sig
  const sigRegex = /(?:abstract\s+|one\s+)?sig\s+(\w+)(?:\s+extends\s+\w+)?\s*\{([^}]*)\}/g;
  let match;
  while ((match = sigRegex.exec(specContent)) !== null) {
    const name = match[1];
    const fieldsRaw = match[2].trim();
    const defStart = match.index;

    // Parse fields
    const fields = fieldsRaw
      .split(/\s*,\s*/)
      .map(f => f.trim())
      .filter(f => f.length > 0);

    // Scan for requirement markers
    const reqMarkers = findRequirementMarkers(specContent, defStart, 200);
    // Also check for "-- Requirements: ALY-AM-01" pattern in header comments
    const headerReq = findHeaderRequirements(specContent, defStart);
    const allReqs = [...reqMarkers, ...headerReq];
    const requirement_id = allReqs.length > 0 ? allReqs[allReqs.length - 1] : null;
    const confidence = requirement_id ? 0.95 : 0.7;

    constraints.push({
      type: 'signature',
      name,
      formal: match[0],
      fields,
      requirement_id,
      confidence,
      spec_path: specPath
    });
  }

  // 2. Assertion definitions: assert Name { body }
  const assertRegex = /assert\s+(\w+)\s*\{([^}]*)\}/g;
  while ((match = assertRegex.exec(specContent)) !== null) {
    const name = match[1];
    const body = match[2].trim();
    const defStart = match.index;

    const reqMarkers = findRequirementMarkers(specContent, defStart, 200);
    const requirement_id = reqMarkers.length > 0 ? reqMarkers[reqMarkers.length - 1] : null;
    const confidence = requirement_id ? 0.95 : 0.7;

    constraints.push({
      type: 'assertion',
      name,
      formal: body,
      requirement_id,
      confidence,
      spec_path: specPath
    });
  }

  // 3. Predicate definitions: pred Name [params] { body }
  const predRegex = /pred\s+(\w+)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
  while ((match = predRegex.exec(specContent)) !== null) {
    const name = match[1];
    const params = match[2] ? match[2].trim() : '';
    const body = match[3].trim();
    const defStart = match.index;

    const reqMarkers = findRequirementMarkers(specContent, defStart, 200);
    const headerReq = findHeaderRequirements(specContent, defStart);
    const allReqs = [...reqMarkers, ...headerReq];
    const requirement_id = allReqs.length > 0 ? allReqs[allReqs.length - 1] : null;
    const confidence = requirement_id ? 0.95 : 0.7;

    constraints.push({
      type: 'predicate',
      name,
      formal: body,
      fields: params ? params.split(/\s*,\s*/) : [],
      requirement_id,
      confidence,
      spec_path: specPath
    });
  }

  // 4. Fact blocks: fact Name { body } or fact { body }
  const factRegex = /fact\s*(?:(\w+))?\s*\{([^}]*)\}/g;
  while ((match = factRegex.exec(specContent)) !== null) {
    const name = match[1] || '(anonymous)';
    const body = match[2].trim();
    const defStart = match.index;

    const reqMarkers = findRequirementMarkers(specContent, defStart, 200);
    const requirement_id = reqMarkers.length > 0 ? reqMarkers[reqMarkers.length - 1] : null;
    const confidence = requirement_id ? 0.95 : 0.7;

    constraints.push({
      type: 'fact',
      name,
      formal: body,
      requirement_id,
      confidence,
      spec_path: specPath
    });
  }

  return constraints;
}

/**
 * Scan for "-- Requirements: ID" pattern in header comments.
 */
function findHeaderRequirements(fullText, defStart) {
  const lookback = 300;
  const start = Math.max(0, defStart - lookback);
  const prefix = fullText.substring(start, defStart);
  const markers = [];
  const re = /--\s*Requirements?:\s*(\S+)/g;
  let m;
  while ((m = re.exec(prefix)) !== null) {
    markers.push(m[1]);
  }
  return markers;
}

// ---- Plain-English Rendering (CEX-03) ----

/** Type priority for sorting (lower = higher priority) */
const TYPE_PRIORITY = {
  invariant: 0,
  assertion: 1,
  predicate: 2,
  action: 3,
  fact: 4,
  signature: 5,
  state_variable: 6
};

/**
 * Infer a purpose for a state variable from its name.
 */
function inferVariablePurpose(name) {
  const lower = name.toLowerCase();
  if (/active|enabled|on/.test(lower)) return 'whether the component is active';
  if (/disabled|off/.test(lower)) return 'whether the component is disabled';
  if (/count|num|total/.test(lower)) return 'a numeric counter';
  if (/state|status|phase/.test(lower)) return 'the current state';
  if (/config|setting/.test(lower)) return 'configuration state';
  if (/loaded|ready/.test(lower)) return 'whether loading is complete';
  if (/valid/.test(lower)) return 'validity status';
  if (/merged/.test(lower)) return 'merge status';
  return 'system state';
}

/**
 * Render constraint to English using rule-based templates.
 */
function renderOneConstraint(constraint, formalism) {
  const simplify = formalism === 'tla' ? simplifyTla : simplifyAlloy;
  const simplified = simplify(constraint.formal);
  const reqTag = constraint.requirement_id ? ` [Req: ${constraint.requirement_id}]` : '';

  switch (constraint.type) {
    case 'invariant':
      return `SAFETY: ${constraint.name} requires that ${simplified}.${reqTag}`;
    case 'assertion':
      return `ASSERT: ${constraint.name} verifies that ${simplified}.${reqTag}`;
    case 'predicate':
      return `RULE: ${constraint.name} ensures ${simplified}.${reqTag}`;
    case 'action':
      return `TRANSITION: ${constraint.name} changes state by ${simplified}.`;
    case 'state_variable':
      return `STATE: Variable '${constraint.name}' tracks ${inferVariablePurpose(constraint.name)}.`;
    case 'signature':
      if (constraint.fields && constraint.fields.length > 0) {
        return `STRUCTURE: ${constraint.name} has fields: ${constraint.fields.join(', ')}.${reqTag}`;
      }
      return `STRUCTURE: ${constraint.name} is a type definition.${reqTag}`;
    case 'fact':
      return `CONSTRAINT: ${simplified}.${reqTag}`;
    default:
      return `INFO: ${constraint.name}: ${simplified}.${reqTag}`;
  }
}

/**
 * Render constraints to plain-English summaries.
 * @param {Array} constraints - Extracted constraints
 * @param {number} [maxConstraints=5] - Maximum constraints to return
 * @returns {Object} Summary object
 */
function renderConstraintSummary(constraints, maxConstraints) {
  if (!Array.isArray(constraints)) return { model_path: '', formalism: 'unknown', constraint_count: 0, constraints: [] };
  // `|| 5` coerced a legitimate 0 (falsy) up to 5; default only on null/NaN.
  if (maxConstraints == null || Number.isNaN(maxConstraints)) maxConstraints = 5;

  // Determine formalism from first constraint
  const firstSpec = constraints[0]?.spec_path || '';
  const formalism = firstSpec.endsWith('.tla') ? 'tla' : firstSpec.endsWith('.als') ? 'alloy' : 'unknown';

  // Sort: confidence desc, then type priority asc
  const sorted = [...constraints].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (TYPE_PRIORITY[a.type] || 99) - (TYPE_PRIORITY[b.type] || 99);
  });

  // Limit
  const limited = sorted.slice(0, maxConstraints);

  // Render
  const rendered = limited.map(c => ({
    type: c.type,
    name: c.name,
    english: renderOneConstraint(c, formalism),
    formal: c.formal,
    requirement_id: c.requirement_id,
    confidence: c.confidence
  }));

  return {
    model_path: firstSpec,
    formalism,
    constraint_count: rendered.length,
    constraints: rendered
  };
}

// ---- CLI Interface ----

function parseArgs(argv) {
  const args = { spec: null, maxConstraints: 5, format: 'json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--spec' && argv[i + 1]) {
      args.spec = argv[++i];
    } else if (argv[i] === '--max-constraints' && argv[i + 1]) {
      const mc = parseInt(argv[++i], 10);
      args.maxConstraints = Number.isNaN(mc) ? 5 : mc; // allow an explicit 0

    } else if (argv[i] === '--format' && argv[i + 1]) {
      args.format = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node bin/model-constrained-fix.cjs --spec <path> [--max-constraints N] [--format json|text]');
      console.log('');
      console.log('Options:');
      console.log('  --spec            Path to .tla or .als file (required)');
      console.log('  --max-constraints Max constraints to return (default: 5)');
      console.log('  --format          Output format: json or text (default: json)');
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.spec) {
    console.error('Error: --spec <path> is required');
    console.error('Usage: node bin/model-constrained-fix.cjs --spec <path> [--max-constraints N] [--format json|text]');
    process.exit(1);
  }

  if (!fs.existsSync(args.spec)) {
    console.error('Error: Spec file not found: ' + args.spec);
    process.exit(1);
  }

  const content = fs.readFileSync(args.spec, 'utf-8');
  const ext = path.extname(args.spec).toLowerCase();

  let constraints;
  if (ext === '.tla') {
    constraints = extractTlaConstraints(content, args.spec);
  } else if (ext === '.als') {
    constraints = extractAlloyConstraints(content, args.spec);
  } else {
    console.error('Error: Unsupported file extension. Use .tla or .als');
    process.exit(1);
  }

  const summary = renderConstraintSummary(constraints, args.maxConstraints);

  if (args.format === 'text') {
    console.log('Constraints from: ' + summary.model_path);
    console.log('Formalism: ' + summary.formalism);
    console.log('Count: ' + summary.constraint_count);
    console.log('---');
    for (const c of summary.constraints) {
      console.log(c.english);
    }
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

// Run CLI if invoked directly
if (require.main === module) {
  main();
}

// Module exports for programmatic use
module.exports = { extractTlaConstraints, extractAlloyConstraints, renderConstraintSummary };
