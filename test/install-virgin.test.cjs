'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const CLI_SCRIPT = path.join(__dirname, '..', 'bin', 'nforma-cli.js');
const PKG = require('../package.json');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively count files with the given extension under dir.
 */
function countFiles(dir, ext) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(full, ext);
    } else if (entry.name.endsWith(ext)) {
      count++;
    }
  }
  return count;
}

/**
 * Return file content or null if path doesn't exist.
 */
function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Count all files recursively under dir (any extension).
 */
function countAllFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countAllFiles(full);
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Run the installer for a given runtime into a temp directory.
 */
function runInstall(tmpDir, runtime) {
  return execFileSync(process.execPath, [
    INSTALL_SCRIPT,
    `--${runtime}`,
    '--global',
    '--config-dir', tmpDir,
  ], {
    stdio: 'pipe',
    timeout: 30000,
    env: {
      ...process.env,
      // Prevent any env var overrides from affecting test
      CLAUDE_CONFIG_DIR: undefined,
      GEMINI_CONFIG_DIR: undefined,
      OPENCODE_CONFIG_DIR: undefined,
      OPENCODE_CONFIG: undefined,
      XDG_CONFIG_HOME: undefined,
      // Skip heavy network installs (River ML, @huggingface/transformers) to avoid CI timeouts
      NF_INSTALL_SKIP_OPTIONAL: '1',
    },
  });
}

// ── Claude Runtime ──────────────────────────────────────────────────────────

describe('virgin install: claude', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-install-test-'));
    runInstall(tmpDir, 'claude');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── File layout ───────────────────────────────────────────────────────

  test('nf/ directory contains .md workflow files', () => {
    const nfDir = path.join(tmpDir, 'nf');
    assert.ok(fs.existsSync(nfDir), 'nf/ directory must exist');
    assert.ok(countFiles(nfDir, '.md') > 0, 'nf/ must contain .md files');
  });

  test('nf/VERSION contains package version', () => {
    const content = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));
    assert.ok(content, 'VERSION file must exist');
    assert.equal(content.trim(), PKG.version);
    assert.ok(content.endsWith('\n'), 'VERSION must end with a trailing newline (else reads concatenate to e.g. 0.41.10LOCAL)');
  });

  test('nf-bin/ directory contains .cjs scripts', () => {
    const binDir = path.join(tmpDir, 'nf-bin');
    assert.ok(fs.existsSync(binDir), 'nf-bin/ directory must exist');
    assert.ok(countFiles(binDir, '.cjs') > 0, 'nf-bin/ must contain .cjs files');
  });

  test('hooks/ directory contains required .js hook files', () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    assert.ok(fs.existsSync(hooksDir), 'hooks/ directory must exist');
    const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js'));
    assert.ok(hookFiles.length > 0, 'hooks/ must contain .js files');
    // Required hooks
    for (const required of ['nf-stop.js', 'nf-prompt.js', 'nf-circuit-breaker.js']) {
      assert.ok(hookFiles.includes(required), `hooks/ must contain ${required}`);
    }
  });

  test('agents/ directory contains .md agent files', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    assert.ok(countFiles(agentsDir, '.md') > 0, 'agents/ must contain .md files');
  });

  test('nf.json exists and is valid JSON', () => {
    const content = readIfExists(path.join(tmpDir, 'nf.json'));
    assert.ok(content, 'nf.json must exist');
    const parsed = JSON.parse(content);
    assert.equal(typeof parsed, 'object');
  });

  test('settings.json exists and has hooks configured', () => {
    const content = readIfExists(path.join(tmpDir, 'settings.json'));
    assert.ok(content, 'settings.json must exist');
    const parsed = JSON.parse(content);
    assert.ok(parsed.hooks, 'settings.json must have hooks key');
  });

  test('nf-session-start survives the OLD_HOOK_MAP migration (registered in SessionStart)', () => {
    // Regression: nf-session-start was registered before the migration AND listed
    // in OLD_HOOK_MAP.SessionStart, so it was stripped on every install — silently
    // disabling SessionStart (incl. #272's post-compaction continuation injection).
    const content = readIfExists(path.join(tmpDir, 'settings.json'));
    assert.ok(content, 'settings.json must exist');
    const parsed = JSON.parse(content);
    const ssCommands = (parsed.hooks.SessionStart || [])
      .flatMap(g => (g.hooks || []).map(h => h.command || ''));
    assert.ok(
      ssCommands.some(c => c.includes('nf-session-start')),
      'nf-session-start must remain registered in SessionStart after install'
    );
  });

  test('package.json exists with CommonJS type', () => {
    const content = readIfExists(path.join(tmpDir, 'package.json'));
    assert.ok(content, 'package.json must exist');
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, 'commonjs');
  });

  test('commands/nf/ directory exists with .md files', () => {
    const commandsDir = path.join(tmpDir, 'commands', 'nf');
    assert.ok(fs.existsSync(commandsDir), 'commands/nf/ must exist');
    assert.ok(countFiles(commandsDir, '.md') > 0, 'commands/nf/ must contain .md files');
  });

  // ── Content adaptation ────────────────────────────────────────────────

  test('config-loader contains .claude path references', () => {
    const content = readIfExists(path.join(tmpDir, 'hooks', 'config-loader.js'));
    assert.ok(content, 'config-loader.js must be readable');
    assert.ok(content.includes("'.claude'"), "Claude config-loader must reference '.claude'");
  });

  // ── Idempotency ───────────────────────────────────────────────────────

  test('re-install produces identical layout (OverridesPreserved)', () => {
    const countBefore = countAllFiles(tmpDir);
    const versionBefore = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));

    // Run install again into same dir
    runInstall(tmpDir, 'claude');

    const countAfter = countAllFiles(tmpDir);
    const versionAfter = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));

    assert.equal(countBefore, countAfter, 'File count must be identical after re-install');
    assert.equal(versionBefore, versionAfter, 'VERSION must be identical after re-install');
  });
});

// ── OpenCode Runtime ────────────────────────────────────────────────────────

describe('virgin install: opencode', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-install-test-'));
    runInstall(tmpDir, 'opencode');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── File layout ───────────────────────────────────────────────────────

  test('nf/ directory contains .md workflow files', () => {
    const nfDir = path.join(tmpDir, 'nf');
    assert.ok(fs.existsSync(nfDir), 'nf/ directory must exist');
    assert.ok(countFiles(nfDir, '.md') > 0, 'nf/ must contain .md files');
  });

  test('nf/VERSION contains package version', () => {
    const content = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));
    assert.ok(content, 'VERSION file must exist');
    assert.equal(content.trim(), PKG.version);
    assert.ok(content.endsWith('\n'), 'VERSION must end with a trailing newline (else reads concatenate to e.g. 0.41.10LOCAL)');
  });

  test('nf-bin/ directory contains .cjs scripts', () => {
    const binDir = path.join(tmpDir, 'nf-bin');
    assert.ok(fs.existsSync(binDir), 'nf-bin/ directory must exist');
    assert.ok(countFiles(binDir, '.cjs') > 0, 'nf-bin/ must contain .cjs files');
  });

  test('hooks/ directory contains required .js hook files', () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    assert.ok(fs.existsSync(hooksDir), 'hooks/ directory must exist');
    const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js'));
    assert.ok(hookFiles.length > 0, 'hooks/ must contain .js files');
    for (const required of ['nf-stop.js', 'nf-prompt.js', 'nf-circuit-breaker.js']) {
      assert.ok(hookFiles.includes(required), `hooks/ must contain ${required}`);
    }
  });

  test('agents/ directory contains .md agent files', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    assert.ok(countFiles(agentsDir, '.md') > 0, 'agents/ must contain .md files');
  });

  test('package.json exists with CommonJS type', () => {
    const content = readIfExists(path.join(tmpDir, 'package.json'));
    assert.ok(content, 'package.json must exist');
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, 'commonjs');
  });

  test('command/ directory exists with nf-*.md files (flat structure)', () => {
    const commandDir = path.join(tmpDir, 'command');
    assert.ok(fs.existsSync(commandDir), 'command/ must exist for OpenCode');
    const nfFiles = fs.readdirSync(commandDir).filter(f => f.startsWith('nf-') && f.endsWith('.md'));
    assert.ok(nfFiles.length > 0, 'command/ must contain nf-*.md files');
  });

  // ── Content adaptation ────────────────────────────────────────────────

  test('config-loader contains opencode config path references', () => {
    const content = readIfExists(path.join(tmpDir, 'hooks', 'config-loader.js'));
    assert.ok(content, 'config-loader.js must be readable');
    assert.ok(
      content.includes("'.config', 'opencode'"),
      "OpenCode config-loader must reference '.config', 'opencode'"
    );
  });

  test('command files use /nf- prefix (OpenCode flat structure)', () => {
    const commandDir = path.join(tmpDir, 'command');
    const files = fs.readdirSync(commandDir).filter(f => f.startsWith('nf-') && f.endsWith('.md'));
    assert.ok(files.length > 0, 'Need at least one command file to test');
    // Verify /nf: has been converted to /nf- in content
    let foundSlashConversion = false;
    for (const file of files) {
      const content = fs.readFileSync(path.join(commandDir, file), 'utf8');
      if (content.includes('/nf-')) foundSlashConversion = true;
      // Must NOT have /nf: references (should be converted to /nf-)
      assert.ok(!content.includes('/nf:'), `${file} must not contain /nf: references (should be /nf-)`);
    }
    assert.ok(foundSlashConversion, 'At least one command file must contain /nf- references');
  });

  test('agent files use OpenCode tool name conversions', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    assert.ok(files.length > 0, 'Need at least one agent file to test');
    // Verify /nf: has been converted to /nf- and path prefix uses tmpDir
    let foundPathPrefix = false;
    for (const file of files) {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      // Must NOT have /nf: references (should be converted to /nf-)
      assert.ok(!content.includes('/nf:'), `Agent ${file} must not contain /nf: references`);
      // Path prefix should use tmpDir (from --config-dir)
      if (content.includes(tmpDir)) foundPathPrefix = true;
    }
    assert.ok(foundPathPrefix, 'At least one agent file must use --config-dir path prefix');
  });

  // ── Idempotency ───────────────────────────────────────────────────────

  test('re-install produces identical layout (OverridesPreserved)', () => {
    const countBefore = countAllFiles(tmpDir);
    const versionBefore = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));

    runInstall(tmpDir, 'opencode');

    const countAfter = countAllFiles(tmpDir);
    const versionAfter = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));

    assert.equal(countBefore, countAfter, 'File count must be identical after re-install');
    assert.equal(versionBefore, versionAfter, 'VERSION must be identical after re-install');
  });
});

// ── Gemini Runtime ──────────────────────────────────────────────────────────

describe('virgin install: gemini', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-install-test-'));
    runInstall(tmpDir, 'gemini');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── File layout ───────────────────────────────────────────────────────

  test('nf/ directory contains .md workflow files', () => {
    const nfDir = path.join(tmpDir, 'nf');
    assert.ok(fs.existsSync(nfDir), 'nf/ directory must exist');
    assert.ok(countFiles(nfDir, '.md') > 0, 'nf/ must contain .md files');
  });

  test('nf/VERSION contains package version', () => {
    const content = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));
    assert.ok(content, 'VERSION file must exist');
    assert.equal(content.trim(), PKG.version);
    assert.ok(content.endsWith('\n'), 'VERSION must end with a trailing newline (else reads concatenate to e.g. 0.41.10LOCAL)');
  });

  test('nf-bin/ directory contains .cjs scripts', () => {
    const binDir = path.join(tmpDir, 'nf-bin');
    assert.ok(fs.existsSync(binDir), 'nf-bin/ directory must exist');
    assert.ok(countFiles(binDir, '.cjs') > 0, 'nf-bin/ must contain .cjs files');
  });

  test('hooks/ directory contains required .js hook files', () => {
    const hooksDir = path.join(tmpDir, 'hooks');
    assert.ok(fs.existsSync(hooksDir), 'hooks/ directory must exist');
    const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js'));
    assert.ok(hookFiles.length > 0, 'hooks/ must contain .js files');
    for (const required of ['nf-stop.js', 'nf-prompt.js', 'nf-circuit-breaker.js']) {
      assert.ok(hookFiles.includes(required), `hooks/ must contain ${required}`);
    }
  });

  test('agents/ directory contains .md agent files', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    assert.ok(countFiles(agentsDir, '.md') > 0, 'agents/ must contain .md files');
  });

  test('settings.json exists and has hooks configured', () => {
    const content = readIfExists(path.join(tmpDir, 'settings.json'));
    assert.ok(content, 'settings.json must exist');
    const parsed = JSON.parse(content);
    assert.ok(parsed.hooks, 'settings.json must have hooks key');
  });

  test('package.json exists with CommonJS type', () => {
    const content = readIfExists(path.join(tmpDir, 'package.json'));
    assert.ok(content, 'package.json must exist');
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, 'commonjs');
  });

  test('commands/nf/ directory exists with .toml command files', () => {
    const commandsDir = path.join(tmpDir, 'commands', 'nf');
    assert.ok(fs.existsSync(commandsDir), 'commands/nf/ must exist');
    assert.ok(countFiles(commandsDir, '.toml') > 0, 'commands/nf/ must contain .toml files (Gemini TOML format)');
  });

  // ── Content adaptation ────────────────────────────────────────────────

  test('config-loader contains .gemini path references', () => {
    const content = readIfExists(path.join(tmpDir, 'hooks', 'config-loader.js'));
    assert.ok(content, 'config-loader.js must be readable');
    assert.ok(content.includes("'.gemini'"), "Gemini config-loader must reference '.gemini'");
  });

  // ── Idempotency ───────────────────────────────────────────────────────

  test('re-install produces identical layout (OverridesPreserved)', () => {
    const countBefore = countAllFiles(tmpDir);
    const versionBefore = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));

    runInstall(tmpDir, 'gemini');

    const countAfter = countAllFiles(tmpDir);
    const versionAfter = readIfExists(path.join(tmpDir, 'nf', 'VERSION'));

    assert.equal(countBefore, countAfter, 'File count must be identical after re-install');
    assert.equal(versionBefore, versionAfter, 'VERSION must be identical after re-install');
  });
});

// ── npm pack + global install simulation ────────────────────────────────────

describe('virgin install: npm global simulation', () => {
  let tmpDir;
  let binDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-npm-global-test-'));
    binDir = path.join(tmpDir, 'bin');

    // Pack the package to a tarball (simulates what npm registry serves)
    const repoRoot = path.join(__dirname, '..');
    const packOut = execFileSync('npm', ['pack', '--pack-destination', tmpDir], {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 30000,
    }).toString().trim();
    const tarball = path.join(tmpDir, packOut.split('\n').pop());

    // Install globally into isolated prefix (like npm install -g on a virgin machine)
    execFileSync('npm', [
      'install', '-g', tarball,
      '--prefix', tmpDir,
      '--ignore-scripts',  // skip postinstall (no blessed/node-pty needed for routing test)
    ], {
      stdio: 'pipe',
      timeout: 60000,
      env: {
        ...process.env,
        npm_config_prefix: tmpDir,
      },
    });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nforma symlink exists in bin/', () => {
    const nformaBin = path.join(binDir, 'nforma');
    assert.ok(fs.existsSync(nformaBin), 'nforma must exist in bin/ after npm install -g');
  });

  test('get-shit-done-cc symlink exists in bin/ (legacy)', () => {
    const legacyBin = path.join(binDir, 'get-shit-done-cc');
    assert.ok(fs.existsSync(legacyBin), 'get-shit-done-cc must exist in bin/ (legacy compat)');
  });

  test('nforma --version works from installed binary', () => {
    const nformaBin = path.join(binDir, 'nforma');
    const out = execFileSync(process.execPath, [nformaBin, '--version'], {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    assert.equal(out, PKG.version, 'installed nforma --version must match package version');
  });

  test('nforma --help works from installed binary', () => {
    const nformaBin = path.join(binDir, 'nforma');
    const out = execFileSync(process.execPath, [nformaBin, '--help'], {
      stdio: 'pipe',
      timeout: 5000,
    }).toString().trim();
    assert.ok(out.includes('Usage:'), 'installed nforma --help must show Usage');
    assert.ok(out.includes('install'), 'must mention install subcommand');
    assert.ok(out.includes('TUI'), 'must mention TUI');
  });

  test('nforma install --help works from installed binary', () => {
    const nformaBin = path.join(binDir, 'nforma');
    try {
      const out = execFileSync(process.execPath, [nformaBin, 'install', '--help'], {
        stdio: 'pipe',
        timeout: 10000,
      }).toString().trim();
      assert.ok(out.length > 0, 'install --help must produce output');
    } catch (e) {
      // Some help implementations exit non-zero — still valid if output exists
      const stdout = (e.stdout || '').toString();
      const stderr = (e.stderr || '').toString();
      assert.ok(
        stdout.length > 0 || stderr.length > 0,
        'install --help must produce output even on non-zero exit'
      );
    }
  });

  test('installed package includes bin/nforma-cli.js', () => {
    const libPkg = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'nforma-cli.js');
    assert.ok(fs.existsSync(libPkg), 'nforma-cli.js must be included in published package');
  });

  test('installed package includes bin/install.js', () => {
    const libPkg = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'install.js');
    assert.ok(fs.existsSync(libPkg), 'install.js must be included in published package');
  });

  test('installed package includes bin/nForma.cjs (TUI)', () => {
    const libPkg = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'nForma.cjs');
    assert.ok(fs.existsSync(libPkg), 'nForma.cjs must be included in published package');
  });

  // ── Source directories required by install.js ──────────────────────
  // install.js copies from these source dirs — if any are missing from
  // the npm tarball, install crashes with ENOENT on readdirSync.

  test('installed package includes core/ directory (workflows, references, templates)', () => {
    const coreDir = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'core');
    assert.ok(fs.existsSync(coreDir), 'core/ must be included in published package (install.js line 1840 reads from it)');
    assert.ok(countFiles(coreDir, '.md') > 0, 'core/ must contain .md workflow files');
  });

  test('installed package includes commands/nf/ directory', () => {
    const commandsDir = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'commands', 'nf');
    assert.ok(fs.existsSync(commandsDir), 'commands/nf/ must be included in published package');
    assert.ok(countFiles(commandsDir, '.md') > 0, 'commands/nf/ must contain .md command files');
  });

  test('installed package includes agents/ directory', () => {
    const agentsDir = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ must be included in published package');
    assert.ok(countFiles(agentsDir, '.md') > 0, 'agents/ must contain .md agent files');
  });

  test('installed package includes hooks/dist/ directory', () => {
    const hooksDir = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'hooks', 'dist');
    assert.ok(fs.existsSync(hooksDir), 'hooks/dist/ must be included in published package');
    assert.ok(countFiles(hooksDir, '.js') > 0, 'hooks/dist/ must contain .js hook files');
  });

  test('all install.js source directories exist in package', () => {
    const pkgRoot = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma');
    // These are the dirs install.js reads from via path.join(src, ...)
    const requiredDirs = ['commands/nf', 'core', 'agents', 'hooks/dist', 'bin'];
    for (const dir of requiredDirs) {
      assert.ok(
        fs.existsSync(path.join(pkgRoot, dir)),
        `${dir}/ must be in published package — install.js reads from it`
      );
    }
  });

  // ── TUI smoke: --screenshot from installed package ──────────────────
  // The --screenshot mode renders static ANSI without blessed, so it
  // validates that all require() paths resolve from the installed location.

  test('TUI --screenshot agents runs without crash from installed package', () => {
    const tuiScript = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'nForma.cjs');
    const out = execFileSync(process.execPath, [tuiScript, '--screenshot', 'agents'], {
      stdio: 'pipe',
      timeout: 10000,
    }).toString();
    assert.ok(out.includes('nForma'), 'screenshot output must contain nForma branding');
    assert.ok(out.includes('Agent'), 'screenshot output must contain Agent module hint');
  });

  test('TUI --screenshot reqs runs without crash from installed package', () => {
    const tuiScript = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'nForma.cjs');
    const out = execFileSync(process.execPath, [tuiScript, '--screenshot', 'reqs'], {
      stdio: 'pipe',
      timeout: 10000,
    }).toString();
    assert.ok(out.includes('Requirements'), 'screenshot output must contain Requirements heading');
    assert.ok(out.includes('Principle'), 'screenshot output must contain Principle column');
  });

  test('TUI --screenshot config runs without crash from installed package', () => {
    const tuiScript = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'nForma.cjs');
    const out = execFileSync(process.execPath, [tuiScript, '--screenshot', 'config'], {
      stdio: 'pipe',
      timeout: 10000,
    }).toString();
    assert.ok(out.includes('Configuration'), 'screenshot output must contain Configuration heading');
  });

  test('TUI --screenshot sessions runs without crash from installed package', () => {
    const tuiScript = path.join(tmpDir, 'lib', 'node_modules', '@nforma.ai', 'nforma', 'bin', 'nForma.cjs');
    const out = execFileSync(process.execPath, [tuiScript, '--screenshot', 'sessions'], {
      stdio: 'pipe',
      timeout: 10000,
    }).toString();
    assert.ok(out.includes('Session'), 'screenshot output must contain Session heading');
  });
});

// ── TUI data loading: real requirements.json ─────────────────────────────────
// Validates that requirements-core.cjs can load real project data.
// This catches regressions where the data file schema changes or paths break.
//
// NOTE: .planning/formal/requirements.json is a LOCAL DEV FILE not included in
// the npm package. These tests require local project context and must be
// skipped when running as part of virgin install tests (where only the
// installed package exists, not the full dev tree).

const REQ_JSON_PATH = path.join(__dirname, '..', '.planning', 'formal', 'requirements.json');
const hasLocalRequirements = fs.existsSync(REQ_JSON_PATH);

describe('TUI data loading: requirements', { skip: !hasLocalRequirements }, () => {
  test('readRequirementsJson returns non-empty requirements array', () => {
    const reqCore = require('../bin/requirements-core.cjs');
    const { envelope, requirements } = reqCore.readRequirementsJson();
    assert.ok(requirements.length > 0, `requirements must be non-empty, got ${requirements.length}`);
    assert.ok(envelope, 'envelope must exist');
  });

  test('every requirement has id, text, category, and status', () => {
    const reqCore = require('../bin/requirements-core.cjs');
    const { requirements } = reqCore.readRequirementsJson();
    for (const r of requirements) {
      assert.ok(r.id, `requirement must have id: ${JSON.stringify(r).slice(0, 80)}`);
      assert.ok(r.text, `requirement ${r.id} must have text`);
      assert.ok(r.category, `requirement ${r.id} must have category`);
      assert.ok(r.status, `requirement ${r.id} must have status`);
    }
  });

  test('computeCoverage produces valid stats', () => {
    const reqCore = require('../bin/requirements-core.cjs');
    const { requirements } = reqCore.readRequirementsJson();
    const registry = reqCore.readModelRegistry();
    const checkResults = reqCore.readCheckResults();
    const cov = reqCore.computeCoverage(requirements, registry, checkResults);
    assert.ok(cov.total > 0, 'total must be > 0');
    assert.ok(cov.byStatus, 'byStatus must exist');
    assert.ok(cov.byCategory, 'byCategory must exist');
    assert.equal(cov.total, requirements.length, 'total must match requirements count');
  });

  test('requirement IDs follow expected format (PREFIX-NN)', () => {
    const reqCore = require('../bin/requirements-core.cjs');
    const { requirements } = reqCore.readRequirementsJson();
    const idPattern = /^[A-Z]{1,10}(-[A-Z0-9]+)*-\d{1,4}$/;
    const invalid = requirements.filter(r => !idPattern.test(r.id));
    assert.equal(invalid.length, 0,
      `all IDs must match PREFIX-NN format, invalid: ${invalid.map(r => r.id).join(', ')}`);
  });
});
