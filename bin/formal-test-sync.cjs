#!/usr/bin/env node
'use strict';
// bin/formal-test-sync.cjs
// Orchestrator: cross-references formal model invariants with unit test coverage.
// Validates formal constants against runtime config, generates test stubs, updates traceability matrix.
//
// Usage:
//   node bin/formal-test-sync.cjs                      # full sync (coverage + constants + stubs + sidecar)
//   node bin/formal-test-sync.cjs --report-only        # read-only (no stub generation, no sidecar write)
//   node bin/formal-test-sync.cjs --dry-run            # show what would be generated (no writes)
//   node bin/formal-test-sync.cjs --json               # JSON output instead of human-readable
//   node bin/formal-test-sync.cjs --stubs-dir=<path>   # override default stubs directory
//
// Requirements: QUICK-139

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TAG = '[formal-test-sync]';
let ROOT = process.cwd();

// Parse --project-root (overrides CWD-based ROOT for cross-repo usage)
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

const EXTRACT_ANNOTATIONS_SCRIPT = path.join(__dirname, 'extract-annotations.cjs');
const CONSTANTS_MAPPING_PATH = path.join(ROOT, '.planning', 'formal', 'constants-mapping.json');
const REQUIREMENTS_PATH = path.join(ROOT, '.planning', 'formal', 'requirements.json');
const CONFIG_LOADER_PATH = path.join(ROOT, 'hooks', 'config-loader.js');
const REPORT_OUTPUT_PATH = path.join(ROOT, '.planning', 'formal', 'formal-test-sync-report.json');
const SIDECAR_OUTPUT_PATH = path.join(ROOT, '.planning', 'formal', 'unit-test-coverage.json');

// ── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const reportOnly = args.includes('--report-only');
const dryRun = args.includes('--dry-run');
const jsonMode = args.includes('--json');
const enrichRecipes = args.includes('--enrich-recipes');
let stubsDir = path.join(ROOT, '.planning', 'formal', 'generated-stubs');

const USAGE = [
  'Usage: node bin/formal-test-sync.cjs [options]',
  '',
  'Cross-reference formal model invariants with unit test coverage, validate',
  'constants, and (by default) generate test stubs + update sidecar files.',
  '',
  'Options:',
  '  --report-only        Read-only analysis. Writes nothing (no stubs, no',
  '                       report, no sidecar).',
  '  --dry-run            Show what stubs WOULD be generated. Writes nothing',
  '                       (no stub files, no report, no sidecar).',
  '  --json               Machine-readable JSON output.',
  '  --stubs-dir=<path>   Override stub output dir (default',
  '                       .planning/formal/generated-stubs/).',
  '  --enrich-recipes     Enrich stub recipes with coderlm test patterns.',
  '  --project-root=<dir> Operate on <dir> instead of the current directory.',
  '  -h, --help           Show this help and exit (no analysis, no writes).',
  '',
  'With no flags, the full sync runs and writes:',
  '  .planning/formal/formal-test-sync-report.json',
  '  .planning/formal/unit-test-coverage.json',
  '  .planning/formal/generated-stubs/*',
].join('\n');

for (const arg of args) {
  if (arg.startsWith('--stubs-dir=')) {
    stubsDir = arg.slice('--stubs-dir='.length);
  }
}

// ── Data Loading ─────────────────────────────────────────────────────────────

/**
 * Load formal annotations from extract-annotations.cjs (without test files).
 * Returns { model_file: [{ property, requirement_ids }] } or {} on failure.
 */
function loadFormalAnnotations() {
  try {
    const result = spawnSync(process.execPath, [EXTRACT_ANNOTATIONS_SCRIPT, '--project-root=' + ROOT], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30000,
    });
    if (result.status !== 0) {
      process.stderr.write(TAG + ' warn: extract-annotations.cjs failed\n');
      return {};
    }
    return JSON.parse(result.stdout);
  } catch (err) {
    process.stderr.write(TAG + ' warn: extract-annotations.cjs error: ' + err.message + '\n');
    return {};
  }
}

/**
 * Load test annotations from extract-annotations.cjs with --include-tests.
 * Filters to only test: prefixed keys and strips the prefix.
 * Returns { "hooks/config-loader.test.js": [{ test_name, requirement_ids }], ... }
 */
function loadTestAnnotations() {
  try {
    const result = spawnSync(process.execPath, [EXTRACT_ANNOTATIONS_SCRIPT, '--include-tests', '--project-root=' + ROOT], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30000,
    });
    if (result.status !== 0) {
      process.stderr.write(TAG + ' warn: extract-annotations --include-tests failed\n');
      return {};
    }
    const allAnnotations = JSON.parse(result.stdout);
    const testAnnotations = {};
    for (const [key, value] of Object.entries(allAnnotations)) {
      if (key.startsWith('test:')) {
        testAnnotations[key.slice('test:'.length)] = value;
      }
    }
    return testAnnotations;
  } catch (err) {
    process.stderr.write(TAG + ' warn: extract-annotations --include-tests error: ' + err.message + '\n');
    return {};
  }
}

/**
 * Load requirements from .planning/formal/requirements.json.
 * Returns array of { id, ... } or [] on failure (fail-open).
 */
function loadRequirements() {
  if (!fs.existsSync(REQUIREMENTS_PATH)) {
    process.stderr.write(TAG + ' warn: requirements.json not found\n');
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(REQUIREMENTS_PATH, 'utf8'));
    return data.requirements || [];
  } catch (err) {
    process.stderr.write(TAG + ' warn: requirements.json parse error: ' + err.message + '\n');
    return [];
  }
}

/**
 * Load constants mapping from .planning/formal/constants-mapping.json.
 * Returns array of { constant, source, config_path, formal_value, ... } or [] on failure.
 */
function loadConstantsMapping() {
  if (!fs.existsSync(CONSTANTS_MAPPING_PATH)) {
    process.stderr.write(TAG + ' warn: constants-mapping.json not found\n');
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(CONSTANTS_MAPPING_PATH, 'utf8'));
    return data.mappings || [];
  } catch (err) {
    process.stderr.write(TAG + ' warn: constants-mapping.json parse error: ' + err.message + '\n');
    return [];
  }
}

/**
 * Load DEFAULT_CONFIG from hooks/config-loader.js.
 * Returns the config object or {} on failure.
 */
function loadDefaultConfig() {
  try {
    const { DEFAULT_CONFIG } = require(CONFIG_LOADER_PATH);
    return DEFAULT_CONFIG || {};
  } catch (err) {
    process.stderr.write(TAG + ' warn: could not load DEFAULT_CONFIG: ' + err.message + '\n');
    return {};
  }
}

// ── Constants Parsing ────────────────────────────────────────────────────────

/**
 * Parse TLA+ .cfg file and extract CONSTANTS block values.
 * Pattern: key = value pairs after CONSTANTS keyword until next section keyword.
 */
function parseTLACfgConstants(content) {
  const lines = content.split('\n');
  const result = {};
  let inConstants = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect CONSTANTS section start
    if (/^CONSTANTS\s*$/.test(trimmed)) {
      inConstants = true;
      continue;
    }

    // Detect section keywords that end CONSTANTS block
    if (inConstants && /^(SPECIFICATION|INVARIANT|PROPERTY|SYMMETRY|CHECK_DEADLOCK)\s*/.test(trimmed)) {
      inConstants = false;
      continue;
    }

    if (inConstants && trimmed.length > 0 && !trimmed.startsWith('\\')) {
      // Match key = value pattern
      const match = trimmed.match(/^\s*(\w+)\s*=\s*(.+)$/);
      if (match) {
        const key = match[1];
        const value = match[2].trim();
        // Try to parse as number
        if (/^\d+$/.test(value)) {
          result[key] = parseInt(value, 10);
        } else {
          result[key] = value;
        }
      }
    }
  }

  return result;
}

/**
 * Parse Alloy file and extract Defaults sig field values.
 * Pattern: one sig Defaults { ... } { ... }
 */
function parseAlloyDefaults(content) {
  const result = {};
  if (typeof content !== 'string') return result;
  // Find Defaults sig constraint block: { defaultX = value, ... }
  const match = content.match(/one\s+sig\s+Defaults\s*\{[^}]*\}\s*\{([^}]*)\}/);
  if (!match) return result;

  const constraintBlock = match[1];
  // Parse field = value pairs (split on newlines, not commas)
  const pairs = constraintBlock.split('\n')
    .filter(line => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--') && !t.startsWith('//');
    });
  for (const pair of pairs) {
    const trimmed = pair.trim();
    const kv = trimmed.match(/^\s*(\w+)\s*=\s*(\S+)\s*$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      // Try to parse as number
      if (/^\d+$/.test(val)) {
        result[key] = parseInt(val, 10);
      } else {
        result[key] = val;
      }
    }
  }

  return result;
}

/**
 * Resolve dot-notation path (e.g., "circuit_breaker.oscillation_depth") against a config object.
 */
function resolveConfigPath(dotPath, config) {
  const parts = dotPath.split('.');
  let current = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Validate formal constants against config defaults.
 * Returns array of { constant, source, formal_value, config_value, config_path, match, intentional_divergence }.
 */
function validateConstants(mappings) {
  const config = loadDefaultConfig();
  const results = [];

  for (const mapping of mappings) {
    const { constant, source, config_path, formal_value, transform, intentional_divergence } = mapping;

    // Skip model-only constants
    if (config_path === null) {
      results.push({
        constant,
        source,
        formal_value,
        config_value: null,
        config_path: null,
        match: null, // N/A
        intentional_divergence: false,
        detail: 'model-only, no runtime config',
      });
      continue;
    }

    // Read source file and parse constants
    const sourcePath = path.join(ROOT, source);
    if (!fs.existsSync(sourcePath)) {
      results.push({
        constant,
        source,
        formal_value,
        config_value: null,
        config_path,
        match: false,
        intentional_divergence: intentional_divergence || false,
        detail: 'source file not found',
      });
      continue;
    }

    const sourceContent = fs.readFileSync(sourcePath, 'utf8');
    let parsedConstants;
    if (source.endsWith('.cfg')) {
      parsedConstants = parseTLACfgConstants(sourceContent);
    } else if (source.endsWith('.als')) {
      parsedConstants = parseAlloyDefaults(sourceContent);
    } else {
      results.push({
        constant,
        source,
        formal_value,
        config_value: null,
        config_path,
        match: false,
        intentional_divergence: intentional_divergence || false,
        detail: 'unsupported source file type',
      });
      continue;
    }

    // Look up the constant in parsed values
    const parsedValue = parsedConstants[constant];
    if (parsedValue === undefined) {
      results.push({
        constant,
        source,
        formal_value,
        config_value: null,
        config_path,
        match: false,
        intentional_divergence: intentional_divergence || false,
        detail: 'constant not found in source file',
      });
      continue;
    }

    // Resolve config path to get runtime value
    let configValue = resolveConfigPath(config_path, config);

    // Apply transform if specified
    let transformedFormalValue = formal_value;
    if (transform) {
      const [from, to] = transform.split(' -> ').map(s => s.trim());
      if (from === String(formal_value)) {
        transformedFormalValue = JSON.parse(to);
      }
    }

    const match = transformedFormalValue === configValue;

    results.push({
      constant,
      source,
      formal_value,
      config_value: configValue,
      config_path,
      match,
      intentional_divergence: intentional_divergence || false,
    });
  }

  return results;
}

// ── Coverage Analysis ────────────────────────────────────────────────────────

/**
 * Build a coverage report: for each requirement, track formal and test coverage.
 * Returns { covered: [...], uncovered: [...], gaps: [...], stats: { ... } }.
 */
function buildCoverageReport(formalAnnotations, testAnnotations, requirements) {
  // Build requirement maps
  const formalCoverageMap = new Map(); // reqId -> Set of { model_file, property }
  const testCoverageMap = new Map(); // reqId -> Set of { test_file, test_name }

  // Process formal annotations
  for (const [modelFile, props] of Object.entries(formalAnnotations)) {
    for (const { property, requirement_ids } of props) {
      for (const reqId of requirement_ids) {
        if (!formalCoverageMap.has(reqId)) {
          formalCoverageMap.set(reqId, []);
        }
        formalCoverageMap.get(reqId).push({ 'model_file': modelFile, property });
      }
    }
  }

  // Process test annotations
  for (const [testFile, tests] of Object.entries(testAnnotations)) {
    for (const { test_name, requirement_ids } of tests) {
      for (const reqId of requirement_ids) {
        if (!testCoverageMap.has(reqId)) {
          testCoverageMap.set(reqId, []);
        }
        testCoverageMap.get(reqId).push({ 'test_file': testFile, test_name });
      }
    }
  }

  const covered = [];
  const uncovered = [];
  const gaps = []; // formal coverage but no test

  for (const req of requirements) {
    const reqId = req.id;
    const hasFormal = formalCoverageMap.has(reqId);
    const hasTest = testCoverageMap.has(reqId);

    const entry = {
      requirement_id: reqId,
      has_formal: hasFormal,
      has_test: hasTest,
      formal_properties: hasFormal ? formalCoverageMap.get(reqId) : [],
      test_cases: hasTest ? testCoverageMap.get(reqId) : [],
    };

    if (hasFormal && hasTest) {
      covered.push(entry);
    } else if (!hasFormal && !hasTest) {
      uncovered.push(entry);
    } else if (hasFormal && !hasTest) {
      entry.gap = true;
      gaps.push(entry);
    }
  }

  const totalReqs = requirements.length;
  const formalCovered = formalCoverageMap.size;
  const testCovered = testCoverageMap.size;
  const bothCovered = covered.length;
  const gapCount = gaps.length;

  return {
    covered,
    uncovered,
    gaps,
    stats: {
      total: totalReqs,
      formal_covered: formalCovered,
      test_covered: testCovered,
      both_covered: bothCovered,
      gap_count: gapCount,
    },
  };
}

// ── Recipe Helpers ────────────────────────────────────────────────────────────

/**
 * Extract property/invariant definition text from a formal model file.
 * Supports TLA+ (.tla), Alloy (.als), and PRISM (.prism/.sm).
 * Returns the extracted text string, or '' on failure (fail-open).
 */
function extractPropertyDefinition(modelFile, propertyName) {
  try {
    if (!fs.existsSync(modelFile)) return '';
    const content = fs.readFileSync(modelFile, 'utf8');

    if (modelFile.endsWith('.tla')) {
      // TLA+: propertyName == <body> until blank line or next definition
      const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('^' + escaped + '\\s*==[\\s\\S]*?(?=\\n\\s*\\n|\\n\\w+\\s*==|$)', 'm');
      const m = content.match(re);
      return m ? m[0].trim() : '';
    }

    if (modelFile.endsWith('.als')) {
      // Alloy: pred propertyName { ... } or assert propertyName { ... }
      const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?:pred|assert|fact)\\s+' + escaped + '\\s*\\{', 'm');
      const m = content.match(re);
      if (!m) return '';
      // Find matching closing brace
      const start = m.index;
      let depth = 0;
      let end = start;
      for (let i = start; i < content.length; i++) {
        if (content[i] === '{') depth++;
        if (content[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      return content.slice(start, end).trim();
    }

    if (modelFile.endsWith('.prism') || modelFile.endsWith('.sm')) {
      // PRISM: look for @requirement comment near P=? or filter lines
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(propertyName) || lines[i].includes('@requirement')) {
          // Capture the property line and surrounding context
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          return lines.slice(start, end).join('\n').trim();
        }
      }
    }

    return '';
  } catch (_err) {
    return '';
  }
}

/**
 * Find source files implementing a requirement by grepping for the requirement ID.
 * Falls back to key terms from requirement text if no direct matches.
 * Returns array of relative file paths, or [] on failure (fail-open).
 */
function findSourceFiles(requirementId, requirementText) {
  try {
    const result = spawnSync('grep', [
      '-rl', requirementId,
      'bin/', 'hooks/', 'commands/',
      '--include=*.cjs', '--include=*.mjs', '--include=*.js', '--include=*.md',
    ], { encoding: 'utf8', cwd: ROOT, timeout: 10000 });

    let files = (result.stdout || '').split('\n').filter(Boolean);
    // Filter out formal model files and test files
    files = files.filter(f =>
      !f.endsWith('.tla') && !f.endsWith('.als') && !f.endsWith('.prism') &&
      !f.endsWith('.sm') && !f.endsWith('.cfg') &&
      !f.includes('.stub.test.js') && !f.includes('.test.js') && !f.includes('.test.cjs')
    );

    if (files.length === 0 && requirementText) {
      // Fallback: try key terms (first 3 significant words >4 chars)
      const words = requirementText.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4);
      const keyTerms = words.slice(0, 3);
      for (const term of keyTerms) {
        const fallback = spawnSync('grep', [
          '-rl', term,
          'bin/', 'hooks/',
          '--include=*.cjs', '--include=*.mjs', '--include=*.js',
        ], { encoding: 'utf8', cwd: ROOT, timeout: 10000 });
        const found = (fallback.stdout || '').split('\n').filter(Boolean);
        files.push(...found);
        if (files.length > 0) break;
      }
      // Deduplicate
      files = [...new Set(files)];
    }

    return files;
  } catch (_err) {
    return [];
  }
}

/**
 * Classify test strategy based on requirement text keywords.
 * Returns 'structural', 'behavioral', or 'constant'.
 */
function classifyTestStrategy(requirementText) {
  const text = (typeof requirementText === 'string' ? requirementText : '').toLowerCase();
  if (/(?:returns|outputs|produces|result|calculates)/.test(text)) return 'behavioral';
  if (/(?:constant|value|equals|match|threshold)/.test(text)) return 'constant';
  // Default and explicit structural keywords
  return 'structural';
}

/**
 * Classify test template based on test strategy, source files, and requirement text.
 * Returns one of: 'source-grep', 'import-and-call', 'config-validate'.
 * Also generates pre-filled boilerplate with placeholder tokens.
 */
function classifyTestTemplate(testStrategy, sourceFiles, requirementText) {
  if (testStrategy === 'behavioral') {
    return {
      template: 'import-and-call',
      boilerplate: "const mod = require(SOURCE);\nconst result = mod.FUNCTION(INPUT);\nassert.strictEqual(result, EXPECTED);",
    };
  }
  if (testStrategy === 'constant') {
    return {
      template: 'config-validate',
      boilerplate: "const { DEFAULT_CONFIG } = require(CONFIG_PATH);\nassert.strictEqual(resolveConfigPath(PATH, DEFAULT_CONFIG), EXPECTED);",
    };
  }
  // Default: source-grep when testStrategy is undefined/null (quorum R3.6 hardening)
  return {
    template: 'source-grep',
    boilerplate: "const content = fs.readFileSync(SOURCE, 'utf8');\nassert.match(content, /PATTERN/);",
  };
}

// ── Stub Generation ──────────────────────────────────────────────────────────

/**
 * Generate test stub files for uncovered invariants (gaps).
 * Each stub is a skeleton test file with a TODO comment and assert.fail().
 * Also generates .stub.recipe.json sidecars with pre-resolved context.
 */
function generateStubs(gaps, formalAnnotations, requirements) {
  const requirementMap = new Map(requirements.map(r => [r.id, r]));
  const stubs = [];

  for (const gap of gaps) {
    const { requirement_id, formal_properties } = gap;
    const property = formal_properties.length > 0 ? formal_properties[0].property : 'unknown';

    const stubFileName = requirement_id + '.stub.test.js';
    const stubFilePath = path.join(stubsDir, stubFileName);

    if (!dryRun) {
      // Create stubs directory if it doesn't exist
      if (!fs.existsSync(stubsDir)) {
        fs.mkdirSync(stubsDir, { recursive: true });
      }

      // Write stub file — but NEVER overwrite an implemented stub.
      // An implemented stub is one that exists and does NOT contain assert.fail('TODO').
      let skipStub = false;
      if (fs.existsSync(stubFilePath)) {
        const existing = fs.readFileSync(stubFilePath, 'utf8');
        if (!existing.includes("assert.fail('TODO")) {
          skipStub = true;
        }
      }
      if (!skipStub) {
        const stubContent = `#!/usr/bin/env node
// @requirement ${requirement_id}
// Auto-generated stub for uncovered invariant: ${property}

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('TODO: implement test for ${requirement_id} — ${property}', () => {
  assert.fail('TODO: implement test for ${requirement_id} — ${property}');
});
`;
        fs.writeFileSync(stubFilePath, stubContent, 'utf8');
      }

      // Write recipe sidecar with pre-resolved context
      const recipeFileName = requirement_id + '.stub.recipe.json';
      const recipeFilePath = path.join(stubsDir, recipeFileName);
      const req = requirementMap.get(requirement_id);
      // NOTE: Only the first formal_property is used for the recipe. Gaps with multiple
      // formal_properties are intentionally reduced to the first entry — this is acceptable
      // because most gaps have a single property, and the recipe is a hint, not exhaustive.
      const modelFile = gap.formal_properties.length > 0 ? gap.formal_properties[0].model_file : '';
      const definition = modelFile ? extractPropertyDefinition(path.join(ROOT, modelFile), property) : '';
      const sourceFiles = findSourceFiles(requirement_id, req ? req.text : '');
      const importHint = sourceFiles.length > 0
        ? "const mod = require('" + path.resolve(ROOT, sourceFiles[0]) + "');"
        : '';
      const testStrategy = classifyTestStrategy(req ? req.text : '');
      const templateClassification = classifyTestTemplate(testStrategy, sourceFiles, req ? req.text : '');

      const recipe = {
        requirement_id,
        requirement_text: req ? req.text : '',
        formal_property: {
          name: property,
          model_file: modelFile,
          definition,
          type: modelFile.endsWith('.tla') ? 'invariant' : modelFile.endsWith('.als') ? 'assertion' : 'property',
        },
        source_files: sourceFiles,
        source_file_absolute: sourceFiles.length > 0 ? path.resolve(ROOT, sourceFiles[0]) : '',
        source_files_absolute: sourceFiles.map(f => path.resolve(ROOT, f)),
        import_hint: importHint,
        test_strategy: testStrategy,
        template: templateClassification.template,
        template_boilerplate: templateClassification.boilerplate,
      };

      fs.writeFileSync(recipeFilePath, JSON.stringify(recipe, null, 2) + '\n', 'utf8');
    }

    stubs.push({
      requirement_id,
      stub_file: stubFilePath,
      recipe_file: path.join(stubsDir, requirement_id + '.stub.recipe.json'),
      property,
    });
  }

  return stubs;
}

// ── Recipe Enrichment ───────────────────────────────────────────────────────

/**
 * Enrich recipe JSON files with observed test patterns from coderlm findTests/peek.
 * For each recipe file with non-empty source_files and no existing assert_patterns:
 * - Query coderlm.findTests() for each source file (max 3)
 * - Peek at each found test file (max 5 per source, 100 lines per peek)
 * - Extract assert/expect/describe/beforeEach patterns
 * - Write observed_test_patterns field back to recipe JSON
 *
 * Idempotency: skip recipes where observed_test_patterns.assert_patterns is already
 * a non-empty array (NOT where test_files.length > 0 — test_files presence alone
 * does not indicate successful pattern extraction).
 *
 * @param {Object} adapter - coderlm adapter instance with findTests() and peek() methods
 * @returns {Promise<{enriched: number, skipped: number, errors: number}>}
 */
async function enrichRecipesWithTestPatterns(adapter) {
  let enriched = 0;
  let skipped = 0;
  let errors = 0;

  if (!fs.existsSync(stubsDir)) {
    process.stderr.write(TAG + ' --enrich-recipes: stubsDir does not exist, skipping\n');
    return { enriched: 0, skipped: 0, errors: 0 };
  }

  try {
    const files = fs.readdirSync(stubsDir);
    const recipeFiles = files.filter(f => f.endsWith('.stub.recipe.json'));

    for (const recipeFile of recipeFiles) {
      try {
        const recipePath = path.join(stubsDir, recipeFile);
        const recipeContent = JSON.parse(fs.readFileSync(recipePath, 'utf8'));

        // Idempotency check: skip if assert_patterns already populated (non-empty array)
        if (
          recipeContent.observed_test_patterns &&
          Array.isArray(recipeContent.observed_test_patterns.assert_patterns) &&
          recipeContent.observed_test_patterns.assert_patterns.length > 0
        ) {
          skipped++;
          continue;
        }

        // Skip recipes with no source files
        const sourceFiles = recipeContent.source_files || [];
        if (sourceFiles.length === 0) {
          skipped++;
          continue;
        }

        // Collect test patterns from source files (max 3)
        const testFiles = [];
        const assertPatterns = [];
        const setupPatterns = [];

        for (let si = 0; si < Math.min(sourceFiles.length, 3); si++) {
          const sourceFile = sourceFiles[si];

          // Skip non-file entries (module names with no path separator or extension)
          if (!sourceFile.includes('/') && !sourceFile.endsWith('.cjs') && !sourceFile.endsWith('.js')) {
            process.stderr.write(TAG + ' --enrich-recipes: skipping non-file source entry: ' + sourceFile + '\n');
            continue;
          }

          // Query findTests for this source file (async)
          const testsResult = await adapter.findTests(sourceFile);
          if (testsResult.error) {
            process.stderr.write(TAG + ' --enrich-recipes: findTests error for ' + sourceFile + ': ' + testsResult.error + '\n');
            continue;
          }

          const foundTests = testsResult.tests || [];
          // Peek at up to 5 test files per source (100 lines each)
          for (let ti = 0; ti < Math.min(foundTests.length, 5); ti++) {
            const testFile = foundTests[ti];
            testFiles.push(testFile);

            // Peek at test file: first 100 lines
            let peekResult = await adapter.peek(testFile, 1, 100);
            if (peekResult.error) {
              process.stderr.write(TAG + ' --enrich-recipes: peek error for ' + testFile + ': ' + peekResult.error + '\n');
              continue;
            }

            const lines = peekResult.lines || [];
            const content100 = lines.join('\n');

            // Extract patterns: assert, expect, describe, beforeEach
            const assertMatches = content100.match(/.*(?:\.assert\.|assert\.|expect\(|describe\(|beforeEach\().*$/gm) || [];
            assertPatterns.push(...assertMatches);

            // If no assert patterns found in first 100 lines, try two-pass strategy
            if (assertPatterns.length === 0) {
              // Pass 1: peek lines 1-30 for setup patterns
              const setupResult = await adapter.peek(testFile, 1, 30);
              if (!setupResult.error && setupResult.lines) {
                const setupContent = setupResult.lines.join('\n');
                const setupMatches = setupContent.match(/.*(?:const|require|import).*$/gm) || [];
                setupPatterns.push(...setupMatches);
              }

              // Pass 2: peek lines 31-150 for assertion patterns
              const assertResult = await adapter.peek(testFile, 31, 150);
              if (!assertResult.error && assertResult.lines) {
                const assertContent = assertResult.lines.join('\n');
                const assertMatches2 = assertContent.match(/.*(?:\.assert\.|assert\.|expect\(|describe\(|beforeEach\().*$/gm) || [];
                assertPatterns.push(...assertMatches2);
              }
            }
          }
        }

        // Write observed_test_patterns to recipe
        if (!recipeContent.observed_test_patterns) {
          recipeContent.observed_test_patterns = {};
        }
        recipeContent.observed_test_patterns.test_files = testFiles;
        recipeContent.observed_test_patterns.assert_patterns = [...new Set(assertPatterns)]; // deduplicate
        recipeContent.observed_test_patterns.setup_patterns = [...new Set(setupPatterns)]; // deduplicate

        fs.writeFileSync(recipePath, JSON.stringify(recipeContent, null, 2) + '\n', 'utf8');
        enriched++;
      } catch (err) {
        process.stderr.write(TAG + ' --enrich-recipes: error processing ' + recipeFile + ': ' + err.message + '\n');
        errors++;
      }
    }
  } catch (err) {
    process.stderr.write(TAG + ' --enrich-recipes: error reading stubs directory: ' + err.message + '\n');
    errors++;
  }

  return { enriched, skipped, errors };
}

// ── Output Writers ───────────────────────────────────────────────────────────

/**
 * Write formal-test-sync report to .planning/formal/formal-test-sync-report.json.
 */
function writeReport(coverageReport, constantsValidation) {
  const report = {
    generated_at: new Date().toISOString(),
    coverage_gaps: coverageReport,
    constants_validation: constantsValidation,
  };

  fs.writeFileSync(REPORT_OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

/**
 * Write unit-test-coverage sidecar to .planning/formal/unit-test-coverage.json.
 * Consumed by traceability matrix generator.
 */
function writeSidecar(coverageReport) {
  const requirements = {};

  // Populate from covered requirements
  for (const req of coverageReport.covered) {
    requirements[req.requirement_id] = {
      covered: true,
      test_cases: req.test_cases,
    };
  }

  // Add gap requirements (formal but no test)
  for (const req of coverageReport.gaps) {
    requirements[req.requirement_id] = {
      covered: false,
      test_cases: req.test_cases,
    };
  }

  // Add uncovered requirements (no formal, no test)
  for (const req of coverageReport.uncovered) {
    requirements[req.requirement_id] = {
      covered: false,
      test_cases: req.test_cases,
    };
  }

  const sidecar = {
    generated_at: new Date().toISOString(),
    requirements,
  };

  fs.writeFileSync(SIDECAR_OUTPUT_PATH, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
}

/**
 * Print human-readable summary to stdout.
 */
function printSummary(coverageReport, constantsValidation, stubs) {
  const TAG_SUMMARY = '[formal-test-sync]';

  process.stdout.write(TAG_SUMMARY + ' Generated formal-test-sync report\n');
  process.stdout.write(TAG_SUMMARY + '   Coverage gaps: ' + coverageReport.stats.gap_count + ' requirements with formal but no test\n');
  process.stdout.write(TAG_SUMMARY + '   Both covered: ' + coverageReport.stats.both_covered + ' requirements with formal AND test\n');
  process.stdout.write(TAG_SUMMARY + '   Formal covered: ' + coverageReport.stats.formal_covered + ' / ' + coverageReport.stats.total + '\n');
  process.stdout.write(TAG_SUMMARY + '   Test covered: ' + coverageReport.stats.test_covered + ' / ' + coverageReport.stats.total + '\n');

  // Constants validation summary
  const mismatches = constantsValidation.filter(c => !c.match && c.config_path !== null);
  const mismatched = mismatches.filter(c => !c.intentional_divergence);
  const intentional = mismatches.filter(c => c.intentional_divergence);

  process.stdout.write(TAG_SUMMARY + '   Constants mismatches: ' + mismatched.length + ' (unexpected), ' + intentional.length + ' (intentional)\n');

  if (stubs.length > 0) {
    process.stdout.write(TAG_SUMMARY + '   Test stubs generated: ' + stubs.length + ' in ' + stubsDir + '\n');
    const recipeCount = stubs.filter(s => s.recipe_file).length;
    process.stdout.write(TAG_SUMMARY + '   Recipes: ' + recipeCount + ' generated\n');
  }

  if (!reportOnly && !dryRun) {
    process.stdout.write(TAG_SUMMARY + '   Report: ' + REPORT_OUTPUT_PATH + '\n');
    process.stdout.write(TAG_SUMMARY + '   Sidecar: ' + SIDECAR_OUTPUT_PATH + '\n');
  }
}

// ── Main Flow ────────────────────────────────────────────────────────────────

function main() {
  const formalAnnotations = loadFormalAnnotations();
  const testAnnotations = loadTestAnnotations();
  const requirements = loadRequirements();
  const mappings = loadConstantsMapping();

  const coverageReport = buildCoverageReport(formalAnnotations, testAnnotations, requirements);
  const constantsValidation = validateConstants(mappings);

  let stubs = [];
  if (!reportOnly) {
    // generateStubs computes the would-be stubs for display; it already skips
    // writing the stub FILES under --dry-run. The report + sidecar are writes
    // too, so a --dry-run (documented as "no writes") must skip them as well.
    stubs = generateStubs(coverageReport.gaps, formalAnnotations, requirements);
    if (!dryRun) {
      writeSidecar(coverageReport);
      writeReport(coverageReport, constantsValidation);
    }
  }

  if (jsonMode) {
    const output = {
      coverage_gaps: coverageReport,
      constants_validation: constantsValidation,
      stubs: stubs,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    printSummary(coverageReport, constantsValidation, stubs);
  }
}

// ── Exports (for testing) ────────────────────────────────────────────────────

module.exports = { parseAlloyDefaults, extractPropertyDefinition, findSourceFiles, classifyTestStrategy, classifyTestTemplate };

// ── Entry point ──────────────────────────────────────────────────────────────

// Synchronous main — must run (and call process.exit on error) before any async work.
if (require.main === module) {
  // --help short-circuits BEFORE any analysis or writes. Without this, an
  // unrecognized flag (including --help) fell through to the default full sync,
  // which writes stubs + report + sidecar — surprising and destructive for
  // someone just asking for usage.
  if (showHelp) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  main();

  // Async enrichment tail — only runs if --enrich-recipes flag is set.
  // main() has already completed by this point.
  if (enrichRecipes) {
    (async () => {
      const { createAdapter } = require('./coderlm-adapter.cjs');
      const adapter = createAdapter({ enabled: true });
      // Health check — skip if coderlm unavailable (fail-open)
      const health = adapter.healthSync();
      if (health.error) {
        process.stderr.write(TAG + ' --enrich-recipes: coderlm unavailable (' + health.error + '), skipping\n');
        return;
      }
      try {
        const result = await enrichRecipesWithTestPatterns(adapter);
        process.stderr.write(TAG + ' --enrich-recipes: enriched=' + result.enriched + ' skipped=' + result.skipped + ' errors=' + result.errors + '\n');
      } catch (e) {
        process.stderr.write(TAG + ' --enrich-recipes failed (non-fatal): ' + e.message + '\n');
      }
    })().catch(e => {
      process.stderr.write(TAG + ' --enrich-recipes fatal: ' + e.message + '\n');
    });
  }
}
