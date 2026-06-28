#!/usr/bin/env node
'use strict';
// bin/extract-annotations.cjs
// Extracts @requirement annotations from formal model files (TLA+, Alloy, PRISM).
// Produces a JSON map: { model_file: [{ property, requirement_ids }] }
//
// Usage:
//   node bin/extract-annotations.cjs              # JSON output to stdout
//   node bin/extract-annotations.cjs --pretty     # pretty-printed JSON
//   node bin/extract-annotations.cjs --summary    # summary counts per file
//   node bin/extract-annotations.cjs --validate   # check for unannotated properties
//
// Requirements: ANNOT-04

const fs   = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────────

let ROOT = process.cwd();

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const REGISTRY_PATH = path.join(ROOT, '.planning', 'formal', 'model-registry.json');

// ── Parsing Logic ────────────────────────────────────────────────────────────

/**
 * Parse @requirement annotations from a TLA+ file.
 * Pattern: \* @requirement REQ-ID
 * Property: Name == (identifier at start of line followed by ==)
 */
function parseTLA(content) {
  if (typeof content !== 'string') return [];
  const lines = content.split('\n');
  const results = [];
  let pendingReqs = [];

  for (const line of lines) {
    // Match annotation: \* @requirement REQ-ID
    const annMatch = line.match(/^\s*\\\*\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    // Match property/action definition: PropertyName == or ActionName(params) ==
    const propMatch = line.match(/^(\w+)\s*(?:\([^)]*\)\s*)?==/);
    if (propMatch && pendingReqs.length > 0) {
      results.push({
        property: propMatch[1],
        requirement_ids: [...pendingReqs]
      });
      pendingReqs = [];
      continue;
    }

    // Non-annotation, non-property line: reset pending only if it's not
    // a comment line (allow comment blocks between annotations and properties)
    if (propMatch && pendingReqs.length === 0) {
      // Property without annotation — tracked for validation
      continue;
    }

    // Reset pending annotations if we hit a non-comment, non-blank line
    // that isn't a property definition (orphan annotations)
    const isComment = /^\s*\\\*/.test(line) || /^\s*\(\*/.test(line) || /^\s*\*/.test(line) || /^\s*\*\)/.test(line);
    const isBlank = /^\s*$/.test(line);
    if (!isComment && !isBlank && !annMatch && !propMatch) {
      pendingReqs = [];
    }
  }

  return results;
}

/**
 * Parse @requirement annotations from an Alloy file.
 * Pattern: -- @requirement REQ-ID
 * Property: assert AssertName { or assert AssertName (on its own line)
 */
function parseAlloy(content) {
  if (typeof content !== 'string') return [];
  const lines = content.split('\n');
  const results = [];
  let pendingReqs = [];

  for (const line of lines) {
    // Match annotation: -- @requirement REQ-ID
    const annMatch = line.match(/^--\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    // Match Alloy construct: assert, fact, pred, fun, sig, one sig, lone sig, abstract sig, check
    const constructMatch = line.match(/^(?:assert|fact|pred|fun|check|(?:one|lone|abstract)\s+sig|sig)\s+(\w+)/);
    if (constructMatch && pendingReqs.length > 0) {
      results.push({
        property: constructMatch[1],
        requirement_ids: [...pendingReqs]
      });
      pendingReqs = [];
      continue;
    }
  }

  return results;
}

/**
 * Parse @requirement annotations from a PRISM .props file.
 * Pattern: // @requirement REQ-ID
 * Property: lines starting with P=?, R{, S=? or other PRISM property keywords
 */
function parsePRISM(content) {
  if (typeof content !== 'string') return [];
  const lines = content.split('\n');
  const results = [];
  let pendingReqs = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Match annotation: // @requirement REQ-ID
    const annMatch = trimmed.match(/^\/\/\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    // Match PRISM property formula lines:
    // P=?, P>0, P>=, Pmin=?, Pmax=?
    // R{"..."}=?, R{...}=?, Rmin=?, Rmax=?
    // S=?, S>0, etc.
    // Also filter=? and multi=?
    const isPrismProp = /^[PSR]/.test(trimmed) && (
      /^P\s*[=<>!]/.test(trimmed) ||
      /^P\s*\[/.test(trimmed) ||
      /^Pmin\s*=/.test(trimmed) ||
      /^Pmax\s*=/.test(trimmed) ||
      /^R\s*\{/.test(trimmed) ||
      /^R\s*[=<>]/.test(trimmed) ||
      /^Rmin\s*=/.test(trimmed) ||
      /^Rmax\s*=/.test(trimmed) ||
      /^S\s*[=<>!]/.test(trimmed) ||
      /^S\s*\[/.test(trimmed)
    );

    if (isPrismProp && pendingReqs.length > 0) {
      results.push({
        property: trimmed,
        requirement_ids: [...pendingReqs]
      });
      pendingReqs = [];
      continue;
    }

    // Comment lines (// ...) don't reset pending
    const isComment = /^\/\//.test(trimmed);
    const isBlank = /^\s*$/.test(trimmed);
    if (!isComment && !isBlank && !isPrismProp) {
      pendingReqs = [];
    }
  }

  return results;
}

/**
 * Get all properties (annotated or not) from a TLA+ file for validation.
 * Uses section-based detection: only definitions in property/invariant/liveness
 * sections are considered properties. Definitions in action/initial/next sections
 * are skipped.
 */
function getAllTLAProperties(content) {
  const lines = content.split('\n');
  const properties = [];
  let pendingReqs = [];
  let inPropertySection = false;

  // Section markers that indicate property/invariant sections
  const propertySectionMarkers = [
    /safety\s*invariant/i, /liveness/i, /invariant/i,
    /temporal\s*safety/i, /key\s*invariant/i, /safety\s*propert/i
  ];
  // Section markers that indicate non-property sections
  const actionSectionMarkers = [
    /actions/i, /initial\s*state/i, /next[\s-]*state/i,
    /specification/i, /full\s*spec/i, /composite\s*actions/i,
    /helper\s*predic/i, /ordering/i, /type\s*helper/i,
    /type\s*invariant/i
  ];

  // Known infrastructure definitions (never properties)
  const infraNames = new Set([
    'vars', 'Init', 'Next', 'Spec', 'N', 'NoAccount', 'NoPending',
    'AccountIds', 'OpTypes', 'FsmStates', 'AllSlots', 'AllSubsTried',
    'CanRecruit', 'VoteStates', 'FilterPhases', 'HaikuVerdicts',
    'AgentSymmetry', 'Slots', 'Outcomes', 'SlotStatuses', 'CallStates',
    'QuorumPhases', 'TypeInvariant', 'CountInState', 'AllSettled',
    'SuccessCount', 'CanStillReachThreshold',
    'AnyCollectVotes', 'AnyDeliberate', 'EnoughResponsive',
    'NoInvalidTransition'
  ]);

  for (const line of lines) {
    // Detect section markers
    const isSectionLine = /^\s*(\\\*|(\(\*))\s*[─━═\-]+/.test(line) ||
                          /^\s*\\\*\s*──/.test(line) ||
                          /^\s*\(\*\s*──/.test(line) ||
                          /^\s*\\\*\s*─── /.test(line);
    if (isSectionLine || /^\s*\(\*/.test(line)) {
      const lineText = line.toLowerCase();
      if (propertySectionMarkers.some(m => m.test(lineText))) {
        inPropertySection = true;
      } else if (actionSectionMarkers.some(m => m.test(lineText))) {
        inPropertySection = false;
      }
    }

    // @requirement annotation always signals a property follows
    const annMatch = line.match(/^\s*\\\*\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    const propMatch = line.match(/^(\w+)\s*==/);
    if (propMatch) {
      const name = propMatch[1];
      if (infraNames.has(name)) {
        pendingReqs = [];
        continue;
      }

      // A definition is a property if:
      // 1. It has @requirement annotations (always a property), OR
      // 2. It's in a property section (invariant/liveness/safety)
      const isProperty = pendingReqs.length > 0 || inPropertySection;
      if (isProperty) {
        properties.push({
          property: name,
          annotated: pendingReqs.length > 0,
          requirement_ids: [...pendingReqs]
        });
      }
      pendingReqs = [];
    } else {
      const isComment = /^\s*\\\*/.test(line) || /^\s*\(\*/.test(line) || /^\s*\*/.test(line);
      const isBlank = /^\s*$/.test(line);
      if (!isComment && !isBlank && !annMatch) {
        pendingReqs = [];
      }
    }
  }

  return properties;
}

/**
 * Get all assertions from an Alloy file for validation.
 */
function getAllAlloyAssertions(content) {
  const lines = content.split('\n');
  const assertions = [];
  let pendingReqs = [];

  for (const line of lines) {
    const annMatch = line.match(/^--\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    const assertMatch = line.match(/^assert\s+(\w+)/);
    if (assertMatch) {
      assertions.push({
        property: assertMatch[1],
        annotated: pendingReqs.length > 0,
        requirement_ids: [...pendingReqs]
      });
      pendingReqs = [];
    } else {
      const isComment = /^--/.test(line.trim());
      const isBlank = /^\s*$/.test(line);
      if (!isComment && !isBlank) {
        pendingReqs = [];
      }
    }
  }

  return assertions;
}

/**
 * Get all PRISM properties from a .props file for validation.
 */
function getAllPRISMProperties(content) {
  const lines = content.split('\n');
  const properties = [];
  let pendingReqs = [];

  for (const line of lines) {
    const trimmed = line.trim();

    const annMatch = trimmed.match(/^\/\/\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    const isPrismProp = /^[PSR]/.test(trimmed) && (
      /^P\s*[=<>!]/.test(trimmed) ||
      /^P\s*\[/.test(trimmed) ||
      /^Pmin\s*=/.test(trimmed) ||
      /^Pmax\s*=/.test(trimmed) ||
      /^R\s*\{/.test(trimmed) ||
      /^R\s*[=<>]/.test(trimmed) ||
      /^Rmin\s*=/.test(trimmed) ||
      /^Rmax\s*=/.test(trimmed) ||
      /^S\s*[=<>!]/.test(trimmed) ||
      /^S\s*\[/.test(trimmed)
    );

    if (isPrismProp) {
      properties.push({
        property: trimmed,
        annotated: pendingReqs.length > 0,
        requirement_ids: [...pendingReqs]
      });
      pendingReqs = [];
    } else {
      const isComment = /^\/\//.test(trimmed);
      const isBlank = /^\s*$/.test(trimmed);
      if (!isComment && !isBlank) {
        pendingReqs = [];
      }
    }
  }

  return properties;
}

// ── Test File Parsing ───────────────────────────────────────────────────────

/**
 * Parse @requirement annotations from a JS test file.
 * Pattern: // @requirement REQ-ID
 * Associates with: test('...', ...) or describe('...', ...) when it appears on the next non-blank line after @requirement
 * Intervening comments or non-blank-non-test lines break the association.
 */
function parseTestFile(content) {
  if (typeof content !== 'string') return [];
  const lines = content.split('\n');
  const results = [];
  let pendingReqs = [];

  // Two-pass: first collect all file-level @requirement annotations,
  // then match them to the first test() call in the file.
  // Also support inline: annotation immediately before test().
  const fileReqs = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const annMatch = trimmed.match(/^\/\/\s*@requirement\s+([\w-]+)/);
    if (annMatch) {
      pendingReqs.push(annMatch[1]);
      continue;
    }

    const testMatch = trimmed.match(/^(?:test|describe)\s*\(\s*['"]([^'"]+)['"]/);
    if (testMatch) {
      if (pendingReqs.length > 0) {
        results.push({
          test_name: testMatch[1],
          requirement_ids: [...pendingReqs]
        });
      }
      pendingReqs = [];
      continue;
    }

    // Intervening non-comment, non-blank line breaks the association
    const isComment = /^\/\//.test(trimmed);
    const isBlank = trimmed === '';
    if (!isComment && !isBlank) {
      pendingReqs = [];
    }
  }

  return results;
}

/**
 * Get all test files to scan.
 * Scans hooks/*.test.js and bin/*.test.cjs
 */
function getTestFiles() {
  const testFiles = [];
  const hooksPath = path.join(ROOT, 'hooks');
  const binPath = path.join(ROOT, 'bin');

  if (fs.existsSync(hooksPath)) {
    try {
      const hooksFiles = fs.readdirSync(hooksPath);
      for (const file of hooksFiles) {
        if (file.endsWith('.test.js')) {
          testFiles.push('hooks/' + file);
        }
      }
      // Scan generated-stubs in .planning/formal/
      const stubsPath = path.join(ROOT, '.planning', 'formal', 'generated-stubs');
      if (fs.existsSync(stubsPath)) {
        const stubFiles = fs.readdirSync(stubsPath);
        for (const file of stubFiles) {
          if (file.endsWith('.test.js')) {
            testFiles.push('.planning/formal/generated-stubs/' + file);
          }
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  if (fs.existsSync(binPath)) {
    try {
      const binFiles = fs.readdirSync(binPath);
      for (const file of binFiles) {
        if (file.endsWith('.test.cjs')) {
          testFiles.push('bin/' + file);
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  return testFiles;
}

/**
 * Extract test annotations from all test files.
 * Returns { "test:hooks/config-loader.test.js": [{ test_name, requirement_ids }], ... }
 */
function extractTestAnnotations() {
  const testFiles = getTestFiles();
  const result = {};

  for (const filePath of testFiles) {
    const absPath = path.resolve(ROOT, filePath);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf8');
    const annotations = parseTestFile(content);

    if (annotations.length > 0) {
      result['test:' + filePath] = annotations;
    }
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function getModelFiles() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const models = Object.keys(registry.models);

  return models.filter(modelPath => {
    // Skip TTrace files
    if (modelPath.includes('_TTrace_')) return false;

    // Skip .pm files (PRISM model definitions — properties are in .props)
    if (modelPath.endsWith('.pm')) return false;

    // Skip paths that traverse outside the project (e.g., test paths)
    if (modelPath.startsWith('..') || modelPath.startsWith('/')) return false;

    // Check file exists on disk
    const absPath = path.join(ROOT, modelPath);
    return fs.existsSync(absPath);
  });
}

function getPropsFiles() {
  // Find .props files that are siblings of .pm files in the registry
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const models = Object.keys(registry.models);
  const propsFiles = [];

  for (const modelPath of models) {
    if (modelPath.endsWith('.pm') && !modelPath.startsWith('..') && !modelPath.startsWith('/')) {
      const propsPath = modelPath.replace(/\.pm$/, '.props');
      const absPropsPath = path.join(ROOT, propsPath);
      if (fs.existsSync(absPropsPath)) {
        propsFiles.push(propsPath);
      }
    }
  }

  return propsFiles;
}

function extractAnnotations() {
  const modelFiles = getModelFiles();
  const propsFiles = getPropsFiles();
  const allFiles = [...modelFiles, ...propsFiles];
  const result = {};

  for (const filePath of allFiles) {
    const absPath = path.join(ROOT, filePath);
    const content = fs.readFileSync(absPath, 'utf8');
    const ext = path.extname(filePath);

    let annotations;
    if (ext === '.tla') {
      annotations = parseTLA(content);
    } else if (ext === '.als') {
      annotations = parseAlloy(content);
    } else if (ext === '.props') {
      annotations = parsePRISM(content);
    } else {
      continue;
    }

    if (annotations.length > 0) {
      result[filePath] = annotations;
    }
  }

  return result;
}

function validate() {
  const modelFiles = getModelFiles();
  const propsFiles = getPropsFiles();
  const allFiles = [...modelFiles, ...propsFiles];

  let totalFiles = 0;
  let totalProperties = 0;
  let totalAnnotated = 0;
  const unannotated = [];

  for (const filePath of allFiles) {
    const absPath = path.join(ROOT, filePath);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf8');
    const ext = path.extname(filePath);

    let allProps;
    if (ext === '.tla') {
      allProps = getAllTLAProperties(content);
    } else if (ext === '.als') {
      allProps = getAllAlloyAssertions(content);
    } else if (ext === '.props') {
      allProps = getAllPRISMProperties(content);
    } else {
      continue;
    }

    totalFiles++;
    totalProperties += allProps.length;
    totalAnnotated += allProps.filter(p => p.annotated).length;

    for (const prop of allProps) {
      if (!prop.annotated) {
        unannotated.push({ file: filePath, property: prop.property });
      }
    }
  }

  const totalUnannotated = unannotated.length;

  console.log(`VALIDATION: ${totalFiles} files scanned, ${totalProperties} properties found, ${totalAnnotated} annotated, ${totalUnannotated} unannotated`);

  if (totalUnannotated > 0) {
    console.log('UNANNOTATED:');
    for (const u of unannotated) {
      console.log(`  ${u.file}: ${u.property} (no @requirement annotation)`);
    }
    console.log('FAIL');
    process.exit(1);
  } else {
    console.log('OK');
    process.exit(0);
  }
}

function summary() {
  const result = extractAnnotations();
  let totalProps = 0;
  let totalReqLinks = 0;

  console.log('File summary:');
  for (const [file, annotations] of Object.entries(result).sort(([a], [b]) => a.localeCompare(b))) {
    const props = annotations.length;
    const links = annotations.reduce((s, a) => s + a.requirement_ids.length, 0);
    totalProps += props;
    totalReqLinks += links;
    console.log(`  ${file}: ${props} properties, ${links} requirement links`);
  }
  console.log(`\nTotal: ${Object.keys(result).length} files, ${totalProps} properties, ${totalReqLinks} requirement links`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--validate')) {
    validate();
  } else if (args.includes('--summary')) {
    summary();
  } else {
    const result = extractAnnotations();
    if (args.includes('--include-tests')) {
      const testAnnotations = extractTestAnnotations();
      Object.assign(result, testAnnotations);
    }
    if (args.includes('--pretty')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result));
    }
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseTLA,
  parseAlloy,
  parsePRISM,
  parseTestFile,
  extractAnnotations,
  extractTestAnnotations,
};
