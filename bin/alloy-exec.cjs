#!/usr/bin/env node
'use strict';
// bin/alloy-exec.cjs
// Shared Alloy 6 execution + outcome parsing for nForma's Alloy runner surface.
// Requirements: SPEC-03 (and the broader Alloy verification surface)
//
// WHY THIS EXISTS (issue #199):
//   The legacy runners detected failures with `/Counterexample/i.test(stdout)`.
//   Alloy 6's CLI (`org.alloytools.alloy.dist.jar exec`) NEVER prints the word
//   "Counterexample". A violated `check` instead emits an instance block (a
//   `---Trace---` containing a `skolem $<Assert>_<var>` line in --type text mode,
//   and a `solution` entry with `instances` in receipt.json). So the dead regex
//   recorded real counterexamples as `pass`.
//
//   This module parses Alloy's STRUCTURED output (receipt.json) — the only
//   unambiguous carrier of per-command outcomes. With `--type text --quiet`,
//   the stdout `---Trace---` blocks have NO command headers, so a `run{}`
//   instance and a `check` counterexample are indistinguishable on stdout
//   alone. receipt.json tags each command with its `type` (run/check) and the
//   `solution[].instances` it produced.
//
// OUTCOME SEMANTICS (empirically captured from Alloy 6.2.0):
//   check, instances found    => counterexample => assertion VIOLATED  => fail
//   check, no instances       => no counterexample => assertion holds  => pass
//   run,   instances found     => satisfiable                          => pass
//   run,   no instances        => vacuity / unsatisfiable (suspicious) => fail
//
// The parser is PURE and jar-independent so it can be unit-tested against
// captured fixture strings without invoking Java/Alloy.

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.NF_ALLOY_TIMEOUT_MS || '120000', 10);
const DEFAULT_HEAP_MAX   = process.env.NF_JAVA_HEAP_MAX || '512m';

/**
 * Does a single command's solution array contain at least one concrete instance?
 * A passing `check` has no `solution` key at all; a satisfied `run` has a
 * `solution` array whose first entry carries a non-empty `instances` array.
 * @param {object} cmd - A command entry from receipt.commands.
 * @returns {boolean}
 */
function hasInstance(cmd) {
  if (!cmd || !Array.isArray(cmd.solution) || cmd.solution.length === 0) return false;
  return cmd.solution.some(sol => sol != null && Array.isArray(sol.instances) && sol.instances.length > 0);
}

/**
 * PURE parser. Converts Alloy 6's structured `receipt.json` output into a
 * per-command pass/fail verdict. Accepts the raw receipt JSON string or an
 * already-parsed object. Jar-independent and side-effect free.
 *
 * @param {string|object} receipt - Contents of receipt.json (string or parsed).
 * @returns {{
 *   ok: boolean,
 *   commands: Array<{name:string,type:string,source:string,instancesFound:boolean,outcome:'pass'|'fail',reason:string}>,
 *   failures: Array<{name:string,type:string,reason:string}>,
 *   summary: string,
 *   parseError: (string|null)
 * }}
 */
function parseAlloyOutcome(receipt) {
  let parsed = receipt;
  if (typeof receipt === 'string') {
    try {
      parsed = JSON.parse(receipt);
    } catch (e) {
      return {
        ok: false,
        commands: [],
        failures: [{ name: '(receipt)', type: 'parse', reason: 'invalid receipt JSON: ' + e.message }],
        summary: 'fail: could not parse Alloy receipt JSON',
        parseError: e.message,
      };
    }
  }

  const commandsObj = parsed && parsed.commands;
  if (!commandsObj || typeof commandsObj !== 'object') {
    return {
      ok: false,
      commands: [],
      failures: [{ name: '(receipt)', type: 'parse', reason: 'receipt has no commands' }],
      summary: 'fail: Alloy receipt contained no commands',
      parseError: 'no commands',
    };
  }

  const commands = [];
  const failures = [];

  for (const [name, cmd] of Object.entries(commandsObj)) {
    const type = cmd && cmd.type ? cmd.type : 'unknown';
    const source = cmd && cmd.source ? cmd.source : '';
    const instancesFound = hasInstance(cmd);

    let outcome;
    let reason;
    if (type === 'check') {
      // An instance for a check IS a counterexample.
      if (instancesFound) {
        outcome = 'fail';
        reason = 'counterexample found — assertion violated';
      } else {
        outcome = 'pass';
        reason = 'no counterexample — assertion holds';
      }
    } else if (type === 'run') {
      // Vacuity guard: a satisfiability run that yields no instance is suspect.
      if (instancesFound) {
        outcome = 'pass';
        reason = 'satisfiable — instance found';
      } else {
        outcome = 'fail';
        reason = 'no instance — vacuous/unsatisfiable run (vacuity guard)';
      }
    } else {
      // Unknown command type: be conservative and treat presence of an
      // instance as informational pass, absence as suspicious.
      outcome = instancesFound ? 'pass' : 'fail';
      reason = 'unknown command type: ' + type;
    }

    const entry = { name, type, source, instancesFound, outcome, reason };
    commands.push(entry);
    if (outcome === 'fail') failures.push({ name, type, reason });
  }

  const ok = failures.length === 0;
  const summary = ok
    ? 'pass: ' + commands.length + ' Alloy command(s) verified'
    : 'fail: ' + failures.length + '/' + commands.length + ' Alloy command(s) — ' +
        failures.map(f => f.name + ' (' + f.reason + ')').join('; ');

  return { ok, commands, failures, summary, parseError: null };
}

/**
 * Resolve a usable `java` executable. Returns { javaExe } or { error }.
 */
function resolveJava() {
  const JAVA_HOME = process.env.JAVA_HOME;
  if (JAVA_HOME) {
    const javaExe = path.join(JAVA_HOME, 'bin', 'java');
    if (!fs.existsSync(javaExe)) {
      return { error: 'JAVA_HOME set but java not found at ' + javaExe };
    }
    return { javaExe };
  }
  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return { error: 'java not found on PATH (install Java >=17, https://adoptium.net/)' };
  }
  return { javaExe: 'java' };
}

/**
 * Run the Alloy jar on an .als file with a hard timeout, then parse the
 * structured receipt.json it emits.
 *
 * @param {object} opts
 * @param {string} opts.jarPath  - Absolute path to org.alloytools.alloy.dist.jar.
 * @param {string} opts.alsPath  - Absolute path to the .als spec.
 * @param {string} [opts.javaExe] - java executable (auto-resolved if omitted).
 * @param {number} [opts.timeoutMs] - spawnSync timeout (default NF_ALLOY_TIMEOUT_MS or 120000).
 * @param {string} [opts.heapMax] - JVM -Xmx (default NF_JAVA_HEAP_MAX or 512m).
 * @param {string} [opts.outputDir] - Where Alloy writes receipt.json (temp dir if omitted).
 * @returns {{
 *   status: 'ok'|'error'|'timeout',
 *   outcome: (object|null),   // parseAlloyOutcome result when status==='ok'
 *   stdout: string,
 *   stderr: string,
 *   error: (string|null),
 *   receiptPath: (string|null)
 * }}
 */
function runAlloy(opts) {
  const o = opts || {};
  const { jarPath, alsPath } = o;
  if (typeof jarPath !== 'string' || !jarPath || typeof alsPath !== 'string' || !alsPath) {
    return { status: 'error', outcome: null, stdout: '', stderr: '',
      error: 'runAlloy requires string opts.jarPath and opts.alsPath', receiptPath: null };
  }
  const heapMax   = o.heapMax  || DEFAULT_HEAP_MAX;
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : DEFAULT_TIMEOUT_MS;

  let javaExe = o.javaExe;
  if (!javaExe) {
    const jres = resolveJava();
    if (jres.error) {
      return { status: 'error', outcome: null, stdout: '', stderr: '', error: jres.error, receiptPath: null };
    }
    javaExe = jres.javaExe;
  }

  // Dedicated output dir so receipt.json is unambiguous and isolated.
  let outputDir = o.outputDir;
  let createdTemp = false;
  if (!outputDir) {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-alloy-'));
    createdTemp = true;
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const result = spawnSync(javaExe, [
    '-Djava.awt.headless=true',
    '-Xms64m', '-Xmx' + heapMax,
    '-jar', jarPath,
    'exec',
    '--output', outputDir,
    '--type', 'text',
    '--quiet',
    '--force',
    alsPath,
  ], { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  // Timeout: spawnSync sets signal === 'SIGTERM' (or error.code 'ETIMEDOUT').
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) {
    cleanup(outputDir, createdTemp);
    return { status: 'timeout', outcome: null, stdout, stderr,
      error: 'Alloy timed out after ' + timeoutMs + 'ms', receiptPath: null };
  }
  if (result.error) {
    cleanup(outputDir, createdTemp);
    return { status: 'error', outcome: null, stdout, stderr,
      error: result.error.message, receiptPath: null };
  }

  const receiptPath = path.join(outputDir, 'receipt.json');
  if (!fs.existsSync(receiptPath)) {
    cleanup(outputDir, createdTemp);
    return { status: 'error', outcome: null, stdout, stderr,
      error: 'Alloy produced no receipt.json (exit ' + result.status + ')', receiptPath: null };
  }

  let outcome;
  try {
    outcome = parseAlloyOutcome(fs.readFileSync(receiptPath, 'utf8'));
  } catch (e) {
    cleanup(outputDir, createdTemp);
    return { status: 'error', outcome: null, stdout, stderr,
      error: 'failed to read receipt.json: ' + e.message, receiptPath: null };
  }

  cleanup(outputDir, createdTemp);
  return { status: 'ok', outcome, stdout, stderr, error: null, receiptPath };
}

function cleanup(dir, createdTemp) {
  if (!createdTemp) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

module.exports = { parseAlloyOutcome, runAlloy, hasInstance, resolveJava };
