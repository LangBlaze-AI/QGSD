#!/usr/bin/env node
'use strict';
// bin/run-formal-check.cjs
// Lightweight per-module formal checker for TLC, Alloy, PRISM.
// Invoked by Step 6.3 in quick.md to run model checkers after execution.
// Requirements: quick-130
//
// Usage:
//   node bin/run-formal-check.cjs --modules=quorum
//   node bin/run-formal-check.cjs --modules=quorum,tui-nav,breaker
//
// Exit codes:
//   0 if all checks passed or skipped (no counterexample)
//   1 if any check failed (counterexample or TLC error)
//
// Prerequisites:
//   - Java >=17 (for TLC and Alloy)
//   - .planning/formal/tla/tla2tools.jar
//   - .planning/formal/alloy/org.alloytools.alloy.dist.jar
//   - PRISM_BIN env var (optional; skipped if not set)

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Project-level manifest support ──────────────────────────────────────
// ROOT uses git root detection for consistency with formal-scope-scan.cjs
const ROOT = (() => {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: 'pipe'
    });
    if (result.status === 0) return result.stdout.trim();
  } catch (_) {}
  return process.cwd();
})();

const PROJECT_MANIFEST_PATH = path.join(ROOT, '.planning', 'formal', 'specs', 'formal-checks.json');

// Allowlist of command executables permitted from manifest
const ALLOWED_COMMANDS = new Set(['make', 'java', 'node', 'npm', 'npx', 'python3', 'python']);

// Dangerous argument patterns — reject these even for allowed commands
const DANGEROUS_ARG_PATTERNS = new Set(['-c', '-e', '--eval', '--exec', 'eval', '-i']);

/**
 * Load project-level formal checks manifest. Fail-open: returns [] on any error.
 */
function loadProjectManifest() {
  try {
    if (!fs.existsSync(PROJECT_MANIFEST_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(PROJECT_MANIFEST_PATH, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.specs)) {
      process.stderr.write('[run-formal-check] WARN: invalid manifest version or missing specs array\n');
      return [];
    }
    return data.specs.filter(spec => {
      if (!spec.command || !Array.isArray(spec.args)) {
        process.stderr.write(`[run-formal-check] WARN: skipping manifest entry "${spec.module || 'unknown'}" — missing command or args\n`);
        return false;
      }
      return true;
    });
  } catch (e) {
    process.stderr.write('[run-formal-check] WARN: failed to load project manifest: ' + e.message + '\n');
    return [];
  }
}

/**
 * Execute a project-level formal check via structured command/args.
 * Safety gates: command allowlist, dangerous arg patterns, path containment.
 * Fail-open: spawn errors produce 'skipped', never crash.
 */
function runProjectCheck(spec, cwd) {
  const startMs = Date.now();
  const base = { module: spec.module, tool: spec.type || 'unknown' };

  // Safety gate 0 — spec_path must be a non-empty string. Manifest validation
  // only checks command/args, so a malformed entry can reach here without one;
  // path.isAbsolute(undefined) would throw ERR_INVALID_ARG_TYPE outside the spawn
  // try/catch and crash the process (fail-open violation).
  if (typeof spec.spec_path !== 'string' || spec.spec_path.length === 0) {
    return { ...base, status: 'skipped', detail: 'missing or invalid spec_path', runtimeMs: 0 };
  }

  // Safety gate 1 — command allowlist
  if (!ALLOWED_COMMANDS.has(spec.command)) {
    return { ...base, status: 'skipped', detail: 'command not in allowlist: ' + spec.command, runtimeMs: 0 };
  }

  // Safety gate 2 — dangerous argument patterns
  for (const arg of spec.args) {
    if (DANGEROUS_ARG_PATTERNS.has(arg)) {
      return { ...base, status: 'skipped', detail: 'dangerous argument pattern: ' + arg, runtimeMs: 0 };
    }
  }

  // Safety gate 3 — path containment
  if (path.isAbsolute(spec.spec_path)) {
    return { ...base, status: 'skipped', detail: 'spec_path escapes project root: ' + spec.spec_path, runtimeMs: 0 };
  }
  const resolved = path.resolve(cwd, spec.spec_path);
  const cwdResolved = path.resolve(cwd);
  if (!resolved.startsWith(cwdResolved + path.sep) && resolved !== cwdResolved) {
    return { ...base, status: 'skipped', detail: 'spec_path escapes project root: ' + spec.spec_path, runtimeMs: 0 };
  }

  // Spec file pre-flight
  if (!fs.existsSync(resolved)) {
    return { ...base, status: 'skipped', detail: 'spec file not found: ' + spec.spec_path, runtimeMs: 0 };
  }

  // Execute structured command
  try {
    const result = spawnSync(spec.command, spec.args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180000
    });

    const runtimeMs = Date.now() - startMs;

    if (result.error) {
      return { ...base, status: 'skipped', detail: result.error.message, runtimeMs };
    }
    if (result.status !== 0) {
      return { ...base, status: 'fail', detail: `Exit code ${result.status}`, runtimeMs };
    }
    return { ...base, status: 'pass', detail: '', runtimeMs };
  } catch (e) {
    return { ...base, status: 'skipped', detail: 'spawn error: ' + e.message, runtimeMs: Date.now() - startMs };
  }
}

// ── Module to check mapping (hardcoded) ──────────────────────────────────
const MODULE_CHECKS = {
  quorum: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCliveness.cfg',
        '.planning/formal/tla/NFQuorum.tla',
        '-workers', '1'
      ]
    },
    {
      tool: 'alloy',
      cmd: [
        'java', '-jar', '.planning/formal/alloy/org.alloytools.alloy.dist.jar', 'exec',
        '--output', '-', '--type', 'text', '--quiet',
        '.planning/formal/alloy/quorum-votes.als'
      ]
    },
    {
      tool: 'prism',
      cmd: null, // Set dynamically if PRISM_BIN is set
      prismModel: '.planning/formal/prism/quorum.pm',
      prismProps: '.planning/formal/prism/quorum.props'
    }
  ],
  'tui-nav': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCTUINavigation.cfg',
        '.planning/formal/tla/TUINavigation.tla',
        '-workers', '1'
      ]
    }
  ],
  breaker: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCbreaker.cfg',
        '.planning/formal/tla/NFCircuitBreaker.tla',
        '-workers', '1'
      ]
    }
  ],
  deliberation: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCdeliberation.cfg',
        '.planning/formal/tla/NFDeliberation.tla',
        '-workers', '1'
      ]
    }
  ],
  oscillation: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCoscillation.cfg',
        '.planning/formal/tla/NFOscillation.tla',
        '-workers', '1'
      ]
    }
  ],
  convergence: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCconvergence.cfg',
        '.planning/formal/tla/NFConvergence.tla',
        '-workers', '1'
      ]
    }
  ],
  prefilter: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCprefilter.cfg',
        '.planning/formal/tla/NFPreFilter.tla',
        '-workers', '1'
      ]
    }
  ],
  recruiting: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCrecruiting-safety.cfg',
        '.planning/formal/tla/NFRecruiting.tla',
        '-workers', '1'
      ]
    }
  ],
  'account-manager': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCaccount-manager.cfg',
        '.planning/formal/tla/NFAccountManager.tla',
        '-workers', '1'
      ]
    }
  ],
  'mcp-calls': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCMCPEnv.cfg',
        '.planning/formal/tla/NFMCPEnv.tla',
        '-workers', '1'
      ]
    }
  ],
  'formal-proximity-index': [
    {
      tool: 'alloy',
      cmd: [
        'java', '-jar', '.planning/formal/alloy/org.alloytools.alloy.dist.jar', 'exec',
        '--output', '-', '--type', 'text', '--quiet',
        '.planning/formal/alloy/proximity-index.als'
      ]
    }
  ],
  'agent-loop': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCAgentLoop.cfg',
        '.planning/formal/tla/QGSDAgentLoop.tla',
        '-workers', '1'
      ]
    }
  ],
  'deliberation-revision': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCDeliberationRevision.cfg',
        '.planning/formal/tla/QGSDDeliberationRevision.tla',
        '-workers', '1'
      ]
    }
  ],
  installer: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCinstaller.cfg',
        '.planning/formal/tla/QGSDInstallerIdempotency.tla',
        '-workers', '1'
      ]
    }
  ],
  safety: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCsafety.cfg',
        '.planning/formal/tla/NFQuorum.tla',
        '-workers', '1'
      ]
    }
  ],
  sessionpersistence: [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCSessionPersistence.cfg',
        '.planning/formal/tla/QGSDSessionPersistence.tla',
        '-workers', '1'
      ]
    }
  ],
  'solve-convergence': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCSolveConvergenceV2.cfg',
        '.planning/formal/tla/NFSolveConvergenceV2.tla',
        '-workers', '1'
      ]
    }
  ],
  'stop-hook': [
    {
      tool: 'tlc',
      cmd: [
        'java', '-cp', '.planning/formal/tla/tla2tools.jar', 'tlc2.TLC',
        '-config', '.planning/formal/tla/MCStopHook.cfg',
        '.planning/formal/tla/NFStopHook.tla',
        '-workers', '1'
      ]
    }
  ],
  'uppaal-races': [
    {
      tool: 'alloy',
      cmd: [
        'java', '-jar', '.planning/formal/alloy/org.alloytools.alloy.dist.jar', 'exec',
        '--output', '-', '--type', 'text', '--quiet',
        '.planning/formal/alloy/uppaal-race-modeling.als'
      ]
    }
  ]
};

// ── Helper: Detect Java ──────────────────────────────────────────────────
function detectJava() {
  const JAVA_HOME = process.env.JAVA_HOME;
  let javaExe;

  if (JAVA_HOME) {
    javaExe = path.join(JAVA_HOME, 'bin', 'java');
    if (fs.existsSync(javaExe)) {
      return javaExe;
    }
  }

  const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) {
    return 'java';
  }

  return null;
}

// ── Helper: Check if file exists (fail-open on missing jar) ───────────────
function checkJarExists(jarPath) {
  return fs.existsSync(jarPath);
}

// ── Helper: Run a single check ──────────────────────────────────────────────
function runCheck(module, checkDef, javaExe, cwd, tlcJarPath, alloyJarPath) {
  const tool = checkDef.tool;
  const startMs = Date.now();

  if (tool === 'tlc') {
    // TLC check — use fixed metadir to avoid timestamped state accumulation
    const metaDir = path.join(cwd, '.planning', 'formal', 'tla', 'states', 'current');
    fs.rmSync(metaDir, { recursive: true, force: true });
    fs.mkdirSync(metaDir, { recursive: true });

    // Substitute resolved jar path into cmd (replaces hardcoded project-local path)
    const resolvedCmd = checkDef.cmd.map(arg =>
      arg === '.planning/formal/tla/tla2tools.jar' ? tlcJarPath : arg
    );
    const cmd = resolvedCmd[0];
    const args = [...resolvedCmd.slice(1), '-metadir', metaDir];

    const result = spawnSync(cmd, args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180000
    });

    const runtimeMs = Date.now() - startMs;
    let status = 'pass';
    let detail = '';

    if (result.error) {
      status = 'skipped';
      detail = result.error.message;
    } else if (result.status !== 0) {
      status = 'fail';
      detail = `Exit code ${result.status}`;
      // Scan stderr for error indicators
      if (result.stderr && result.stderr.includes('Error:')) {
        detail += '; error in stderr';
      }
    }

    return { module, tool, status, detail, runtimeMs };
  } else if (tool === 'alloy') {
    // Alloy check — substitute resolved jar path
    const resolvedAlloyCmd = checkDef.cmd.map(arg =>
      arg === '.planning/formal/alloy/org.alloytools.alloy.dist.jar' ? alloyJarPath : arg
    );
    const cmd = resolvedAlloyCmd[0];
    const args = resolvedAlloyCmd.slice(1);

    const result = spawnSync(cmd, args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180000
    });

    const runtimeMs = Date.now() - startMs;
    let status = 'pass';
    let detail = '';

    if (result.error) {
      status = 'skipped';
      detail = result.error.message;
    } else if (result.status !== 0) {
      status = 'fail';
      detail = `Exit code ${result.status}`;
    } else if (result.stdout && result.stdout.includes('Counterexample')) {
      status = 'fail';
      detail = 'Counterexample found';
    }

    return { module, tool, status, detail, runtimeMs };
  } else if (tool === 'prism') {
    // PRISM check — delegate to run-prism.cjs for full feature support
    // (properties file injection, scoreboard-based tp_rate/unavail, cold-start detection, policy.yaml loading)
    const modelName = path.basename(checkDef.prismModel, '.pm');
    const runPrismPath = path.join(__dirname, 'run-prism.cjs');
    const result = spawnSync(process.execPath, [runPrismPath, '--model', modelName], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180000
    });

    const runtimeMs = Date.now() - startMs;
    let status = 'pass';
    let detail = '';

    if (result.error) {
      // Spawn failure (e.g., node not found) — fail-open as skipped
      status = 'skipped';
      detail = result.error.message;
    } else if (result.status !== 0) {
      // Distinguish "prism not installed" (skip) from "prism check failed" (fail)
      const stderr = result.stderr || '';
      if (stderr.includes('binary not found') || stderr.includes('PRISM_BIN')) {
        status = 'skipped';
        detail = 'PRISM binary not found — install PRISM and set PRISM_BIN';
      } else {
        status = 'fail';
        detail = `Exit code ${result.status}`;
      }
    }

    return { module, tool, status, detail, runtimeMs };
  }

  return { module, tool, status: 'skipped', detail: 'Unknown tool', runtimeMs: 0 };
}

// ── Main execution ──────────────────────────────────────────────────────────
if (require.main === module) {
  // Parse --modules argument
  const args = process.argv.slice(2);
  let modules = [];

  const modulesArg = args.find(a => a.startsWith('--modules='));
  if (modulesArg) {
    modules = modulesArg.split('=')[1].split(',').map(m => m.trim());
  }

  if (modules.length === 0) {
    process.stderr.write('[run-formal-check] Error: --modules argument required\n');
    process.stderr.write('[run-formal-check] Usage: node bin/run-formal-check.cjs --modules=quorum,tui-nav\n');
    process.exit(1);
  }

  const cwd = process.cwd();

  // Detect Java (fail-open)
  const javaExe = detectJava();
  if (!javaExe) {
    process.stderr.write('[run-formal-check] WARNING: java not found — skipping all TLC/Alloy checks\n');
    // All checks become skipped
    const allResults = [];
    const unknownModules = [];
    for (const module of modules) {
      if (!MODULE_CHECKS[module]) {
        // Fall through to project manifest
        const projectSpecs = loadProjectManifest();
        const projectSpec = projectSpecs.find(s => s.module === module);
        if (projectSpec) {
          const result = runProjectCheck(projectSpec, cwd);
          allResults.push(result);
          continue;
        }
        process.stderr.write(`[run-formal-check] ERROR: unknown module "${module}" — no checks registered\n`);
        unknownModules.push(module);
        continue;
      }
      for (const checkDef of MODULE_CHECKS[module]) {
        allResults.push({
          module,
          tool: checkDef.tool,
          status: 'skipped',
          detail: 'java not found',
          runtimeMs: 0
        });
      }
    }

    const skipped = allResults.length;
    const passed = 0;
    const failed = 0;

    process.stdout.write(`[run-formal-check] Results: ${allResults.length} checks, ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    process.stdout.write(`FORMAL_CHECK_RESULT=${JSON.stringify({ passed, failed, skipped, counterexamples: [] })}\n`);
    if (unknownModules.length > 0) {
      process.stderr.write(`[run-formal-check] FAIL: ${unknownModules.length} unknown module(s): ${unknownModules.join(', ')} — register in MODULE_CHECKS\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Check jar files (fail-open on missing) — resolve system-wide first, then project-local
  const { resolveTlaJar, resolveAlloyJar } = require('./resolve-formal-tools.cjs');
  const tlcJarPath = resolveTlaJar(cwd) || path.join(cwd, '.planning', 'formal', 'tla', 'tla2tools.jar');
  const alloyJarPath = resolveAlloyJar(cwd) || path.join(cwd, '.planning', 'formal', 'alloy', 'org.alloytools.alloy.dist.jar');

  const tlcJarExists = checkJarExists(tlcJarPath);
  const alloyJarExists = checkJarExists(alloyJarPath);

  // Run all checks
  const allResults = [];
  const unknownModules = [];

  for (const module of modules) {
    if (!MODULE_CHECKS[module]) {
      // Fall through to project manifest
      const projectSpecs = loadProjectManifest();
      const projectSpec = projectSpecs.find(s => s.module === module);
      if (projectSpec) {
        const result = runProjectCheck(projectSpec, cwd);
        allResults.push(result);
        continue;
      }
      process.stderr.write(`[run-formal-check] ERROR: unknown module "${module}" — no checks registered\n`);
      unknownModules.push(module);
      continue;
    }

    for (const checkDef of MODULE_CHECKS[module]) {
      if (checkDef.tool === 'tlc' && !tlcJarExists) {
        process.stderr.write(`[run-formal-check] WARNING: tla2tools.jar not found — skipping ${module} TLC check\n`);
        allResults.push({
          module,
          tool: 'tlc',
          status: 'skipped',
          detail: 'tla2tools.jar not found',
          runtimeMs: 0
        });
      } else if (checkDef.tool === 'alloy' && !alloyJarExists) {
        process.stderr.write(`[run-formal-check] WARNING: org.alloytools.alloy.dist.jar not found — skipping ${module} Alloy check\n`);
        allResults.push({
          module,
          tool: 'alloy',
          status: 'skipped',
          detail: 'org.alloytools.alloy.dist.jar not found',
          runtimeMs: 0
        });
      } else {
        const result = runCheck(module, checkDef, javaExe, cwd, tlcJarPath, alloyJarPath);
        allResults.push(result);
      }
    }
  }

  // Count results
  const passed = allResults.filter(r => r.status === 'pass').length;
  const failed = allResults.filter(r => r.status === 'fail').length;
  const skipped = allResults.filter(r => r.status === 'skipped').length;
  const counterexamples = allResults
    .filter(r => r.status === 'fail')
    .map(r => `${r.module}:${r.tool}`);

  // Output summary
  process.stdout.write(`[run-formal-check] Results: ${allResults.length} checks, ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  // Machine-readable result line
  process.stdout.write(`FORMAL_CHECK_RESULT=${JSON.stringify({ passed, failed, skipped, counterexamples })}\n`);

  // Exit code: 1 if any failed OR if any requested modules were unknown (vacuous pass prevention)
  if (unknownModules.length > 0) {
    process.stderr.write(`[run-formal-check] FAIL: ${unknownModules.length} unknown module(s): ${unknownModules.join(', ')} — register in MODULE_CHECKS\n`);
  }
  const exitCode = (failed > 0 || unknownModules.length > 0) ? 1 : 0;
  process.exit(exitCode);
}

module.exports = {
  detectJava,
  checkJarExists,
  runCheck,
  MODULE_CHECKS,
  loadProjectManifest,
  runProjectCheck,
  ALLOWED_COMMANDS,
  DANGEROUS_ARG_PATTERNS
};
