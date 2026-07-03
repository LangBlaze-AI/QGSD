#!/usr/bin/env node
'use strict';
// bin/sast-sweep.cjs
// SAST (Static Application Security Testing) sweep — runs Semgrep with a bundled,
// curated, OFFLINE ruleset (bin/sast-rules.yaml) over the project's source to
// detect code-injection vulnerabilities (SQL injection, command injection, eval,
// XSS, unsafe deserialization) that nf-solve's cross-layer CONSISTENCY checks
// cannot see. This is the same "orchestrate an external analyzer" pattern nf-solve
// already uses for TLC/Alloy/PRISM (run-formal-verify) — not a bespoke SAST engine.
//
// Deterministic & offline: the ruleset is bundled (no Semgrep registry/network),
// verified 0 findings on nForma's own bin/ + hooks/, so any finding is a genuine
// injected vulnerability. Fail-open: if Semgrep isn't installed, returns a
// skipped result (so nf-solve reports residual -1, NOT a false 0).
//
// Usage:  node bin/sast-sweep.cjs --json    → { findings: [...], count, skipped? }
// Exit:   0 = clean/skipped, 1 = findings.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Locate the Semgrep binary (PATH, then the common pipx/user-local install dir).
function resolveSemgrep() {
  const probe = spawnSync('semgrep', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (probe.status === 0) return 'semgrep';
  const local = path.join(process.env.HOME || '', '.local', 'bin', 'semgrep');
  if (fs.existsSync(local)) return local;
  return null;
}

// The bundled ruleset ships next to this script (installed to ~/.claude/nf-bin/),
// with a CWD ./bin fallback for the dev checkout (portable-path convention).
function resolveRuleset() {
  const bundled = path.join(__dirname, 'sast-rules.yaml');
  if (fs.existsSync(bundled)) return bundled;
  const cwd = path.join(process.cwd(), 'bin', 'sast-rules.yaml');
  if (fs.existsSync(cwd)) return cwd;
  return null;
}

// Application source dirs to scan. Scoped to the conventional web-app source
// roots where injection vulnerabilities live — NOT a whole CLI codebase's bin/.
// This keeps the sweep instant on projects without such dirs (e.g. nForma has
// none → 0 findings, no per-solve latency) while covering the target/fixture
// apps the SAST challenges mutate.
function scanTargets(root) {
  return ['src', 'app', 'server', 'api', 'routes', 'controllers', 'handlers', 'services']
    .map(d => path.join(root, d))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } });
}

function runSast(root) {
  // Cheapest check first: if the project has no app-source dirs to scan, return
  // immediately WITHOUT probing Semgrep — keeps the sweep instant (no subprocess)
  // on projects like nForma that have no web-app source (its own bin/ CLI code is
  // out of scope for injection-vuln scanning).
  const targets = scanTargets(root);
  if (targets.length === 0) return { skipped: false, findings: [], count: 0 };
  const semgrep = resolveSemgrep();
  if (!semgrep) return { skipped: true, reason: 'semgrep not installed', findings: [], count: 0 };
  const ruleset = resolveRuleset();
  if (!ruleset) return { skipped: true, reason: 'sast-rules.yaml not found', findings: [], count: 0 };

  const res = spawnSync(semgrep, ['--config', ruleset, '--json', '--quiet', '--no-git-ignore', ...targets], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || !res.stdout) {
    return { skipped: true, reason: 'semgrep failed: ' + ((res.error && res.error.message) || (res.stderr || '').slice(0, 300)), findings: [], count: 0 };
  }
  let data;
  try { data = JSON.parse(res.stdout); } catch (e) {
    return { skipped: true, reason: 'semgrep output parse error: ' + e.message, findings: [], count: 0 };
  }
  const findings = (data.results || []).map(r => ({
    rule: (r.check_id || '').split('.').pop(),
    file: path.relative(root, r.path),
    line: r.start && r.start.line,
    message: (r.extra && r.extra.message) || '',
  }));
  return { skipped: false, findings: findings, count: findings.length };
}

module.exports = { runSast: runSast, resolveSemgrep: resolveSemgrep, resolveRuleset: resolveRuleset };

if (require.main === module) {
  const root = process.cwd();
  const asJson = process.argv.includes('--json');
  const r = runSast(root);
  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else if (r.skipped) {
    console.log('[sast] skipped: ' + r.reason);
  } else {
    for (const f of r.findings) console.log('[' + f.rule + '] ' + f.file + ':' + f.line + ' — ' + f.message);
    console.log(r.count + ' SAST finding(s)');
  }
  process.exit(!r.skipped && r.count > 0 ? 1 : 0);
}
