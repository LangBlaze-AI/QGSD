#!/usr/bin/env node
'use strict';
// bin/run-phase-tlc.cjs
// PLAN-02: TLC verification runner for proposed-changes.tla with structured feedback.
//
// Runs TLC on a proposed-changes.tla generated from a PLAN.md file and returns
// structured results with pass/violations fields. Provides iterativeVerify for
// single-attempt orchestration and formatTlcFeedback for human-readable feedback.
//
// Usage:
//   node bin/run-phase-tlc.cjs <path-to-PLAN.md>
//
// Requires: Java >=17, .planning/formal/tla/tla2tools.jar
//
// NOTE: Uses spawnSync (no shell) for safe subprocess invocation -- no exec().

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const fs   = require('fs');
const path = require('path');

const { generateProposedChanges, generateTlaCfg } = require('./generate-proposed-changes.cjs');
const { classifyTruth } = require('./generate-phase-spec.cjs');

/**
 * Run TLC on a proposed-changes.tla spec file.
 *
 * @param {string} specPath - Path to the .tla spec file
 * @param {string} cfgPath - Path to the .cfg config file
 * @param {{ javaOverride?: string, jarOverride?: string }} [options]
 * @returns {{ passed: boolean, violations: string[], output: string, runtimeMs: number }}
 */
function runPhaseTlc(specPath, cfgPath, options) {
  options = options || {};

  // Check tla2tools.jar existence
  const { resolveTlaJar } = require('./resolve-formal-tools.cjs');
  const tla2toolsPath = options.jarOverride || resolveTlaJar();
  if (!tla2toolsPath) {
    return {
      passed: false,
      violations: ['tla2tools.jar not found -- run: node bin/install-formal-tools.cjs'],
      output: '',
      runtimeMs: 0,
    };
  }

  // Locate Java binary
  let javaExe = options.javaOverride || null;

  if (!javaExe) {
    const JAVA_HOME = process.env.JAVA_HOME;
    if (JAVA_HOME) {
      javaExe = path.join(JAVA_HOME, 'bin', 'java');
      if (!fs.existsSync(javaExe)) {
        javaExe = null;
      }
    }
    if (!javaExe) {
      const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0) {
        return {
          passed: false,
          violations: ['Java not found -- install JDK 17+'],
          output: '',
          runtimeMs: 0,
        };
      }
      javaExe = 'java';
    }
  } else {
    // Validate override path
    if (!fs.existsSync(javaExe)) {
      return {
        passed: false,
        violations: ['Java not found at ' + javaExe + ' -- install JDK 17+'],
        output: '',
        runtimeMs: 0,
      };
    }
  }

  // Invoke TLC via spawnSync (no shell -- safe subprocess)
  const startMs = Date.now();
  // Use a fixed metadir so TLC overwrites state files instead of creating timestamped dirs
  const metaDir = path.join(__dirname, '..', '.planning', 'formal', 'tla', 'states', 'current');
  fs.rmSync(metaDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });

  process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
  const tlcResult = spawnSync(javaExe, [
    '-XX:+UseParallelGC',
    '-Xms64m', '-Xmx' + JAVA_HEAP_MAX,
    '-jar', tla2toolsPath,
    '-metadir', metaDir,
    '-workers', '1',
    '-config', cfgPath,
    specPath,
  ], { encoding: 'utf8', timeout: 60000 });
  const runtimeMs = Date.now() - startMs;

  const output = (tlcResult.stdout || '') + (tlcResult.stderr || '');
  const violations = [];

  if (tlcResult.error) {
    violations.push('TLC invocation failed: ' + tlcResult.error.message);
    return { passed: false, violations, output, runtimeMs };
  }

  // Parse violations
  const invariantRegex = /Invariant (\w+) is violated/g;
  const propertyRegex = /Property (\w+) is violated/g;
  const errorRegex = /^Error:\s*(.+)/gm;

  let match;
  while ((match = invariantRegex.exec(output)) !== null) {
    violations.push('Invariant ' + match[1] + ' is violated');
  }
  while ((match = propertyRegex.exec(output)) !== null) {
    violations.push('Property ' + match[1] + ' is violated');
  }
  while ((match = errorRegex.exec(output)) !== null) {
    // Only add Error lines that aren't already captured as violations
    const errText = match[1].trim();
    if (!violations.some(v => v.includes(errText))) {
      violations.push('Error: ' + errText);
    }
  }

  // Check for successful completion
  const passed = output.includes('Model checking completed. No error has been found.') && violations.length === 0;

  return { passed, violations, output, runtimeMs };
}

/**
 * Format TLC feedback for the planner with truth mapping.
 *
 * @param {number} attempt - Current attempt number (1-based)
 * @param {number} maxAttempts - Maximum attempts
 * @param {{ passed: boolean, violations: string[], output: string, runtimeMs: number }} tlcResult
 * @param {string[]} truthsList - Original truths list from PLAN.md
 * @returns {string}
 */
function formatTlcFeedback(attempt, maxAttempts, tlcResult, truthsList) {
  if (!Array.isArray(truthsList)) truthsList = [];
  if (tlcResult.passed) {
    return 'ATTEMPT ' + attempt + '/' + maxAttempts + ': TLC verification PASSED. All ' + truthsList.length + ' properties satisfied.';
  }

  let feedback = 'ATTEMPT ' + attempt + '/' + maxAttempts + ': TLC verification FAILED.\n';

  const violationList = Array.isArray(tlcResult && tlcResult.violations) ? tlcResult.violations : [];
  for (const violation of violationList) {
    const reqMatch = violation.match(/Req(\d{2})/);
    if (reqMatch) {
      const truthIndex = parseInt(reqMatch[1], 10) - 1;
      const truthText = truthIndex >= 0 && truthIndex < truthsList.length
        ? truthsList[truthIndex]
        : '(unknown truth)';
      const kindMatch = violation.match(/^(Invariant|Property)/);
      const kind = kindMatch ? kindMatch[1].toUpperCase() : 'UNKNOWN';
      feedback += 'Violated: Req' + reqMatch[1] + ' (' + kind + ') -- "' + truthText + '"\n';
    } else {
      feedback += violation + '\n';
    }
  }

  feedback += 'Suggestion: Revise the truth statement or adjust the plan to satisfy this constraint.';
  return feedback;
}

/**
 * Perform a single TLC verification attempt on a PLAN.md file.
 *
 * @param {string} planFilePath - Path to the PLAN.md file
 * @returns {{ status: string, reason?: string, violations?: string[], feedback?: string, truthCount?: number, specPath?: string, runtimeMs?: number }}
 */
function iterativeVerify(planFilePath) {
  // Generate spec
  const genResult = generateProposedChanges(planFilePath);

  if (!genResult.generated) {
    return { status: 'skipped', reason: 'no truths in plan' };
  }

  // Generate TLC config
  const { cfgPath } = generateTlaCfg(genResult.specPath);

  // Run TLC
  const tlcResult = runPhaseTlc(genResult.specPath, cfgPath);

  if (tlcResult.passed) {
    return {
      status: 'passed',
      truthCount: genResult.truthCount,
      specPath: genResult.specPath,
      runtimeMs: tlcResult.runtimeMs,
    };
  }

  // Build truths list for feedback
  const truths = genResult.classifications.map(c => c.truth);
  const feedback = formatTlcFeedback(1, 3, tlcResult, truths);

  return {
    status: 'failed',
    violations: tlcResult.violations,
    feedback,
    specPath: genResult.specPath,
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

  if (args.length === 0) {
    process.stderr.write('[run-phase-tlc] Usage: node bin/run-phase-tlc.cjs <path-to-PLAN.md>\n');
    process.exit(1);
  }

  const planFilePath = path.resolve(args[0]);
  if (!fs.existsSync(planFilePath)) {
    process.stderr.write('[run-phase-tlc] Error: file not found: ' + planFilePath + '\n');
    process.exit(1);
  }

  const result = iterativeVerify(planFilePath);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.status === 'failed') {
    process.exit(1);
  }
}

module.exports = { runPhaseTlc, iterativeVerify, formatTlcFeedback };
