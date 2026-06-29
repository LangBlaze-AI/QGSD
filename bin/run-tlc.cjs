#!/usr/bin/env node
'use strict';
// bin/run-tlc.cjs
// Invokes TLC model checker for the nForma formal TLA+ specification.
// Requirements: TLA-04
//
// Usage:
//   node bin/run-tlc.cjs MCsafety     # safety check (N=5, symmetry, ~30s)
//   node bin/run-tlc.cjs MCliveness   # liveness check (N=3, no symmetry, ~60s)
//   node bin/run-tlc.cjs --config=MCsafety
//
// Prerequisites:
//   - Java >=17 (https://adoptium.net/)
//   - .planning/formal/tla/tla2tools.jar (see .planning/formal/tla/README.md for download command)

const { spawnSync } = require('child_process');
const JAVA_HEAP_MAX = process.env.NF_JAVA_HEAP_MAX || '512m';
const TLC_TIMEOUT_MS = parseInt(process.env.NF_TLC_TIMEOUT_MS || '1800000', 10); // 30min default
const TLC_WORKERS = process.env.NF_TLC_WORKERS || '2'; // prevent all-core saturation
const fs   = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');

// ── Resolve project root (--project-root= overrides __dirname-relative) ─────
let ROOT = path.join(__dirname, '..');
for (const arg of process.argv) {
  if (arg.startsWith('--project-root=')) ROOT = path.resolve(arg.slice('--project-root='.length));
}

const CHECK_ID_MAP = {
  'MCsafety':   'tla:quorum-safety',
  'MCliveness': 'tla:quorum-liveness',
  'MCMCPEnv':   'tla:mcp-environment',
};

const PROPERTY_MAP = {
  'MCsafety':   'Safety invariants — TypeInvariant, SafetyInvariant, no deadlock',
  'MCliveness': 'Liveness — EventuallyDecided, EventuallyTerminates',
  'MCMCPEnv':   'MCP environment — MCPEnvSafety, MCPEnvLiveness',
};

// ── Surface map for liveness detection ──────────────────────────────────────
const SURFACE_MAP = {
  'MCliveness':            'quorum',
  'MCsafety':              'safety',
  'MCdeliberation':        'deliberation',
  'MCprefilter':           'prefilter',
  'MCrecruiting-liveness': 'recruiting',
  'MCbreaker':             'breaker',
  'MCconvergence':         'convergence',
  'MCConvergenceTest':     'convergence',
  'MCoscillation':         'oscillation',
  'MCaccount-manager':     'account-manager',
  'MCMCPEnv':              'mcp-calls',  // MCPENV-02
  'MCStopHook':            'stop-hook',
  'MCAgentLoop':           'agent-loop',
  'MCTUINavigation':       'tui-nav',
  'MCinstaller':           'installer',
  'MCDeliberationRevision': 'deliberation-revision',
  'MCPlanningState':        'planningstate',
  'MCSessionPersistence':   'sessionpersistence',
};

/**
 * Detect liveness properties in a TLC config that lack fairness declarations.
 * Returns array of property names missing a matching ## header in invariants.md.
 * Returns [] if no PROPERTY/PROPERTIES lines found (not a liveness config).
 * @param {string} configName - Config name (e.g., 'MCliveness')
 * @param {string} cfgPath    - Absolute path to the .cfg file
 * @param {string} [specDir]  - Override for .planning/formal/spec directory (test injection)
 * @returns {string[]} Property names with no fairness declaration
 */
function detectLivenessProperties(configName, cfgPath, specDir) {
  const defaultSpecDir = path.join(ROOT, '.planning', 'formal', 'spec');
  const resolvedSpecDir = specDir || defaultSpecDir;

  let cfgContent;
  try {
    cfgContent = fs.readFileSync(cfgPath, 'utf8');
  } catch (e) {
    return []; // Can't read config — not a detection failure
  }

  // Extract all property names from PROPERTY/PROPERTIES lines (handles multi-name lines)
  const propertyNames = [];
  for (const line of cfgContent.split('\n')) {
    const m = line.trim().match(/^PROPERT(?:Y|IES)\s+(.*)/);
    if (m) {
      propertyNames.push(...m[1].trim().split(/\s+/).filter(n => /^\w+$/.test(n)));
    }
  }
  if (propertyNames.length === 0) {
    return []; // No liveness properties declared
  }

  let surface = (typeof configName === 'string'
      && Object.prototype.hasOwnProperty.call(SURFACE_MAP, configName))
    ? SURFACE_MAP[configName]
    : undefined;

  // Fallback: if config not in SURFACE_MAP, try stripping MC prefix
  if (!surface && typeof configName === 'string' && configName.startsWith('MC')) {
    surface = configName.substring(2).toLowerCase();
  }

  if (typeof surface !== 'string' || !surface) {
    return []; // Unknown surface — can't validate; do not block unknown configs
  }

  const invariantsPath = path.join(resolvedSpecDir, surface, 'invariants.md');
  let invariantsContent;
  try {
    invariantsContent = fs.readFileSync(invariantsPath, 'utf8');
  } catch (e) {
    // invariants.md missing entirely — all properties lack declarations
    return propertyNames;
  }

  return propertyNames.filter(propName => !invariantsContent.includes('## ' + propName));
}

// ── Main execution (only when run directly, not when require()'d by tests) ──
if (require.main === module) {
  // ── Parse --config argument and --verification-mode argument ──────────────
  const args       = process.argv.slice(2);
  const configArg  = args.find(a => a.startsWith('--config=')) || null;
  const verificationModeArg = args.find(a => a.startsWith('--verification-mode=')) || null;
  const verificationMode = verificationModeArg ? verificationModeArg.split('=')[1] : 'validation';
  const configName = configArg
    ? configArg.split('=')[1]
    : (args.find(a => !a.startsWith('-')) || 'MCsafety');

  // Validate config: accept any configName as long as .cfg file exists
  const _cfgCheckPath = path.join(ROOT, '.planning', 'formal', 'tla', configName + '.cfg');
  if (!fs.existsSync(_cfgCheckPath)) {
    process.stderr.write(
      '[run-tlc] Config file not found: ' + _cfgCheckPath + '\n'
    );
    const _startMs = Date.now();
    const _runtimeMs = 0;
    try {
      writeCheckResult({
        tool: 'run-tlc',
        formalism: 'tla',
        result: 'error',
        check_id: 'tla:' + configName.toLowerCase(),
        surface: 'tla',
        property: 'Config not found: ' + configName,
        runtime_ms: _runtimeMs,
        summary: 'error: config file not found in ' + _runtimeMs + 'ms',
        requirement_ids: getRequirementIds('tla:' + configName.toLowerCase()),
        metadata: { config: configName, verification_mode: verificationMode }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }

  // ── 1. Locate Java ─────────────────────────────────────────────────────────
  const JAVA_HOME = process.env.JAVA_HOME;
  let javaExe;

  if (JAVA_HOME) {
    javaExe = path.join(JAVA_HOME, 'bin', 'java');
    if (!fs.existsSync(javaExe)) {
      process.stderr.write(
        '[run-tlc] JAVA_HOME is set but java binary not found at: ' + javaExe + '\n' +
        '[run-tlc] Unset JAVA_HOME or fix the path.\n'
      );
      const _startMs = Date.now();
      const _runtimeMs = 0;
      try {
        writeCheckResult({
          tool: 'run-tlc',
          formalism: 'tla',
          result: 'error',
          check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()),
          surface: 'tla',
          property: PROPERTY_MAP[configName] || configName,
          runtime_ms: _runtimeMs,
          summary: 'error: Java not found in ' + _runtimeMs + 'ms',
          requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())),
          metadata: { config: configName, verification_mode: verificationMode }
        });
      } catch (e) {
        process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
      }
      process.exit(1);
    }
  } else {
    // Fall back to PATH lookup
    const probe = spawnSync('java', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      process.stderr.write(
        '[run-tlc] Java not found. Install Java >=17 and set JAVA_HOME.\n' +
        '[run-tlc] Download: https://adoptium.net/\n'
      );
      const _startMs = Date.now();
      const _runtimeMs = 0;
      try {
        writeCheckResult({
          tool: 'run-tlc',
          formalism: 'tla',
          result: 'error',
          check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()),
          surface: 'tla',
          property: PROPERTY_MAP[configName] || configName,
          runtime_ms: _runtimeMs,
          summary: 'error: Java not found in ' + _runtimeMs + 'ms',
          requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())),
          metadata: { config: configName, verification_mode: verificationMode }
        });
      } catch (e) {
        process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
      }
      process.exit(1);
    }
    javaExe = 'java';
  }

  // ── 2. Check Java version >=17 ─────────────────────────────────────────────
  const versionResult = spawnSync(javaExe, ['--version'], { encoding: 'utf8' });
  if (versionResult.error || versionResult.status !== 0) {
    process.stderr.write('[run-tlc] Failed to run: ' + javaExe + ' --version\n');
    const _startMs = Date.now();
    const _runtimeMs = 0;
    try {
      writeCheckResult({
        tool: 'run-tlc',
        formalism: 'tla',
        result: 'error',
        check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()),
        surface: 'tla',
        property: PROPERTY_MAP[configName] || configName,
        runtime_ms: _runtimeMs,
        summary: 'error: Java version check failed in ' + _runtimeMs + 'ms',
        requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())),
        metadata: { config: configName }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }
  const versionOutput = versionResult.stdout + versionResult.stderr;
  // Java version string varies: "openjdk 17.0.1 ..." or "java version \"17.0.1\""
  const versionMatch = versionOutput.match(/(?:openjdk\s+|java version\s+[""]?)(\d+)/i);
  const javaMajor    = versionMatch ? parseInt(versionMatch[1], 10) : 0;
  if (javaMajor < 17) {
    process.stderr.write(
      '[run-tlc] Java >=17 required. Found: ' + versionOutput.split('\n')[0] + '\n' +
      '[run-tlc] Download Java 17+: https://adoptium.net/\n'
    );
    const _startMs = Date.now();
    const _runtimeMs = 0;
    try {
      writeCheckResult({
        tool: 'run-tlc',
        formalism: 'tla',
        result: 'error',
        check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()),
        surface: 'tla',
        property: PROPERTY_MAP[configName] || configName,
        runtime_ms: _runtimeMs,
        summary: 'error: Java ' + javaMajor + ' < 17 in ' + _runtimeMs + 'ms',
        requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())),
        metadata: { config: configName }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }

  // ── 3. Locate tla2tools.jar ────────────────────────────────────────────────
  const { resolveTlaJar } = require('./resolve-formal-tools.cjs');
  const jarPath = resolveTlaJar(ROOT);
  if (!jarPath) {
    process.stderr.write(
      '[run-tlc] tla2tools.jar not found.\n' +
      '[run-tlc] Install: node bin/install-formal-tools.cjs\n'
    );
    const _startMs = Date.now();
    const _runtimeMs = 0;
    try {
      writeCheckResult({
        tool: 'run-tlc',
        formalism: 'tla',
        result: 'error',
        check_id: CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase()),
        surface: 'tla',
        property: PROPERTY_MAP[configName] || configName,
        runtime_ms: _runtimeMs,
        summary: 'error: tla2tools.jar not found in ' + _runtimeMs + 'ms',
        requirement_ids: getRequirementIds(CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase())),
        metadata: { config: configName }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }

  // ── 4. Invoke TLC ──────────────────────────────────────────────────────────
  // Map config names to their corresponding spec files.
  // Static map for known exceptions; auto-discovery handles the rest.
  const SPEC_MAP = {
    'MCMCPEnv':              'QGSDMCPEnv.tla',
    'MCsafety':              'NFQuorum.tla',
    'MCliveness':            'NFQuorum.tla',
    'MCNFQuorum':          'NFQuorum_xstate.tla',
    'MCrecruiting-liveness': 'NFRecruiting.tla',
    'MCrecruiting-safety':   'NFRecruiting.tla',
    'MCTUINavigation':       'TUINavigation.tla',
    'MCsolve-report-only':   'NFSolveOrchestrator.tla',
  };

  // Auto-discover spec file: (1) check SPEC_MAP, (2) scan cfg header for nForma*.tla ref,
  // (3) try naming conventions, (4) fall back to NFQuorum.tla
  function resolveSpecFile(cfgName) {
    if (SPEC_MAP[cfgName]) return SPEC_MAP[cfgName];

    const tlaDir = path.join(ROOT, '.planning', 'formal', 'tla');

    // Strategy 1: read cfg header for any .tla file reference (NF*, QGSD*, TUI*, etc.)
    try {
      const cfgContent = fs.readFileSync(path.join(tlaDir, cfgName + '.cfg'), 'utf8');
      const headerLines = cfgContent.split('\n').slice(0, 10).join('\n');
      // Match any word*.tla reference in the header (e.g., QGSDStopHook.tla, NFQuorum.tla)
      const refMatch = headerLines.match(/\b([A-Z]\w+)\.tla\b/);
      if (refMatch) {
        const candidate = refMatch[1] + '.tla';
        if (fs.existsSync(path.join(tlaDir, candidate))) return candidate;
      }
      // Also match "for ModuleName" pattern without .tla suffix (e.g., "model for QGSDKeyManagement.")
      const forMatch = headerLines.match(/\bfor\s+([A-Z]\w+)/);
      if (forMatch) {
        const candidate = forMatch[1] + '.tla';
        if (fs.existsSync(path.join(tlaDir, candidate))) return candidate;
      }
    } catch (_) { /* fall through */ }

    // Strategy 2: naming convention — strip MC prefix, search NF*, QGSD*, and bare names
    const stripped = cfgName.replace(/^MC/, '').toLowerCase().replace(/-/g, '');
    try {
      const allTla = fs.readdirSync(tlaDir).filter(f => f.endsWith('.tla') && !f.includes('TTrace'));
      const normalize = (s) => s.toLowerCase().replace(/-/g, '');
      // 2a: NF-prefixed files (exact then fuzzy)
      const nfFiles = allTla.filter(f => f.startsWith('NF'));
      const nfMatch = nfFiles.find(f => normalize(f.replace('NF', '').replace('.tla', '')) === stripped);
      if (nfMatch) return nfMatch;
      const nfFuzzy = nfFiles.find(f => normalize(f).includes(stripped));
      if (nfFuzzy) return nfFuzzy;
      // 2b: QGSD-prefixed files (exact then fuzzy)
      const qnfFiles = allTla.filter(f => f.startsWith('QNF'));
      const qnfMatch = qnfFiles.find(f => normalize(f.replace('QNF', '').replace('.tla', '')) === stripped);
      if (qnfMatch) return qnfMatch;
      const qnfFuzzy = qnfFiles.find(f => normalize(f).includes(stripped));
      if (qnfFuzzy) return qnfFuzzy;
      // 2c: Non-prefixed files (exact match on stripped name)
      const nonPrefixed = allTla.find(f => normalize(f.replace('.tla', '')) === stripped);
      if (nonPrefixed) return nonPrefixed;
    } catch (_) { /* fall through */ }

    return 'NFQuorum.tla';
  }

  const specFile = resolveSpecFile(configName);
  const specPath = path.join(ROOT, '.planning', 'formal', 'tla', specFile);
  const cfgPath  = path.join(ROOT, '.planning', 'formal', 'tla', configName + '.cfg');
  // Use -workers 1 for liveness (defensive — avoids known multi-worker liveness bugs in older TLC)
  const workers  = configName === 'MCliveness' ? '1' : TLC_WORKERS;

  process.stdout.write('[run-tlc] Config: ' + configName + '  Workers: ' + workers + '\n');
  process.stdout.write('[run-tlc] Spec:   ' + specPath + '\n');
  process.stdout.write('[run-tlc] Cfg:    ' + cfgPath + '\n');

  // ── State-space preflight guard ────────────────────────────────────────────
  if (!process.env.NF_SKIP_STATE_SPACE_GUARD) {
    try {
      const { analyzeModel } = require('./analyze-state-space.cjs');
      const analysis = analyzeModel(configName, ROOT);
      if (analysis && analysis.risk_level === 'HIGH') {
        const check_id = CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase());
        const surface = SURFACE_MAP[configName] || 'tla';
        const property = PROPERTY_MAP[configName] || configName;
        process.stderr.write('[run-tlc] BLOCKED: ' + configName + ' estimated ' +
          (analysis.estimated_states || 'unbounded') + ' states (HIGH risk). ' +
          'Set NF_SKIP_STATE_SPACE_GUARD=1 to override.\n');
        try {
          writeCheckResult({
            tool: 'run-tlc',
            formalism: 'tla',
            result: 'error',
            check_id: check_id,
            surface: surface,
            property: property,
            runtime_ms: 0,
            summary: 'error: state-space guard blocked ' + configName + ' (HIGH risk, ~' + analysis.estimated_states + ' states)',
            requirement_ids: getRequirementIds(check_id),
            triage_tags: ['state-space-blocked'],
            metadata: { config: configName, estimated_states: analysis.estimated_states, risk: 'HIGH' }
          });
        } catch (e) {
          process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
        }
        process.exit(1);
      }
    } catch (e) {
      // Fail-open: if analysis fails, proceed with TLC launch
      process.stderr.write('[run-tlc] State-space guard skipped: ' + e.message + '\n');
    }
  }

  const _startMs = Date.now();
  // Use per-config metadir to prevent cross-check interference in sequential pipeline runs
  const metaDir = path.join(ROOT, '.planning', 'formal', 'tla', 'states', configName);
  fs.rmSync(metaDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });

  process.stderr.write('[heap] Xms=64m Xmx=' + JAVA_HEAP_MAX + '\n');
  const tlcResult = spawnSync(javaExe, [
    '-Xms64m', '-Xmx' + JAVA_HEAP_MAX,
    '-jar', jarPath,
    '-metadir', metaDir,
    '-config', cfgPath,
    '-workers', workers,
    specPath,
  ], { encoding: 'utf8', stdio: 'inherit', timeout: TLC_TIMEOUT_MS });
  const _runtimeMs = Date.now() - _startMs;

  if (tlcResult.signal === 'SIGTERM') {
    process.stderr.write('[run-tlc] TLC killed after ' + TLC_TIMEOUT_MS + 'ms timeout\n');
    const check_id = CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase());
    const property = PROPERTY_MAP[configName] || configName;
    try {
      writeCheckResult({
        tool: 'run-tlc', formalism: 'tla', result: 'error',
        check_id, surface: 'tla', property,
        runtime_ms: _runtimeMs,
        summary: 'timeout: TLC killed after ' + (TLC_TIMEOUT_MS/1000) + 's',
        requirement_ids: getRequirementIds(check_id),
        triage_tags: ['timeout-killed'],
        metadata: { config: configName, timeout_ms: TLC_TIMEOUT_MS }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }

  if (tlcResult.error) {
    process.stderr.write('[run-tlc] TLC invocation failed: ' + tlcResult.error.message + '\n');
    const check_id = CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase());
    const property = PROPERTY_MAP[configName] || configName;
    try {
      writeCheckResult({
        tool: 'run-tlc',
        formalism: 'tla',
        result: 'error',
        check_id: check_id,
        surface: 'tla',
        property: property,
        runtime_ms: _runtimeMs,
        summary: 'error: TLC invocation failed in ' + _runtimeMs + 'ms',
        requirement_ids: getRequirementIds(check_id),
        metadata: { config: configName }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }

  const passed = (tlcResult.status || 0) === 0;

  const check_id = CHECK_ID_MAP[configName] || ('tla:' + configName.toLowerCase());
  const property = PROPERTY_MAP[configName] || configName;
  const triage_tags = _runtimeMs > 120000 ? ['timeout-risk'] : [];

  if (passed) {
    const missingDeclarations = detectLivenessProperties(configName, cfgPath);
    if (missingDeclarations.length > 0) {
      try {
        writeCheckResult({
          tool: 'run-tlc',
          formalism: 'tla',
          result: 'inconclusive',
          check_id: check_id,
          surface: 'tla',
          property: property,
          runtime_ms: _runtimeMs,
          summary: 'inconclusive: fairness missing in ' + _runtimeMs + 'ms',
          triage_tags: ['needs-fairness'],
          requirement_ids: getRequirementIds(check_id),
          metadata: {
            config: configName,
            reason: 'Fairness declaration missing for: ' + missingDeclarations.join(', '),
          }
        });
      } catch (e) {
        process.stderr.write('[run-tlc] Warning: failed to write inconclusive result: ' + e.message + '\n');
      }
      process.stdout.write('[run-tlc] Result: inconclusive — fairness declaration missing for: ' + missingDeclarations.join(', ') + '\n');
      process.exit(0); // inconclusive is not a failure
    } else {
      try {
        writeCheckResult({
          tool: 'run-tlc',
          formalism: 'tla',
          result: 'pass',
          check_id: check_id,
          surface: 'tla',
          property: property,
          runtime_ms: _runtimeMs,
          summary: 'pass: ' + configName + ' in ' + _runtimeMs + 'ms',
          triage_tags: triage_tags,
          requirement_ids: getRequirementIds(check_id),
          metadata: { config: configName, verification_mode: verificationMode }
        });
      } catch (e) {
        process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
      }
      process.exit(0);
    }
  } else {
    try {
      writeCheckResult({
        tool: 'run-tlc',
        formalism: 'tla',
        result: 'fail',
        check_id: check_id,
        surface: 'tla',
        property: property,
        runtime_ms: _runtimeMs,
        summary: 'fail: ' + configName + ' in ' + _runtimeMs + 'ms',
        triage_tags: triage_tags,
        requirement_ids: getRequirementIds(check_id),
        metadata: { config: configName }
      });
    } catch (e) {
      process.stderr.write('[run-tlc] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(tlcResult.status || 0);
  }
}

// Export for testing — safe because main execution is guarded by require.main === module
module.exports = { detectLivenessProperties };
