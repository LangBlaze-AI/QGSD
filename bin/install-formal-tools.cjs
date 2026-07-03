#!/usr/bin/env node
'use strict';

/**
 * install-formal-tools.cjs
 *
 * Cross-platform installer for nForma formal verification tools:
 *   TLA+    — downloads tla2tools.jar into ~/.local/share/nf-formal/tla/
 *   Alloy   — downloads org.alloytools.alloy.dist.jar into ~/.local/share/nf-formal/alloy/
 *   PRISM   — downloads and installs platform-specific binary
 *   Petri   — no install needed (bundled via npm)
 *
 * Usage:
 *   node bin/install-formal-tools.cjs
 *   node bin/install.js --formal
 *
 * Idempotent — safe to run multiple times.
 * PRISM install is non-blocking (failure = warning, not exit 1).
 * Always exits 0 — failures are non-blocking warnings.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

// ─── Output helpers ────────────────────────────────────────────────────────

function ok(msg) {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${msg}\n`);
}

function skip(msg) {
  process.stdout.write(`\x1b[33m→\x1b[0m ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\x1b[31m✗\x1b[0m ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`  ${msg}\n`);
}

// ─── HTTPS download with redirect following ────────────────────────────────

/**
 * Download a file from url to dest, following 301/302 redirects.
 * Returns a Promise that resolves when the file is fully written.
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error(`Redirect from ${currentUrl} missing Location header`));
            return;
          }
          res.resume(); // drain response
          doGet(location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', (err) => {
          fs.unlink(dest, () => {}); // clean up partial file
          reject(err);
        });
        res.on('error', (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
      }).on('error', reject);
    };
    doGet(url);
  });
}

// ─── Java check (soft warning only) ───────────────────────────────────────

function checkJava() {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0 || result.error) {
    process.stdout.write(
      `\x1b[33m⚠\x1b[0m  Java not found — TLA+, Alloy, and PRISM require Java 17+\n` +
      `   Download: https://adoptium.net/\n`
    );
    return;
  }
  // java -version prints to stderr; output format: openjdk version "17.0.x" ...
  // or legacy: java version "1.8.0_xxx"
  const output = result.stderr || result.stdout || '';
  const match = output.match(/"([^"]+)"/);
  if (match) {
    const versionStr = match[1]; // e.g. "17.0.2" or "1.8.0_362"
    const parts = versionStr.split('.');
    let major = parseInt(parts[0], 10);
    // Pre-Java 9: version format was "1.x.y" — treat as x
    if (major === 1 && parts.length >= 2) {
      major = parseInt(parts[1], 10);
    }
    if (isNaN(major) || major < 17) {
      process.stdout.write(
        `\x1b[33m⚠\x1b[0m  Java ${versionStr} detected — Java 17+ required for TLA+, Alloy, and PRISM\n` +
        `   Upgrade: https://adoptium.net/\n`
      );
    }
  }
}

// ─── System-wide install directory (XDG-compliant) ────────────────────────
const NF_FORMAL_HOME = path.join(os.homedir(), '.local', 'share', 'nf-formal');

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  const results = [];

  // Java check (soft warning, never blocks)
  checkJava();
  process.stdout.write('\n');
  info('Install target: ' + NF_FORMAL_HOME);
  process.stdout.write('\n');

  // ── TLA+ ──────────────────────────────────────────────────────────────

  const tlaDest = path.join(NF_FORMAL_HOME, 'tla', 'tla2tools.jar');
  const tlaUrl = 'https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar';

  if (fs.existsSync(tlaDest)) {
    skip('TLA+ tla2tools.jar already present — skipping');
    results.push({ name: 'TLA+', status: 'skip' });
  } else {
    process.stdout.write('  Downloading TLA+ tla2tools.jar…\n');
    try {
      fs.mkdirSync(path.dirname(tlaDest), { recursive: true });
      await downloadFile(tlaUrl, tlaDest);
      ok('TLA+ tla2tools.jar installed → ' + tlaDest);
      results.push({ name: 'TLA+', status: 'ok' });
    } catch (err) {
      fail(`TLA+ download failed: ${err.message}`);
      results.push({ name: 'TLA+', status: 'fail' });
    }
  }

  // ── Alloy ─────────────────────────────────────────────────────────────

  const alloyDest = path.join(NF_FORMAL_HOME, 'alloy', 'org.alloytools.alloy.dist.jar');
  const alloyUrl = 'https://github.com/AlloyTools/org.alloytools.alloy/releases/latest/download/org.alloytools.alloy.dist.jar';

  if (fs.existsSync(alloyDest)) {
    skip('Alloy org.alloytools.alloy.dist.jar already present — skipping');
    results.push({ name: 'Alloy', status: 'skip' });
  } else {
    process.stdout.write('  Downloading Alloy org.alloytools.alloy.dist.jar…\n');
    try {
      fs.mkdirSync(path.dirname(alloyDest), { recursive: true });
      await downloadFile(alloyUrl, alloyDest);
      ok('Alloy org.alloytools.alloy.dist.jar installed → ' + alloyDest);
      results.push({ name: 'Alloy', status: 'ok' });
    } catch (err) {
      fail(`Alloy download failed: ${err.message}`);
      results.push({ name: 'Alloy', status: 'fail' });
    }
  }

  // ── PRISM ─────────────────────────────────────────────────────────────

  const { resolvePrismBin } = require('./resolve-prism-bin.cjs');
  const prismBin = resolvePrismBin();
  if (prismBin) {
    skip('PRISM already configured — skipping');
    results.push({ name: 'PRISM', status: 'skip' });
  } else {
    const platform = process.platform;
    const tmpDir = os.tmpdir();

    try {
      if (platform === 'darwin') {
        const arch = process.arch === 'arm64' ? 'arm' : 'x86';
        const tarUrl = `https://www.prismmodelchecker.org/dl/prism-4.10-mac64-${arch}.tar.gz`;
        const tarPath = path.join(tmpDir, 'prism-mac64.tar.gz');
        process.stdout.write('  Downloading PRISM for macOS…\n');
        await downloadFile(tarUrl, tarPath);
        process.stdout.write('  Extracting PRISM…\n');
        const extract = spawnSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' });
        if (extract.status !== 0) throw new Error('tar extraction failed');
        const extractedName = fs.readdirSync(tmpDir).find(d => d.startsWith('prism-') && !d.endsWith('.tar.gz'));
        if (!extractedName) throw new Error('Could not find extracted PRISM directory');
        const extractedDir = path.join(tmpDir, extractedName);
        process.stdout.write('  Running PRISM install.sh…\n');
        const install = spawnSync('bash', ['./install.sh'], { cwd: extractedDir, stdio: 'inherit' });
        if (install.status !== 0) throw new Error('install.sh failed');
        // Remove quarantine attribute (macOS Gatekeeper) — ignore errors
        spawnSync('xattr', ['-dr', 'com.apple.quarantine', extractedDir], { stdio: 'pipe' });
        ok('PRISM installed');
        info(`export PRISM_BIN="${extractedDir}/bin/prism"`);
        info('Add the above line to your ~/.zshrc or ~/.bash_profile');
        results.push({ name: 'PRISM', status: 'ok' });
      } else if (platform === 'linux') {
        const arch = process.arch === 'arm64' ? 'arm' : 'x86';
        const tarUrl = `https://www.prismmodelchecker.org/dl/prism-4.10-linux64-${arch}.tar.gz`;
        const tarPath = path.join(tmpDir, 'prism-linux64.tar.gz');
        process.stdout.write('  Downloading PRISM for Linux…\n');
        await downloadFile(tarUrl, tarPath);
        process.stdout.write('  Extracting PRISM…\n');
        const extract = spawnSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' });
        if (extract.status !== 0) throw new Error('tar extraction failed');
        const extractedName = fs.readdirSync(tmpDir).find(d => d.startsWith('prism-') && !d.endsWith('.tar.gz'));
        if (!extractedName) throw new Error('Could not find extracted PRISM directory');
        const extractedDir = path.join(tmpDir, extractedName);
        process.stdout.write('  Running PRISM install.sh…\n');
        const install = spawnSync('bash', ['./install.sh'], { cwd: extractedDir, stdio: 'inherit' });
        if (install.status !== 0) throw new Error('install.sh failed');
        ok('PRISM installed');
        info(`  sudo ln -s "${extractedDir}/bin/prism" /usr/local/bin/prism`);
        info('  OR:');
        info(`  export PRISM_BIN="${extractedDir}/bin/prism"`);
        results.push({ name: 'PRISM', status: 'ok' });
      } else if (platform === 'win32') {
        const exeUrl = 'https://www.prismmodelchecker.org/dl/prism-4.10-win-installer.exe';
        const installerPath = path.join(tmpDir, 'prism-installer.exe');
        process.stdout.write('  Downloading PRISM installer for Windows…\n');
        await downloadFile(exeUrl, installerPath);
        process.stdout.write('  Running PRISM silent install…\n');
        const install = spawnSync(installerPath, ['/S'], { stdio: 'inherit' });
        if (install.status !== 0) throw new Error('PRISM silent installer failed');
        ok('PRISM installed');
        info('Add C:\\Program Files\\PRISM\\bin to your PATH');
        results.push({ name: 'PRISM', status: 'ok' });
      } else {
        fail(`PRISM install — unsupported platform: ${platform}`);
        info('Download manually from https://prismmodelchecker.org/download.php');
        results.push({ name: 'PRISM', status: 'fail' });
      }
    } catch (err) {
      fail(`PRISM install failed — see https://prismmodelchecker.org/download.php`);
      info(`Error: ${err.message}`);
      results.push({ name: 'PRISM', status: 'fail' });
    }
  }

  // ── Petri nets ────────────────────────────────────────────────────────

  // Check node_modules in cwd and script directory
  const petriPaths = [
    path.join(process.cwd(), 'node_modules', '@hpcc-js', 'wasm-graphviz'),
    path.join(__dirname, '..', 'node_modules', '@hpcc-js', 'wasm-graphviz'),
  ];
  if (petriPaths.some(p => fs.existsSync(p))) {
    skip('Petri nets — @hpcc-js/wasm-graphviz already present — skipping');
    results.push({ name: 'Petri', status: 'skip' });
  } else {
    process.stdout.write('  Installing @hpcc-js/wasm-graphviz…\n');
    const npmInstall = spawnSync('npm', ['install', '--save', '@hpcc-js/wasm-graphviz'], {
      cwd: process.cwd(), stdio: 'pipe'
    });
    if (npmInstall.status === 0) {
      ok('Petri nets — @hpcc-js/wasm-graphviz installed');
      results.push({ name: 'Petri', status: 'ok' });
    } else {
      info('Petri nets — failed to install @hpcc-js/wasm-graphviz');
      results.push({ name: 'Petri', status: 'skip' });
    }
  }

  // ── SAST (Semgrep) — powers nf-solve's `sast` layer (bin/sast-sweep.cjs) ──
  // Best-effort, like the formal analyzers: skip if present, try pipx then pip.
  const semgrepPresent = spawnSync('semgrep', ['--version'], { encoding: 'utf8', stdio: 'pipe' }).status === 0
    || fs.existsSync(path.join(process.env.HOME || '', '.local', 'bin', 'semgrep'));
  if (semgrepPresent) {
    skip('Semgrep (SAST) already present — skipping');
    results.push({ name: 'Semgrep', status: 'skip' });
  } else {
    process.stdout.write('  Installing Semgrep (SAST)…\n');
    let installed = false;
    if (spawnSync('pipx', ['--version'], { stdio: 'pipe' }).status === 0) {
      installed = spawnSync('pipx', ['install', 'semgrep'], { stdio: 'pipe', timeout: 300000 }).status === 0;
    }
    if (!installed && spawnSync('pip3', ['--version'], { stdio: 'pipe' }).status === 0) {
      installed = spawnSync('pip3', ['install', '--user', 'semgrep'], { stdio: 'pipe', timeout: 300000 }).status === 0;
    }
    if (installed) {
      ok('Semgrep (SAST) installed');
      results.push({ name: 'Semgrep', status: 'ok' });
    } else {
      info('Semgrep (SAST) — install skipped (need pipx or pip3); nf-solve sast layer will fail-open until installed');
      results.push({ name: 'Semgrep', status: 'skip' });
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────

  process.stdout.write('\n  Results:\n');
  const statusLabel = { ok: '\x1b[32m✓ installed\x1b[0m ', skip: '\x1b[33m→ skipped  \x1b[0m ', fail: '\x1b[31m✗ failed   \x1b[0m ' };
  const nameWidth = 8;
  for (const r of results) {
    const padded = r.name.padEnd(nameWidth);
    process.stdout.write(`    ${padded} ${statusLabel[r.status] || r.status}\n`);
  }
  process.stdout.write('\n');

  // ── Exit code ─────────────────────────────────────────────────────────

  // Best-effort — all failures are non-blocking warnings
  process.exit(0);
})().catch(err => {
  fail(err.message);
  process.exit(0);
});
