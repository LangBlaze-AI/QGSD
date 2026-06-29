#!/usr/bin/env node
'use strict';
// bin/analyze-assumptions.cjs
// Assumption-to-instrumentation analysis CLI
// Parses formal models (TLA+, Alloy, PRISM) to extract assumptions/thresholds,
// cross-references against observe handlers and debt ledger,
// outputs a gap report with proposed metrics and instrumentation snippets.

const fs = require('node:fs');
const path = require('node:path');

// ── TLA+ Parser ─────────────────────────────────────────────────────────────

/**
 * Extract assumptions from a TLA+ .tla file
 * Parses ASSUME statements, CONSTANTS declarations
 * @param {string} filePath - Path to .tla file
 * @returns {Array<object>} Array of assumption objects
 */
function extractTlaAssumptions(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      process.stderr.write(`[warn] Skipping empty TLA+ file: ${filePath}\n`);
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const results = [];
    const relFile = filePath;

    // Extract ASSUME statements
    // e.g., ASSUME MaxDeliberation \in Nat /\ MaxDeliberation > 0
    const assumeRe = /^ASSUME\s+(.+)$/gm;
    let m;
    while ((m = assumeRe.exec(content)) !== null) {
      const rawText = m[0].trim();
      const body = m[1].trim();
      // Try to extract the variable name (first identifier)
      const nameMatch = body.match(/^(\w+)/);
      const name = nameMatch ? nameMatch[1] : 'unknown';
      // Try to extract a threshold value
      const valMatch = body.match(/(?:>=?|<=?|=)\s*(\d+)/);
      const value = valMatch ? parseInt(valMatch[1], 10) : null;
      results.push({
        source: 'tla', file: relFile, name, type: 'assume', value, rawText
      });
    }

    // Extract CONSTANTS declarations
    // e.g., CONSTANTS\n    Agents,\n    MaxDeliberation,\n    MaxSize
    // Only grab indented continuation lines (lines starting with whitespace)
    const constantsRe = /^CONSTANTS?\s*\n((?:\s{2,}\S.*\n)*)/gm;
    while ((m = constantsRe.exec(content)) !== null) {
      const block = m[1];
      // Extract identifiers from the block, filtering out comment text
      // Each line typically looks like: "    MaxDeliberation, \* comment"
      const lines = block.split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Remove TLA+ comments (\* ...)
        const noComment = line.split('\\*')[0].trim();
        // Extract identifiers (comma-separated)
        const ids = noComment.split(/[,\s]+/).filter(id => /^[A-Z]\w*$/.test(id));
        for (const cname of ids) {
          results.push({
            source: 'tla', file: relFile, name: cname, type: 'constant', value: null, rawText: `CONSTANTS ... ${cname}`
          });
        }
      }
    }

    // Extract INVARIANT definitions (name == expression patterns)
    // e.g., TypeOK == ...
    // We look for identifiers that end with a == pattern and contain INVARIANT-like names
    const invariantRe = /^(\w+)\s*==\s*(.+)$/gm;
    while ((m = invariantRe.exec(content)) !== null) {
      const name = m[1];
      // Skip non-invariant definitions (look for common invariant naming patterns)
      if (/(?:Invariant|TypeOK|Safety|Bounded|Met|Valid|Monotone)/i.test(name)) {
        results.push({
          source: 'tla', file: relFile, name, type: 'invariant', value: null, rawText: m[0].trim()
        });
      }
    }

    return results;
  } catch (err) {
    process.stderr.write(`[warn] Failed to parse TLA+ file ${filePath}: ${err.message}\n`);
    return [];
  }
}

/**
 * Extract constant values and invariant names from a TLA+ .cfg file
 * @param {string} filePath - Path to .cfg file
 * @returns {Array<object>} Array of assumption objects
 */
function extractTlaCfgValues(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      process.stderr.write(`[warn] Skipping empty cfg file: ${filePath}\n`);
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const results = [];
    const relFile = filePath;

    // Extract key = value patterns (concrete constant assignments)
    // e.g., MaxDeliberation = 9
    const kvRe = /^\s*(\w+)\s*=\s*(\d+)\s*$/gm;
    let m;
    while ((m = kvRe.exec(content)) !== null) {
      const name = m[1];
      const value = parseInt(m[2], 10);
      // Skip agent assignments like a1 = a1
      if (/^a\d+$/.test(name)) continue;
      results.push({
        source: 'tla', file: relFile, name, type: 'constant', value, rawText: m[0].trim()
      });
    }

    // Extract INVARIANT names
    const invSection = content.match(/^INVARIANT\s+([\s\S]*?)(?=^(?:SPECIFICATION|CONSTANTS|SYMMETRY|PROPERTY|CHECK_DEADLOCK|$))/gm);
    if (invSection) {
      for (const section of invSection) {
        const names = section.replace(/^INVARIANT\s*/, '').trim().split(/\s+/);
        for (const name of names) {
          if (name && /^\w+$/.test(name)) {
            results.push({
              source: 'tla', file: relFile, name, type: 'invariant', value: null, rawText: `INVARIANT ${name}`
            });
          }
        }
      }
    }

    // Extract PROPERTY names
    const propRe = /^PROPERTY\s+(\w+)/gm;
    while ((m = propRe.exec(content)) !== null) {
      results.push({
        source: 'tla', file: relFile, name: m[1], type: 'invariant', value: null, rawText: m[0].trim()
      });
    }

    return results;
  } catch (err) {
    process.stderr.write(`[warn] Failed to parse cfg file ${filePath}: ${err.message}\n`);
    return [];
  }
}

// ── Alloy Parser ────────────────────────────────────────────────────────────

/**
 * Extract assumptions from an Alloy .als file
 * Parses fact blocks, assert blocks, and numeric constraints
 * @param {string} filePath - Path to .als file
 * @returns {Array<object>} Array of assumption objects
 */
function extractAlloyAssumptions(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      process.stderr.write(`[warn] Skipping empty Alloy file: ${filePath}\n`);
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const results = [];
    const relFile = filePath;

    // Extract fact blocks: fact Name { ... }
    const factRe = /fact\s+(\w+)\s*\{([^}]*)\}/gs;
    let m;
    while ((m = factRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2].trim();
      // Try to extract numeric constraint
      const numMatch = body.match(/(?:=|>=?|<=?)\s*(\d+)/);
      const value = numMatch ? parseInt(numMatch[1], 10) : null;
      results.push({
        source: 'alloy', file: relFile, name, type: 'fact', value, rawText: m[0].trim()
      });
    }

    // Extract assert blocks: assert Name { ... }
    const assertRe = /assert\s+(\w+)\s*\{([^}]*)\}/gs;
    while ((m = assertRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2].trim();
      const numMatch = body.match(/(?:>=?|<=?)\s*(\d+)/);
      const value = numMatch ? parseInt(numMatch[1], 10) : null;
      results.push({
        source: 'alloy', file: relFile, name, type: 'assert', value, rawText: m[0].trim()
      });
    }

    // Extract numeric constraints from predicates: pred Name [...] { ... >= N ... }
    const predRe = /pred\s+(\w+)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/gs;
    while ((m = predRe.exec(content)) !== null) {
      const body = m[2].trim();
      const constraints = body.match(/(\w[\w.#]*)\s*(>=?|<=?|=)\s*(\d+)/g);
      if (constraints) {
        for (const constraint of constraints) {
          const parts = constraint.match(/(\w[\w.#]*)\s*(>=?|<=?|=)\s*(\d+)/);
          if (parts) {
            results.push({
              source: 'alloy', file: relFile, name: `${m[1]}_${parts[1]}`,
              type: 'constraint', value: parseInt(parts[3], 10),
              rawText: constraint.trim()
            });
          }
        }
      }
    }

    return results;
  } catch (err) {
    process.stderr.write(`[warn] Failed to parse Alloy file ${filePath}: ${err.message}\n`);
    return [];
  }
}

// ── PRISM Parser ────────────────────────────────────────────────────────────

/**
 * Extract assumptions from a PRISM .pm file
 * Parses const declarations, module variable bounds, transition rate expressions
 * @param {string} filePath - Path to .pm file
 * @returns {Array<object>} Array of assumption objects
 */
function extractPrismAssumptions(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      process.stderr.write(`[warn] Skipping empty PRISM file: ${filePath}\n`);
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const results = [];
    const relFile = filePath;

    // Extract const declarations: const double tp_rate; or const int max_rounds = 9;
    const constRe = /const\s+(?:double|int)\s+(\w+)(?:\s*=\s*([^;]+))?;/g;
    let m;
    while ((m = constRe.exec(content)) !== null) {
      const name = m[1];
      const rawVal = m[2] ? m[2].trim() : null;
      const value = rawVal !== null ? (isNaN(Number(rawVal)) ? rawVal : Number(rawVal)) : null;
      results.push({
        source: 'prism', file: relFile, name, type: 'const', value, rawText: m[0].trim()
      });
    }

    // Extract module variable bounds: s : [0..2] init 0;
    const boundRe = /(\w+)\s*:\s*\[(\d+)\.\.(\d+)\]\s*init\s*(\d+)/g;
    while ((m = boundRe.exec(content)) !== null) {
      results.push({
        source: 'prism', file: relFile, name: m[1], type: 'bound',
        value: `[${m[2]}..${m[3]}]`,
        rawText: m[0].trim()
      });
    }

    // Extract props from paired .props file
    const propsPath = filePath.replace(/\.pm$/, '.props');
    try {
      if (fs.existsSync(propsPath)) {
        const propsContent = fs.readFileSync(propsPath, 'utf8');
        // Extract property thresholds: F<=9, F<=10, P>=0.95, etc.
        const propRe = /([PR])([>=<]+)([\d.]+)\s*\[\s*(?:F([>=<]+)(\d+))?\s*(?:"([^"]+)")?\s*\]/g;
        while ((m = propRe.exec(propsContent)) !== null) {
          const propType = m[1]; // P or R
          const propOp = m[2];
          const propVal = m[3];
          const stepOp = m[4] || null;
          const stepVal = m[5] || null;
          const label = m[6] || null;

          if (stepVal) {
            results.push({
              source: 'prism', file: propsPath, name: label || `step_bound_${stepVal}`,
              type: 'property', value: parseInt(stepVal, 10),
              rawText: m[0].trim()
            });
          }
          if (propVal && propType === 'P' && propOp !== '=?') {
            results.push({
              source: 'prism', file: propsPath,
              name: label ? `prob_${label}` : `prob_threshold_${propVal}`,
              type: 'property', value: parseFloat(propVal),
              rawText: m[0].trim()
            });
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[warn] Failed to parse PRISM props file ${propsPath}: ${err.message}\n`);
    }

    return results;
  } catch (err) {
    process.stderr.write(`[warn] Failed to parse PRISM file ${filePath}: ${err.message}\n`);
    return [];
  }
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan all formal models under a root directory
 * @param {string} root - Root directory (default: process.cwd())
 * @returns {Array<object>} Flat array of all extracted assumptions
 */
function scanAllFormalModels(root) {
  const baseDir = root || process.cwd();
  const formalDir = path.join(baseDir, '.planning', 'formal');

  // Check if .planning/formal/ directory exists
  if (!fs.existsSync(formalDir) || !fs.statSync(formalDir).isDirectory()) {
    process.stderr.write(`[warn] .planning/formal/ directory not found at ${baseDir} — returning empty results\n`);
    return [];
  }

  const results = [];

  // Scan TLA+ files (excluding TTrace files)
  const tlaDir = path.join(formalDir, 'tla');
  if (fs.existsSync(tlaDir)) {
    const tlaFiles = fs.readdirSync(tlaDir).filter(f => f.endsWith('.tla') && !f.includes('_TTrace_'));
    for (const f of tlaFiles) {
      results.push(...extractTlaAssumptions(path.join(tlaDir, f)));
    }
    // Also scan cfg files
    const cfgFiles = fs.readdirSync(tlaDir).filter(f => f.endsWith('.cfg'));
    for (const f of cfgFiles) {
      results.push(...extractTlaCfgValues(path.join(tlaDir, f)));
    }
  }

  // Scan Alloy files
  const alloyDir = path.join(formalDir, 'alloy');
  if (fs.existsSync(alloyDir)) {
    const alsFiles = fs.readdirSync(alloyDir).filter(f => f.endsWith('.als'));
    for (const f of alsFiles) {
      results.push(...extractAlloyAssumptions(path.join(alloyDir, f)));
    }
  }

  // Scan PRISM files
  const prismDir = path.join(formalDir, 'prism');
  if (fs.existsSync(prismDir)) {
    const pmFiles = fs.readdirSync(prismDir).filter(f => f.endsWith('.pm'));
    for (const f of pmFiles) {
      results.push(...extractPrismAssumptions(path.join(prismDir, f)));
    }
  }

  return results;
}

// ── Tier Classification ─────────────────────────────────────────────────────

/**
 * Classify an assumption into a priority tier (1, 2, or 3).
 *
 * Tier 1 (directly monitorable): Numeric constants with concrete values
 *   sourced from .cfg files or PRISM const with numeric value.
 * Tier 2 (indirectly monitorable): Named invariants and assertions
 *   that can be checked via periodic probes.
 * Tier 3 (not runtime-observable): Structural type constraints,
 *   state-space bounds, assumptions without concrete numeric values.
 *
 * @param {object} assumption - Assumption object with type and value fields
 * @returns {number} 1, 2, or 3
 */
function classifyTier(assumption) {
  const { type, value } = assumption;
  const isNumeric = value !== null && value !== undefined && !isNaN(Number(value));
  const tier1Types = ['constant', 'const', 'property', 'constraint'];

  // NOTE: 'constraint' with numeric value is tier 1 because the numeric value
  // represents a cardinality bound that can be monitored at runtime (e.g.,
  // max replicas). Alloy constraints that express relational/structural rules
  // without numeric values fall through to tier 3. This is a deliberate
  // classification choice -- not all constraints are monitorable, only those
  // with numeric thresholds.

  // Tier 1: numeric value AND monitorable type
  if (isNumeric && tier1Types.includes(type)) {
    return 1;
  }

  // Edge case: 'assume' with numeric value is tier 1 (has a monitorable threshold)
  if (type === 'assume' && isNumeric) {
    return 1;
  }

  // Tier 2: invariants, assertions, facts (checkable via periodic probes)
  if (['invariant', 'assert', 'fact'].includes(type)) {
    return 2;
  }

  // Tier 3: everything else
  return 3;
}

// ── Cross-reference ─────────────────────────────────────────────────────────

/**
 * Cross-reference assumptions against debt ledger and observe handlers.
 *
 * Matching strategy (two-tier):
 * 1. Primary: debt entry has formal_ref matching "spec:{file}:{name}"
 * 2. Fallback fuzzy: If formal_ref is null, check if debt entry id or title
 *    contains the assumption name (case-insensitive substring match).
 *    This handles the common case where debt entries exist but weren't linked via formal_ref.
 *
 * Handler matching:
 * - Numeric thresholds -> look for bash/internal handlers that emit gauge/counter
 * - State invariants -> look for internal/bash handlers
 * - If handler type exists but no specific config targets assumption -> partial
 *
 * @param {Array<object>} assumptions - Array of assumption objects
 * @param {object} [options] - { root?: string }
 * @returns {Array<object>} Assumptions with coverage classification
 */
function crossReference(assumptions, options = {}) {
  const root = options.root || process.cwd();

  // Load debt ledger
  let debtEntries = [];
  try {
    const ledgerPath = path.join(root, '.planning', 'formal', 'debt.json');
    const { readDebtLedger } = require('./debt-ledger.cjs');
    const ledger = readDebtLedger(ledgerPath);
    debtEntries = Array.isArray(ledger.debt_entries) ? ledger.debt_entries : [];
  } catch {
    // No debt ledger available
  }

  // Load observe handlers (must require observe-handlers to register them first)
  let handlerTypes = [];
  try {
    require('./observe-handlers.cjs');
    const { listHandlers } = require('./observe-registry.cjs');
    handlerTypes = listHandlers();
  } catch {
    // Observe handlers not available
  }

  return assumptions.map(assumption => {
    let coverage = 'uncovered';
    let matchSource = null;

    // Check debt ledger coverage
    for (const entry of debtEntries) {
      if (!entry || typeof entry !== 'object') continue;
      // Primary match: formal_ref matches spec:{file}:{name}
      if (typeof entry.formal_ref === 'string') {
        const refPattern = `spec:${assumption.file}:${assumption.name}`;
        if (entry.formal_ref === refPattern || entry.formal_ref.includes(assumption.name)) {
          coverage = 'covered';
          matchSource = `debt:${entry.id}`;
          break;
        }
      }
      // Fallback fuzzy match: id or title contains assumption name
      if (!entry.formal_ref || entry.formal_ref === null) {
        const nameLower = assumption.name.toLowerCase();
        const idMatch = entry.id && entry.id.toLowerCase().includes(nameLower);
        const titleMatch = entry.title && entry.title.toLowerCase().includes(nameLower);
        if (idMatch || titleMatch) {
          coverage = 'covered';
          matchSource = `debt:${entry.id}(fuzzy)`;
          break;
        }
      }
    }

    // If not covered by debt, check observe handlers
    if (coverage === 'uncovered' && handlerTypes.length > 0) {
      // Numeric thresholds -> bash/internal handlers
      if (['constant', 'bound', 'property', 'constraint'].includes(assumption.type)) {
        if (handlerTypes.includes('bash') || handlerTypes.includes('internal')) {
          coverage = 'partial';
          matchSource = 'handler:bash/internal(generic)';
        }
      }
      // State invariants -> internal/bash handlers
      if (['invariant', 'assert'].includes(assumption.type)) {
        if (handlerTypes.includes('internal') || handlerTypes.includes('bash')) {
          coverage = 'partial';
          matchSource = 'handler:internal/bash(generic)';
        }
      }
    }

    return { ...assumption, coverage, matchSource };
  });
}

// ── Gap Report ──────────────────────────────────────────────────────────────

/**
 * Generate a gap report with proposed metrics and instrumentation snippets
 * @param {Array<object>} crossRefResults - Assumptions with coverage classification
 * @returns {object} Structured report JSON
 */
function generateGapReport(crossRefResults) {
  const total_assumptions = crossRefResults.length;
  const covered = crossRefResults.filter(a => a.coverage === 'covered').length;
  const partial = crossRefResults.filter(a => a.coverage === 'partial').length;
  const uncovered = crossRefResults.filter(a => a.coverage === 'uncovered').length;

  // Generate metric names with nf_ prefix and collision detection
  const metricNameCounts = new Map();
  const gaps = crossRefResults
    .filter(a => a.coverage !== 'covered')
    .map(a => {
      // Generate canonical metric name: nf_ + lowercase + replace non-alnum with _
      const baseName = 'nf_' + a.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      // Track for collision detection
      const count = metricNameCounts.get(baseName) || 0;
      metricNameCounts.set(baseName, count + 1);

      return { ...a, _baseName: baseName };
    });

  // Apply collision suffix and classify tier
  for (const gap of gaps) {
    const count = metricNameCounts.get(gap._baseName);
    if (count > 1) {
      gap.metric_name = `${gap._baseName}__${gap.source}`;
    } else {
      gap.metric_name = gap._baseName;
    }
    delete gap._baseName;

    // Classify tier
    gap.tier = classifyTier(gap);

    // Determine metric type
    if (['constant', 'bound', 'property'].includes(gap.type)) {
      gap.metric_type = 'gauge';
    } else if (['assume', 'fact', 'constraint'].includes(gap.type)) {
      gap.metric_type = 'gauge';
    } else if (['invariant', 'assert'].includes(gap.type)) {
      gap.metric_type = 'counter';
    } else {
      gap.metric_type = 'gauge';
    }

    // Generate instrumentation snippet
    gap.instrumentation_snippet = generateSnippet(gap);
  }

  // Sort by tier ascending (tier 1 first), preserving original order within same tier
  gaps.sort((a, b) => a.tier - b.tier);

  return {
    total_assumptions,
    covered,
    partial,
    uncovered,
    gaps
  };
}

/**
 * Generate an instrumentation code snippet for an uncovered assumption
 * Uses the observe handler pattern from observe-handlers.cjs
 * @param {object} gap - Gap object with metric_name, metric_type, source, type, name
 * @returns {string} Code snippet
 */
function generateSnippet(gap) {
  const metricName = gap.metric_name;
  const metricType = gap.metric_type;

  // Tier 1: Prometheus gauge/histogram instrumentation snippets
  if (gap.tier === 1) {
    const thresholdVal = gap.value !== null && gap.value !== undefined ? Number(gap.value) : 0;
    // Use histogram for probability-like property thresholds (0 < value < 1)
    if (gap.type === 'property' && thresholdVal > 0 && thresholdVal < 1) {
      return [
        `// Prometheus histogram for ${gap.name} (${gap.source}/${gap.type})`,
        `# HELP ${metricName} Monitors ${gap.name} from ${gap.source} model`,
        `# TYPE ${metricName} histogram`,
        `const ${metricName} = new Histogram({`,
        `  name: '${metricName}',`,
        `  help: 'Monitors ${gap.name} from ${gap.source} model',`,
        `  labelNames: ['model', 'file'],`,
        `  buckets: [0.5, 0.75, 0.9, 0.95, 0.99, 1.0]`,
        `});`,
        `${metricName}.observe({ model: 'formal', file: '${gap.file}' }, ${thresholdVal});`
      ].join('\n');
    }
    // Default tier 1: Prometheus gauge
    return [
      `// Prometheus gauge for ${gap.name} (${gap.source}/${gap.type})`,
      `# HELP ${metricName} Monitors ${gap.name} from ${gap.source} model`,
      `# TYPE ${metricName} gauge`,
      `const ${metricName} = new Gauge({`,
      `  name: '${metricName}',`,
      `  help: 'Monitors ${gap.name} from ${gap.source} model',`,
      `  labelNames: ['model', 'file']`,
      `});`,
      `${metricName}.set({ model: 'formal', file: '${gap.file}' }, ${thresholdVal});`
    ].join('\n');
  }

  // Tier 2/3 (or undefined tier -- defensive default): observe handler JSON format
  if (metricType === 'counter') {
    return [
      `// Observe handler for ${gap.name} (${gap.source}/${gap.type})`,
      `// Add to observe config sources:`,
      `{`,
      `  "type": "internal",`,
      `  "label": "${metricName}",`,
      `  "check": "formal-invariant",`,
      `  "config": {`,
      `    "metric": "${metricName}",`,
      `    "type": "counter",`,
      `    "formal_ref": "spec:${gap.file}:${gap.name}",`,
      `    "description": "Counts violations of ${gap.name}"`,
      `  }`,
      `}`
    ].join('\n');
  }

  const thresholdVal = gap.value !== null && gap.value !== undefined ? JSON.stringify(gap.value) : 'null';
  return [
    `// Observe handler for ${gap.name} (${gap.source}/${gap.type})`,
    `// Add to observe config sources:`,
    `{`,
    `  "type": "bash",`,
    `  "label": "${metricName}",`,
    `  "command": "echo '{\\"value\\": 0, \\"status\\": \\"ok\\"}'",`,
    `  "parser": "json",`,
    `  "config": {`,
    `    "metric": "${metricName}",`,
    `    "type": "${metricType}",`,
    `    "formal_ref": "spec:${gap.file}:${gap.name}",`,
    `    "threshold": ${thresholdVal},`,
    `    "description": "Monitors ${gap.name} from ${gap.source} model"`,
    `  }`,
    `}`
  ].join('\n');
}

/**
 * Generate a markdown gap report
 * @param {object} report - Gap report object from generateGapReport
 * @returns {string} Markdown content
 */
function formatMarkdownReport(report) {
  const lines = [
    '# Assumption-to-Instrumentation Gap Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total assumptions | ${report.total_assumptions} |`,
    `| Covered | ${report.covered} |`,
    `| Partial | ${report.partial} |`,
    `| Uncovered | ${report.uncovered} |`,
    '',
  ];

  if (report.gaps.length === 0) {
    lines.push('All assumptions are covered by debt ledger entries or observe handlers.');
    return lines.join('\n');
  }

  lines.push('## Gaps');
  lines.push('');
  lines.push('| # | Source | Name | Type | Tier | Coverage | Proposed Metric | Metric Type |');
  lines.push('|---|--------|------|------|------|----------|-----------------|-------------|');

  report.gaps.forEach((gap, idx) => {
    lines.push(`| ${idx + 1} | ${gap.source} | ${gap.name} | ${gap.type} | ${gap.tier} | ${gap.coverage} | \`${gap.metric_name}\` | ${gap.metric_type} |`);
  });

  lines.push('');
  lines.push('## Instrumentation Snippets');
  lines.push('');

  for (const gap of report.gaps) {
    lines.push(`### ${gap.metric_name}`);
    lines.push('');
    lines.push('```json');
    lines.push(gap.instrumentation_snippet);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Proposed metrics evidence ───────────────────────────────────────────────

/**
 * Build proposed-metrics.json from gap report.
 * Each entry is a metric that formal models say should exist in the codebase.
 * nf:observe reads this file to surface unimplemented metrics as drifts.
 *
 * @param {object} report - Gap report from generateGapReport
 * @param {string} root - Project root for scanning implemented metrics
 * @returns {object} Proposed metrics evidence
 */
function buildProposedMetrics(report, root) {
  const metrics = report.gaps.map(gap => ({
    metric_name: gap.metric_name,
    metric_type: gap.metric_type,
    tier: gap.tier,
    source_model: gap.file,
    assumption_name: gap.name,
    assumption_type: gap.type,
    coverage: gap.coverage,
    formal_ref: `spec:${gap.file}:${gap.name}`,
    instrumentation_snippet: gap.instrumentation_snippet,
    status: gap.coverage === 'covered' ? 'implemented' : gap.coverage === 'partial' ? 'partial' : 'proposed',
  }));

  return {
    schema_version: '1',
    generated: new Date().toISOString(),
    total_proposed: metrics.length,
    implemented: metrics.filter(m => m.status === 'implemented').length,
    partial: metrics.filter(m => m.status === 'partial').length,
    outstanding: metrics.filter(m => m.status === 'proposed').length,
    metrics,
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const outputArg = args.find(a => a.startsWith('--output='));
  const jsonOnly = args.includes('--json');
  const verbose = args.includes('--verbose');
  const actionable = args.includes('--actionable');

  const root = process.cwd();
  const assumptions = scanAllFormalModels(root);
  let crossRefed = crossReference(assumptions, { root });

  // --actionable: filter to tier 1 assumptions only before gap report generation
  if (actionable) {
    crossRefed = crossRefed.filter(a => classifyTier(a) === 1);
  }

  const report = generateGapReport(crossRefed);

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    // Write markdown report
    const mdPath = outputArg
      ? outputArg.split('=')[1]
      : path.join(root, '.planning', 'formal', 'assumption-gaps.md');

    const mdContent = formatMarkdownReport(report);
    const mdDir = path.dirname(mdPath);
    fs.mkdirSync(mdDir, { recursive: true });
    fs.writeFileSync(mdPath, mdContent);
    process.stderr.write(`[analyze-assumptions] Gap report written to ${mdPath}\n`);

    // Also output JSON to stdout
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  // Always write proposed-metrics.json for nf:observe consumption
  const proposedMetrics = buildProposedMetrics(report, root);
  const pmDir = path.join(root, '.planning', 'formal', 'evidence');
  fs.mkdirSync(pmDir, { recursive: true });
  const pmPath = path.join(pmDir, 'proposed-metrics.json');
  fs.writeFileSync(pmPath, JSON.stringify(proposedMetrics, null, 2) + '\n');
  process.stderr.write(`[analyze-assumptions] Proposed metrics written to ${pmPath}\n`);

  if (verbose) {
    process.stderr.write(`[analyze-assumptions] Total: ${report.total_assumptions}, Covered: ${report.covered}, Partial: ${report.partial}, Uncovered: ${report.uncovered}\n`);
  }

  // Exit code: 0 if no uncovered, 1 if uncovered gaps exist
  process.exitCode = report.uncovered > 0 ? 1 : 0;
}

module.exports = {
  classifyTier,
  extractTlaAssumptions,
  extractTlaCfgValues,
  extractAlloyAssumptions,
  extractPrismAssumptions,
  scanAllFormalModels,
  crossReference,
  generateGapReport,
  formatMarkdownReport,
  buildProposedMetrics
};
