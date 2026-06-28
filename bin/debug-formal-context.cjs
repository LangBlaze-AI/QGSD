#!/usr/bin/env node
'use strict';

/**
 * debug-formal-context.cjs
 *
 * Assembles formal model context for the /nf:debug workflow.
 * Calls formal-scope-scan.cjs (bug-mode matching + model checkers)
 * and model-constrained-fix.cjs (constraint extraction + rendering).
 *
 * CLI usage:
 *   node bin/debug-formal-context.cjs --description "failure description" --format json
 *
 * Module exports:
 *   { assembleFormalContext, formatConstraintBlock, formatVerdictSummary }
 */

const fs = require('fs');
const path = require('path');

// Lazy-load dependencies so tests can override them
let _formalScopeScan;
let _modelConstrainedFix;

function getFormalScopeScan() {
  if (!_formalScopeScan) {
    _formalScopeScan = require('./formal-scope-scan.cjs');
  }
  return _formalScopeScan;
}

function getModelConstrainedFix() {
  if (!_modelConstrainedFix) {
    _modelConstrainedFix = require('./model-constrained-fix.cjs');
  }
  return _modelConstrainedFix;
}

/**
 * Override dependencies for testing.
 */
function _setDeps(fss, mcf) {
  _formalScopeScan = fss;
  _modelConstrainedFix = mcf;
}

/**
 * Assemble formal context for a failure description.
 *
 * @param {string} description - The failure description
 * @param {object} [options] - Options
 * @param {boolean} [options.runCheckers] - Whether to run model checkers (default true)
 * @returns {object} { verdict, constraints, models }
 */
async function assembleFormalContext(description, options) {
  const opts = options || {};
  const runCheckers = opts.runCheckers !== false;

  try {
    const fss = getFormalScopeScan();

    // Step 1: Bug-mode matching
    const matches = fss.runBugModeMatching(description);
    if (!matches || matches.length === 0) {
      return { verdict: 'no-model', constraints: [], models: [] };
    }

    // Step 2: Run model checkers if requested (30s timeout for debug loop speed)
    let checkerResults = [];
    if (runCheckers) {
      checkerResults = fss.runModelCheckers(matches, 3, 30000);
    }

    // Step 3: Determine verdict
    const hasFailure = checkerResults.some(r => r.result === 'fail');
    const verdict = hasFailure ? 'reproduced' : 'not-reproduced';

    // Step 4: Extract constraints from reproducing models
    const constraints = [];
    const mcf = getModelConstrainedFix();

    for (const result of checkerResults) {
      if (result.result !== 'fail') continue;

      // Find the matching model entry to get its path
      const matchEntry = matches.find(m => m.model === result.model);
      if (!matchEntry) continue;

      // Find the spec file
      const specDir = path.join(process.cwd(), '.planning', 'formal', 'spec');
      const specPath = matchEntry.formalism === 'tla'
        ? path.join(specDir, matchEntry.model + '.tla')
        : path.join(specDir, matchEntry.model + '.als');

      let specContent = '';
      try {
        specContent = fs.readFileSync(specPath, 'utf8');
      } catch {
        // Spec file not found — skip constraint extraction
        continue;
      }

      // Extract constraints based on formalism
      let rawConstraints = [];
      if (matchEntry.formalism === 'tla') {
        rawConstraints = mcf.extractTlaConstraints(specContent, specPath);
      } else if (matchEntry.formalism === 'alloy') {
        rawConstraints = mcf.extractAlloyConstraints(specContent, specPath);
      }

      // Render constraints to English
      if (rawConstraints.length > 0) {
        const summary = mcf.renderConstraintSummary(rawConstraints, 3);
        for (const c of summary.constraints) {
          constraints.push({
            text: c.english || c.formal || c.name,
            source_model: result.model,
            formalism: matchEntry.formalism
          });
        }
      }
    }

    // Limit to max 3 constraints, sorted by relevance (already sorted from renderConstraintSummary)
    const limitedConstraints = constraints.slice(0, 3);

    // Build models array
    const models = matches.map(m => {
      const checkerResult = checkerResults.find(r => r.model === m.model);
      return {
        name: m.model,
        reproduced: checkerResult ? checkerResult.result === 'fail' : false
      };
    });

    return { verdict, constraints: limitedConstraints, models };

  } catch (err) {
    // Fail-open: formal context is advisory, never block the debug loop
    process.stderr.write('debug-formal-context: fail-open error: ' + err.message + '\n');
    return { verdict: 'no-model', constraints: [], models: [] };
  }
}

/**
 * Format constraints for injection into worker prompts.
 *
 * @param {Array} constraints - Array of { text, source_model, formalism }
 * @returns {string} Formatted block or empty string
 */
function formatConstraintBlock(constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) return '';

  const limited = constraints.slice(0, 3).filter(c => c && typeof c === 'object');
  const lines = limited.map(c => '- ' + (c.text != null ? c.text : ''));

  return `[FORMAL CONSTRAINTS]
The following constraints were extracted from formal models that cover this failure:
${lines.join('\n')}

These are verified properties of the system. Do NOT propose fixes that violate these constraints.
[END FORMAL CONSTRAINTS]`;
}

/**
 * One-line summary of the formal verdict for the bundle.
 *
 * @param {string} verdict - One of: reproduced, not-reproduced, no-model
 * @param {Array} models - Array of { name, reproduced }
 * @returns {string} One-line summary
 */
function formatVerdictSummary(verdict, models) {
  if (verdict === 'reproduced') {
    const reproducing = (models || []).find(m => m && m.reproduced);
    const name = reproducing ? reproducing.name : 'unknown';
    return 'FORMAL: Bug reproduced by model ' + name;
  }
  if (verdict === 'not-reproduced') {
    const count = (models || []).length;
    return 'FORMAL: ' + count + ' models exist but none reproduced this bug';
  }
  return 'FORMAL: No formal model covers this failure';
}

// ---- CLI Mode ----

function parseArgs(argv) {
  const args = { description: null, format: 'json' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--description' && argv[i + 1]) {
      args.description = argv[++i];
    } else if (argv[i] === '--format' && argv[i + 1]) {
      args.format = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node bin/debug-formal-context.cjs --description "text" [--format json]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.description) {
    console.error('Error: --description is required');
    process.exit(1);
  }

  const result = await assembleFormalContext(args.description, { runCheckers: true });
  if (args.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(0);
}

module.exports = { assembleFormalContext, formatConstraintBlock, formatVerdictSummary, _setDeps };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
