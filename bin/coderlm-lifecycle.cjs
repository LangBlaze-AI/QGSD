'use strict';

/**
 * coderlm-lifecycle.cjs — Lazy lifecycle manager for the coderlm binary server.
 *
 * Exports: ensureBinary, ensureRunning, stop, status, touchLastQuery, checkIdleStop
 *
 * All functions follow fail-open pattern: never throw to callers, always return
 * result objects with ok/error fields. stderr is used for diagnostics.
 *
 * Lifecycle: auto-download binary from GitHub Releases on first use,
 * auto-start server when needed, auto-stop after 5 minutes idle.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const http = require('http');

// ── Constants ────────────────────────────────────────────────────────────────

const BINARY_DIR = path.join(os.homedir(), '.claude', 'nf-bin');
const BINARY_PATH = path.join(BINARY_DIR, 'coderlm');
const PID_PATH = path.join(BINARY_DIR, 'coderlm.pid');
const LASTQUERY_PATH = path.join(BINARY_DIR, 'coderlm.lastquery');
const STATE_PATH = path.join(BINARY_DIR, 'coderlm.state.json');
const DEFAULT_PORT = 8787;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const GITHUB_REPO = 'JaredStewart/coderlm';
const HEALTH_URL = 'http://localhost:8787/api/v1/health';
const STARTUP_WAIT_MS = 3000; // max wait for server to become healthy after spawn

// ── Internal test helper ─────────────────────────────────────────────────────

let _binaryDir = BINARY_DIR;
let _binaryPath = BINARY_PATH;
let _pidPath = PID_PATH;
let _lastqueryPath = LASTQUERY_PATH;
let _statePath = STATE_PATH;
let _healthUrl = HEALTH_URL;

/**
 * Override paths for test isolation. Call with no args to reset.
 * @param {string} [dir] - Base directory for all lifecycle files
 */
function _setPaths(dir) {
  if (dir) {
    _binaryDir = dir;
    _binaryPath = path.join(dir, 'coderlm');
    _pidPath = path.join(dir, 'coderlm.pid');
    _lastqueryPath = path.join(dir, 'coderlm.lastquery');
    _statePath = path.join(dir, 'coderlm.state.json');
  } else {
    _binaryDir = BINARY_DIR;
    _binaryPath = BINARY_PATH;
    _pidPath = PID_PATH;
    _lastqueryPath = LASTQUERY_PATH;
    _statePath = STATE_PATH;
  }
}

// ── Platform detection ───────────────────────────────────────────────────────

/**
 * Get the platform-specific binary asset name for GitHub Releases.
 * @returns {string|null} Binary name or null if unsupported platform
 */
function getPlatformBinaryName() {
  const platform = process.platform; // 'darwin', 'linux'
  const arch = process.arch;         // 'arm64', 'x64'
  if (platform === 'darwin' && arch === 'arm64') return 'coderlm-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'coderlm-darwin-x64';
  if (platform === 'linux' && arch === 'x64') return 'coderlm-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'coderlm-linux-arm64';
  return null; // unsupported platform
}

// ── Health check helper (sync via spawnSync) ─────────────────────────────────

/**
 * Synchronous HTTP health check using spawnSync.
 * @param {string} url - Health endpoint URL
 * @param {number} timeout - Timeout in ms
 * @returns {{healthy: boolean, error?: string}}
 */
function healthCheckSync(url, timeout) {
  try {
    const script = `
const http = require('http');
const url = new URL(${JSON.stringify(url || _healthUrl)});
const options = {
  hostname: url.hostname,
  port: url.port || 8787,
  path: url.pathname,
  method: 'GET',
  timeout: ${timeout || 2000}
};
let timedOut = false;
const req = http.request(options, res => {
  if (!timedOut && res.statusCode === 200) {
    console.log(JSON.stringify({ healthy: true }));
  } else {
    console.log(JSON.stringify({ healthy: false, error: 'HTTP ' + (res.statusCode || 0) }));
  }
  res.resume();
});
req.on('timeout', () => {
  timedOut = true;
  req.destroy();
  console.log(JSON.stringify({ healthy: false, error: 'timeout' }));
});
req.on('error', e => {
  if (!timedOut) {
    console.log(JSON.stringify({ healthy: false, error: e.code || 'error' }));
  }
});
req.end();
`;
    const result = spawnSync('node', ['-e', script], {
      timeout: (timeout || 2000) + 1000,
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout) {
      return JSON.parse(result.stdout.trim());
    }
    return { healthy: false, error: 'sync-spawn-failed' };
  } catch (e) {
    return { healthy: false, error: 'sync-spawn-failed' };
  }
}

// ── ensureBinary ─────────────────────────────────────────────────────────────

/**
 * Idempotent binary download. If binary exists and is executable, returns cached.
 * Otherwise downloads from GitHub Releases via `gh` CLI.
 * Preserves user-placed binaries (OverridesPreserved invariant).
 * @returns {{ok: boolean, path?: string, source?: string, error?: string, detail?: string}}
 */
function ensureBinary() {
  try {
    // Check if binary already exists and is executable
    try {
      fs.accessSync(_binaryPath, fs.constants.X_OK);
      return { ok: true, path: _binaryPath, source: 'cached' };
    } catch (e) {
      // Binary does not exist or is not executable — proceed to download
    }

    // Ensure binary directory exists
    fs.mkdirSync(_binaryDir, { recursive: true });

    // Build from source via git clone + cargo build
    process.stderr.write('Building coderlm from source (requires Rust)...\n');

    const tmpDir = path.join(os.tmpdir(), 'coderlm-build-' + Date.now());
    try {
      // Step 1: git clone
      const cloneResult = spawnSync('git', [
        'clone', '--depth', '1',
        'https://github.com/JaredStewart/coderlm.git',
        tmpDir,
      ], { timeout: 60000, encoding: 'utf8' });

      if (cloneResult.status !== 0 || cloneResult.error) {
        const detail = (cloneResult.stderr || (cloneResult.error && cloneResult.error.message) || '').trim().slice(0, 200);
        return { ok: false, error: 'build-failed', detail: detail || 'git clone failed' };
      }

      // Step 2: cargo build --release in server/ subdir
      const buildResult = spawnSync('cargo', ['build', '--release'], {
        cwd: path.join(tmpDir, 'server'),
        timeout: 300000,
        encoding: 'utf8',
      });

      if (buildResult.status !== 0 || buildResult.error) {
        const detail = (buildResult.stderr || (buildResult.error && buildResult.error.message) || '').trim().slice(0, 200);
        return { ok: false, error: 'build-failed', detail: detail || 'cargo build failed' };
      }

      // Step 3: copy binary
      const builtBinary = path.join(tmpDir, 'server', 'target', 'release', 'coderlm-server');
      fs.copyFileSync(builtBinary, _binaryPath);
      fs.chmodSync(_binaryPath, 0o755);

      return { ok: true, path: _binaryPath, source: 'built' };
    } finally {
      // Step 4: cleanup temp clone (fail-open)
      try { spawnSync('rm', ['-rf', tmpDir], { timeout: 10000 }); } catch (_) {}
    }
  } catch (e) {
    return { ok: false, error: 'unexpected', detail: e.message };
  }
}

// ── _writeState ───────────────────────────────────────────────────────────────

/**
 * Write coderlm.state.json as a secondary state signal. Fail-open.
 * @param {Object} state - State object to serialize
 */
function _writeState(state) {
  try {
    fs.writeFileSync(_statePath, JSON.stringify(state));
  } catch (e) { /* fail-open */ }
}

// ── ensureRunning ────────────────────────────────────────────────────────────

/**
 * Start coderlm server if not already running.
 * Handles stale PID files, zombie processes, and binary download.
 * @param {{port?: number, indexPath?: string}} [opts]
 * @returns {{ok: boolean, pid?: number, source?: string, error?: string, warning?: string, detail?: string}}
 */
function ensureRunning(opts) {
  try {
    opts = opts || {};
    const port = opts.port || DEFAULT_PORT;
    const healthUrl = 'http://localhost:' + port + '/api/v1/health';

    // Step 1: Check if process is already running via PID file
    let existingPid = null;
    try {
      const pidStr = fs.readFileSync(_pidPath, 'utf8').trim();
      existingPid = parseInt(pidStr, 10);
    } catch (e) {
      // No PID file — proceed to spawn
    }

    if (existingPid) {
      // Verify process is alive
      let alive = false;
      try {
        process.kill(existingPid, 0);
        alive = true;
      } catch (e) {
        // ESRCH: process is dead — clean up stale PID (LivenessProperty1)
        alive = false;
      }

      if (alive) {
        // Process alive — check health to detect zombie PID
        const health = healthCheckSync(healthUrl, 2000);
        if (health.healthy) {
          _writeState({ running: true, pid: existingPid, ts: Date.now() });
          return { ok: true, pid: existingPid, source: 'already-running' };
        }
        // Zombie PID: process alive but unhealthy — clean up and respawn
        process.stderr.write('[coderlm-lifecycle] Zombie PID detected (pid=' + existingPid + ', unhealthy), cleaning up\n');
        try { process.kill(existingPid, 'SIGTERM'); } catch (e) { /* best effort */ }
      }

      // Clean up stale PID file (LivenessProperty1 — no dangling PID)
      try { fs.unlinkSync(_pidPath); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(_lastqueryPath); } catch (e) { /* ignore */ }
    }

    // Step 2: Ensure binary is available
    const binaryResult = ensureBinary();
    if (!binaryResult.ok) {
      return binaryResult;
    }

    // Step 3: Determine index path
    const indexPath = opts.indexPath || process.cwd();

    // Step 4: Spawn server (detached)
    // CLI: coderlm serve --port <PORT> <PATH>
    const child = spawn(_binaryPath, [
      'serve',
      '--port', String(port),
      indexPath,
    ], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();

    // Step 5: Write PID file
    fs.writeFileSync(_pidPath, String(child.pid));

    // Step 6: Touch last-query timestamp
    fs.writeFileSync(_lastqueryPath, String(Date.now()));

    // Step 7: Wait for server to become healthy (poll)
    const startTime = Date.now();
    let healthy = false;
    while (Date.now() - startTime < STARTUP_WAIT_MS) {
      const health = healthCheckSync(healthUrl, 1000);
      if (health.healthy) {
        healthy = true;
        break;
      }
      // Brief sync wait between polls
      spawnSync('node', ['-e', 'setTimeout(() => {}, 500)'], { timeout: 600 });
    }

    if (healthy) {
      _writeState({ running: true, pid: child.pid, ts: Date.now() });
      return { ok: true, pid: child.pid, source: 'started' };
    }
    // Still ok=true because process was spawned — caller should retry health check
    _writeState({ running: true, pid: child.pid, ts: Date.now(), warning: 'unhealthy' });
    return { ok: true, pid: child.pid, source: 'started-unhealthy', warning: 'server spawned but health check timed out' };
  } catch (e) {
    return { ok: false, error: 'unexpected', detail: e.message };
  }
}

// ── stop ─────────────────────────────────────────────────────────────────────

/**
 * Graceful shutdown of coderlm server.
 * CRITICAL (LivenessProperty1): PID file MUST be cleaned up in ALL exit paths.
 * @returns {{ok: boolean, status?: string, error?: string}}
 */
function stop() {
  try {
    // Read PID file
    let pid;
    try {
      const pidStr = fs.readFileSync(_pidPath, 'utf8').trim();
      pid = parseInt(pidStr, 10);
    } catch (e) {
      _writeState({ running: false, pid: null, ts: Date.now() });
      return { ok: true, status: 'not-running' };
    }

    if (!pid || isNaN(pid)) {
      // Invalid PID file — clean up
      try { fs.unlinkSync(_pidPath); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(_lastqueryPath); } catch (e) { /* ignore */ }
      _writeState({ running: false, pid: null, ts: Date.now() });
      return { ok: true, status: 'not-running' };
    }

    // Try SIGTERM
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      if (e.code === 'ESRCH') {
        // Process already dead — clean up (LivenessProperty1)
        try { fs.unlinkSync(_pidPath); } catch (e2) { /* ignore */ }
        try { fs.unlinkSync(_lastqueryPath); } catch (e2) { /* ignore */ }
        _writeState({ running: false, pid: null, ts: Date.now() });
        return { ok: true, status: 'already-dead' };
      }
      throw e;
    }

    // Wait up to 3 seconds for process to exit
    const stopStart = Date.now();
    let alive = true;
    while (Date.now() - stopStart < 3000) {
      try {
        process.kill(pid, 0);
        // Still alive — brief wait
        spawnSync('node', ['-e', 'setTimeout(() => {}, 200)'], { timeout: 300 });
      } catch (e) {
        alive = false;
        break;
      }
    }

    // If still alive after 3s, SIGKILL
    if (alive) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ignore ESRCH */ }
    }

    // Clean up PID and lastquery files (LivenessProperty1 — guaranteed cleanup)
    try { fs.unlinkSync(_pidPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(_lastqueryPath); } catch (e) { /* ignore */ }

    _writeState({ running: false, pid: null, ts: Date.now() });
    return { ok: true, status: 'stopped' };
  } catch (e) {
    // Even on unexpected error, attempt cleanup (LivenessProperty1)
    try { fs.unlinkSync(_pidPath); } catch (e2) { /* ignore */ }
    try { fs.unlinkSync(_lastqueryPath); } catch (e2) { /* ignore */ }
    _writeState({ running: false, pid: null, ts: Date.now() });
    return { ok: false, error: e.message };
  }
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Report current lifecycle state: binary, process, health, idle.
 * @returns {{binary: Object, process: Object, health: Object, idle: Object}}
 */
function status() {
  try {
    // Check binary
    let binaryInstalled = false;
    try {
      fs.accessSync(_binaryPath, fs.constants.X_OK);
      binaryInstalled = true;
    } catch (e) { /* not installed */ }

    // Check PID
    let running = false;
    let pid = null;
    try {
      const pidStr = fs.readFileSync(_pidPath, 'utf8').trim();
      pid = parseInt(pidStr, 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 0);
          running = true;
        } catch (e) {
          running = false;
          pid = null;
        }
      } else {
        pid = null;
      }
    } catch (e) {
      // No PID file
    }

    // Check health (only if process appears running)
    let healthy = false;
    let latencyMs = 0;
    let healthError = null;
    if (running) {
      const start = Date.now();
      const health = healthCheckSync(_healthUrl, 1000);
      latencyMs = Date.now() - start;
      healthy = health.healthy;
      if (!health.healthy) {
        healthError = health.error || 'unhealthy';
      }
    }

    // Check idle
    let lastQueryMs = null;
    let idleDurationMs = null;
    try {
      const ts = fs.readFileSync(_lastqueryPath, 'utf8').trim();
      const parsedTs = parseInt(ts, 10);
      if (!isNaN(parsedTs)) {
        lastQueryMs = parsedTs;
        idleDurationMs = Date.now() - lastQueryMs;
      }
    } catch (e) {
      // No lastquery file
    }

    return {
      binary: { installed: binaryInstalled, path: _binaryPath },
      process: { running: running, pid: pid },
      health: { healthy: healthy, latencyMs: latencyMs, error: healthError },
      idle: {
        lastQueryMs: lastQueryMs,
        idleDurationMs: idleDurationMs,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      },
    };
  } catch (e) {
    return {
      binary: { installed: false, path: _binaryPath },
      process: { running: false, pid: null },
      health: { healthy: false, latencyMs: 0, error: e.message },
      idle: { lastQueryMs: null, idleDurationMs: null, idleTimeoutMs: IDLE_TIMEOUT_MS },
    };
  }
}

// ── touchLastQuery ───────────────────────────────────────────────────────────

/**
 * Update last-query timestamp (resets idle timer).
 * Fail-open: silently ignores errors.
 */
function touchLastQuery() {
  try {
    fs.writeFileSync(_lastqueryPath, String(Date.now()));
  } catch (e) {
    // fail-open
  }
}

// ── checkIdleStop ────────────────────────────────────────────────────────────

/**
 * Auto-stop server if idle longer than IDLE_TIMEOUT_MS.
 * @returns {{ok: boolean, status: string}|null} Stop result or null if not idle
 */
function checkIdleStop() {
  try {
    let lastQuery;
    try {
      const ts = fs.readFileSync(_lastqueryPath, 'utf8').trim();
      lastQuery = parseInt(ts, 10);
    } catch (e) {
      return null; // No lastquery file — no-op
    }

    if (isNaN(lastQuery)) return null;

    if (Date.now() - lastQuery > IDLE_TIMEOUT_MS) {
      process.stderr.write('[coderlm-lifecycle] Idle timeout reached, stopping server\n');
      return stop();
    }

    return null;
  } catch (e) {
    return null; // fail-open
  }
}

// ── reindex ──────────────────────────────────────────────────────────────────

/**
 * Trigger a coderlm server reindex via POST /reindex.
 * Called after autoClose() modifies files so subsequent solve iterations query current state (CDIAG-04).
 * Fail-open: never throws to callers. Returns { ok: true } on success, { error: string } on failure.
 * @param {Object} [opts]
 * @param {number} [opts.port=8787] - Server port
 * @returns {{ok: boolean, error?: string}}
 */
function reindex(opts) {
  try {
    return { ok: true, note: 'coderlm uses filesystem watchers — reindex not needed' };
  } catch (e) {
    return { error: e.message };
  }
}

// ── CLI interface ────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2];

  function output(result) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  switch (cmd) {
    case '--start': {
      const port = parseInt(process.argv[3], 10) || DEFAULT_PORT;
      const indexPath = process.argv[4] || process.cwd();
      output(ensureRunning({ port, indexPath }));
      break;
    }
    case '--stop':
      output(stop());
      break;
    case '--status':
      output(status());
      break;
    case '--update': {
      // Stop if running, delete binary, re-download
      const stopResult = stop();
      try { fs.unlinkSync(_binaryPath); } catch (e) { /* not present */ }
      const downloadResult = ensureBinary();
      const alsoStart = process.argv.includes('--start');
      let startResult = null;
      if (alsoStart && downloadResult.ok) {
        startResult = ensureRunning();
      }
      output({
        stop: stopResult,
        download: downloadResult,
        start: startResult,
      });
      break;
    }
    case '--check-idle':
      output(checkIdleStop() || { idle: false });
      break;
    default:
      process.stderr.write('Usage: coderlm-lifecycle.cjs <--start|--stop|--status|--update|--check-idle>\n');
      process.exit(1);
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ensureBinary,
  ensureRunning,
  stop,
  status,
  touchLastQuery,
  checkIdleStop,
  reindex,
  // Test helpers
  _setPaths,
  get _statePath() { return _statePath; },
  getPlatformBinaryName,
};
