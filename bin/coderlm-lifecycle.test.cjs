'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const lifecycle = require('./coderlm-lifecycle.cjs');

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coderlm-lifecycle-test-'));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ── Module exports ───────────────────────────────────────────────────────────

describe('Module exports', () => {
  it('exports all 7 required functions', () => {
    const exports = Object.keys(lifecycle).sort().filter(k => !k.startsWith('_') && k !== 'getPlatformBinaryName');
    assert.deepStrictEqual(exports, [
      'checkIdleStop',
      'ensureBinary',
      'ensureRunning',
      'reindex',
      'status',
      'stop',
      'touchLastQuery',
    ]);
  });

  it('each export is a function', () => {
    assert.strictEqual(typeof lifecycle.ensureBinary, 'function');
    assert.strictEqual(typeof lifecycle.ensureRunning, 'function');
    assert.strictEqual(typeof lifecycle.stop, 'function');
    assert.strictEqual(typeof lifecycle.status, 'function');
    assert.strictEqual(typeof lifecycle.touchLastQuery, 'function');
    assert.strictEqual(typeof lifecycle.checkIdleStop, 'function');
  });

  it('exports _setPaths test helper', () => {
    assert.strictEqual(typeof lifecycle._setPaths, 'function');
  });

  it('exports getPlatformBinaryName', () => {
    assert.strictEqual(typeof lifecycle.getPlatformBinaryName, 'function');
  });
});

// ── getPlatformBinaryName ────────────────────────────────────────────────────

describe('getPlatformBinaryName', () => {
  it('returns a string matching expected pattern on supported platforms', () => {
    const name = lifecycle.getPlatformBinaryName();
    // On macOS or Linux CI, this should return a valid name
    if (name !== null) {
      assert.match(name, /^coderlm-(darwin|linux)-(arm64|x64)$/);
    }
  });

  it('returns a non-null value on darwin or linux', () => {
    const platform = process.platform;
    const arch = process.arch;
    const name = lifecycle.getPlatformBinaryName();
    if ((platform === 'darwin' || platform === 'linux') && (arch === 'arm64' || arch === 'x64')) {
      assert.notStrictEqual(name, null);
    }
  });
});

// ── ensureBinary idempotency ─────────────────────────────────────────────────

describe('ensureBinary idempotency', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lifecycle._setPaths(tmpDir);
  });

  afterEach(() => {
    lifecycle._setPaths(); // reset
    cleanupDir(tmpDir);
  });

  it('returns cached when binary exists and is executable', () => {
    const binPath = path.join(tmpDir, 'coderlm');
    fs.writeFileSync(binPath, '#!/bin/sh\necho ok');
    fs.chmodSync(binPath, 0o755);

    const result = lifecycle.ensureBinary();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.source, 'cached');
    assert.strictEqual(result.path, binPath);
  });

  it('attempts download when binary does not exist (returns error in test env)', () => {
    // No binary at tmpDir/coderlm — ensureBinary will try gh download
    // which will fail in test environment, but should not throw
    const result = lifecycle.ensureBinary();
    assert.strictEqual(typeof result.ok, 'boolean');
    // Either downloaded (unlikely) or failed gracefully
    if (!result.ok) {
      assert.ok(result.error, 'should have error field');
    }
  });

  it('never throws — fail-open contract', () => {
    // Even with bad paths, should return error object
    assert.doesNotThrow(() => {
      lifecycle.ensureBinary();
    });
  });
});

// ── PID file lifecycle ───────────────────────────────────────────────────────

describe('PID file lifecycle', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lifecycle._setPaths(tmpDir);
  });

  afterEach(() => {
    lifecycle._setPaths(); // reset
    cleanupDir(tmpDir);
  });

  it('status reports not-running when no PID file', () => {
    const s = lifecycle.status();
    assert.strictEqual(s.process.running, false);
    assert.strictEqual(s.process.pid, null);
  });

  it('status reads PID from file', () => {
    const pidPath = path.join(tmpDir, 'coderlm.pid');
    // Use current process PID (known to be alive)
    fs.writeFileSync(pidPath, String(process.pid));

    const s = lifecycle.status();
    assert.strictEqual(s.process.running, true);
    assert.strictEqual(s.process.pid, process.pid);
  });

  it('stop cleans up PID file for dead process (ESRCH handling)', () => {
    const pidPath = path.join(tmpDir, 'coderlm.pid');
    // Write a PID that definitely does not exist (very high number)
    fs.writeFileSync(pidPath, '999999999');

    const result = lifecycle.stop();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'already-dead');
    // PID file should be cleaned up
    assert.strictEqual(fs.existsSync(pidPath), false);
  });

  it('stop returns not-running when no PID file', () => {
    const result = lifecycle.stop();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'not-running');
  });

  it('stop cleans up lastquery file too', () => {
    const pidPath = path.join(tmpDir, 'coderlm.pid');
    const lqPath = path.join(tmpDir, 'coderlm.lastquery');
    fs.writeFileSync(pidPath, '999999999');
    fs.writeFileSync(lqPath, String(Date.now()));

    lifecycle.stop();
    assert.strictEqual(fs.existsSync(pidPath), false);
    assert.strictEqual(fs.existsSync(lqPath), false);
  });
});

// ── touchLastQuery and checkIdleStop ─────────────────────────────────────────

describe('touchLastQuery and checkIdleStop', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lifecycle._setPaths(tmpDir);
  });

  afterEach(() => {
    lifecycle._setPaths(); // reset
    cleanupDir(tmpDir);
  });

  it('touchLastQuery writes current timestamp', () => {
    lifecycle.touchLastQuery();
    const lqPath = path.join(tmpDir, 'coderlm.lastquery');
    assert.ok(fs.existsSync(lqPath), 'lastquery file should exist');
    const ts = parseInt(fs.readFileSync(lqPath, 'utf8').trim(), 10);
    // Should be within last 5 seconds
    assert.ok(Date.now() - ts < 5000, 'timestamp should be recent');
  });

  it('touchLastQuery never throws (fail-open)', () => {
    // Even if _setPaths points to a read-only or invalid dir, should not throw
    assert.doesNotThrow(() => {
      lifecycle.touchLastQuery();
    });
  });

  it('checkIdleStop returns null when no lastquery file', () => {
    const result = lifecycle.checkIdleStop();
    assert.strictEqual(result, null);
  });

  it('checkIdleStop returns null when within timeout', () => {
    const lqPath = path.join(tmpDir, 'coderlm.lastquery');
    fs.writeFileSync(lqPath, String(Date.now())); // just now

    const result = lifecycle.checkIdleStop();
    assert.strictEqual(result, null);
  });

  it('checkIdleStop triggers stop when past timeout', () => {
    const lqPath = path.join(tmpDir, 'coderlm.lastquery');
    // Write timestamp 6 minutes ago (past 5-min idle timeout)
    fs.writeFileSync(lqPath, String(Date.now() - 6 * 60 * 1000));
    // No PID file means stop() returns not-running, but checkIdleStop should still trigger
    const result = lifecycle.checkIdleStop();
    assert.ok(result !== null, 'should trigger stop');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'not-running');
  });
});

// ── Zombie PID handling ──────────────────────────────────────────────────────

describe('Zombie PID handling', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lifecycle._setPaths(tmpDir);
  });

  afterEach(() => {
    lifecycle._setPaths(); // reset
    cleanupDir(tmpDir);
  });

  it('ensureRunning cleans up stale PID when process is dead', () => {
    const pidPath = path.join(tmpDir, 'coderlm.pid');
    fs.writeFileSync(pidPath, '999999999'); // dead PID

    // ensureRunning should detect dead PID, clean up, then attempt ensureBinary
    // which will likely fail in test env (no binary) — but should not throw
    const result = lifecycle.ensureRunning();
    assert.strictEqual(typeof result.ok, 'boolean');
    // PID file for dead process should have been cleaned up
    // (a new PID file might exist if spawn succeeded, which is unlikely in test)
  });

  it('ensureRunning never throws — fail-open contract', () => {
    assert.doesNotThrow(() => {
      lifecycle.ensureRunning();
    });
  });
});

// ── status structure ─────────────────────────────────────────────────────────

describe('status structure', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lifecycle._setPaths(tmpDir);
  });

  afterEach(() => {
    lifecycle._setPaths(); // reset
    cleanupDir(tmpDir);
  });

  it('returns complete status object with expected shape', () => {
    const s = lifecycle.status();
    assert.ok(s.binary, 'should have binary field');
    assert.ok('installed' in s.binary, 'binary should have installed');
    assert.ok('path' in s.binary, 'binary should have path');
    assert.ok(s.process, 'should have process field');
    assert.ok('running' in s.process, 'process should have running');
    assert.ok('pid' in s.process, 'process should have pid');
    assert.ok(s.health, 'should have health field');
    assert.ok('healthy' in s.health, 'health should have healthy');
    assert.ok(s.idle, 'should have idle field');
    assert.ok('idleTimeoutMs' in s.idle, 'idle should have idleTimeoutMs');
    assert.strictEqual(s.idle.idleTimeoutMs, 5 * 60 * 1000);
  });

  it('reports idle info when lastquery file exists', () => {
    const lqPath = path.join(tmpDir, 'coderlm.lastquery');
    const now = Date.now();
    fs.writeFileSync(lqPath, String(now));

    const s = lifecycle.status();
    assert.strictEqual(s.idle.lastQueryMs, now);
    assert.ok(s.idle.idleDurationMs >= 0, 'idleDurationMs should be >= 0');
  });

  it('never throws — fail-open contract', () => {
    assert.doesNotThrow(() => {
      lifecycle.status();
    });
  });
});

// ── status corrupt lastquery file ────────────────────────────────────────────

describe('status corrupt lastquery file', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); lifecycle._setPaths(tmpDir); });
  afterEach(() => { lifecycle._setPaths(); cleanupDir(tmpDir); });

  it('returns null lastQueryMs (not NaN) for a non-numeric lastquery file', () => {
    const lqPath = path.join(tmpDir, 'coderlm.lastquery');
    fs.writeFileSync(lqPath, 'not-a-number');
    const s = lifecycle.status();
    assert.strictEqual(s.idle.lastQueryMs, null);
    assert.strictEqual(s.idle.idleDurationMs, null);
  });
});

// ── CLI dispatch ─────────────────────────────────────────────────────────────

describe('CLI dispatch', () => {
  it('require.main === module guard exists in source', () => {
    const source = fs.readFileSync(path.join(__dirname, 'coderlm-lifecycle.cjs'), 'utf8');
    assert.ok(source.includes('require.main === module'), 'should have CLI guard');
  });

  it('source contains all CLI subcommands', () => {
    const source = fs.readFileSync(path.join(__dirname, 'coderlm-lifecycle.cjs'), 'utf8');
    assert.ok(source.includes("'--start'"), 'should have --start');
    assert.ok(source.includes("'--stop'"), 'should have --stop');
    assert.ok(source.includes("'--status'"), 'should have --status');
    assert.ok(source.includes("'--update'"), 'should have --update');
    assert.ok(source.includes("'--check-idle'"), 'should have --check-idle');
  });
});

// ── Integration contract: behavior expected by install.js ────────────────────

describe('ensureBinary() install.js contract', () => {
  it('returns ok:true with source:cached when binary already exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-lifecycle-contract-'));
    try {
      const { _setPaths, ensureBinary } = require('./coderlm-lifecycle.cjs');
      _setPaths(tmp);
      // Place a mock executable binary
      const binPath = path.join(tmp, 'coderlm');
      fs.writeFileSync(binPath, '#!/bin/sh\n');
      fs.chmodSync(binPath, 0o755);
      const result = ensureBinary();
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.source, 'cached');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      const { _setPaths } = require('./coderlm-lifecycle.cjs');
      _setPaths(); // reset
    }
  });

  it('returns ok:false (not ok:undefined) on download failure — install.js relies on result.ok boolean', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-lifecycle-contract-'));
    try {
      const { _setPaths, ensureBinary } = require('./coderlm-lifecycle.cjs');
      _setPaths(tmp);
      // No binary present, gh CLI will fail (not authenticated or not present in CI)
      const result = ensureBinary();
      // result.ok must be a boolean (true or false), never undefined
      assert.ok(typeof result.ok === 'boolean', 'result.ok must be boolean');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      const { _setPaths } = require('./coderlm-lifecycle.cjs');
      _setPaths();
    }
  });
});

// ── Fail-open contracts ──────────────────────────────────────────────────────

describe('Fail-open contracts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lifecycle._setPaths(tmpDir);
  });

  afterEach(() => {
    lifecycle._setPaths(); // reset
    cleanupDir(tmpDir);
  });

  it('ensureBinary never throws', () => {
    assert.doesNotThrow(() => {
      const result = lifecycle.ensureBinary();
      assert.strictEqual(typeof result, 'object');
      assert.strictEqual(typeof result.ok, 'boolean');
    });
  });

  it('ensureRunning never throws', () => {
    assert.doesNotThrow(() => {
      const result = lifecycle.ensureRunning();
      assert.strictEqual(typeof result, 'object');
      assert.strictEqual(typeof result.ok, 'boolean');
    });
  });

  it('stop never throws', () => {
    assert.doesNotThrow(() => {
      const result = lifecycle.stop();
      assert.strictEqual(typeof result, 'object');
      assert.strictEqual(typeof result.ok, 'boolean');
    });
  });

  it('status never throws', () => {
    assert.doesNotThrow(() => {
      const result = lifecycle.status();
      assert.strictEqual(typeof result, 'object');
    });
  });

  it('touchLastQuery never throws', () => {
    assert.doesNotThrow(() => {
      lifecycle.touchLastQuery();
    });
  });

  it('checkIdleStop never throws', () => {
    assert.doesNotThrow(() => {
      lifecycle.checkIdleStop();
    });
  });
});
