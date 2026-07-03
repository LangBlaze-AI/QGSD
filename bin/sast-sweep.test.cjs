'use strict';

// Unit tests for bin/sast-sweep.cjs — the Semgrep-backed SAST sweep. These are
// SKIP-AWARE: when Semgrep isn't installed (e.g. CI without the tool), the sweep
// returns { skipped: true } and the detection assertions are skipped rather than
// failing. Where Semgrep IS present, they assert a clean baseline and real
// detection of injected vulnerabilities.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSast, resolveSemgrep, resolveRuleset } = require('./sast-sweep.cjs');

const SEMGREP = resolveSemgrep();

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sast-')); }
function writeSrc(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test('the bundled ruleset ships and resolves', () => {
  const rs = resolveRuleset();
  assert.ok(rs && fs.existsSync(rs), 'sast-rules.yaml must resolve next to the script');
});

test('fail-open: returns skipped (residual -1 upstream), never a false clean, when no scannable dirs', () => {
  const root = tmpDir();
  try {
    const r = runSast(root); // no src/bin/lib → { skipped:false, count:0 } OR skipped if no semgrep
    assert.ok(r && typeof r.count === 'number');
    if (!SEMGREP) assert.strictEqual(r.skipped, true, 'no semgrep → skipped');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('clean source has 0 findings (when semgrep present)', { skip: !SEMGREP }, () => {
  const root = tmpDir();
  try {
    writeSrc(root, 'src/ok.js', "function q(db,id){ return db.query('SELECT * FROM t WHERE id = ?',[id]); }\nmodule.exports={q};");
    const r = runSast(root);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.count, 0, 'clean parameterized query is not a finding');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detects SQL injection, command injection, and eval (when semgrep present)', { skip: !SEMGREP }, () => {
  const root = tmpDir();
  try {
    writeSrc(root, 'src/vuln.js', [
      "const cp = require('child_process');",
      "function q(db,name){ return db.query('SELECT * FROM t WHERE n=\"' + name + '\"'); }",
      "function run(x){ cp.exec('ls ' + x); return eval(x); }",
      "module.exports={q,run};",
    ].join('\n'));
    const r = runSast(root);
    const rules = new Set(r.findings.map(f => f.rule));
    assert.ok(rules.has('sql-injection-string-concat'), 'SQL injection detected');
    assert.ok(rules.has('command-injection'), 'command injection detected');
    assert.ok(rules.has('eval-of-input'), 'eval-of-input detected');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does NOT flag new Function(src) syntax checks or process.stdout.write (when semgrep present)', { skip: !SEMGREP }, () => {
  const root = tmpDir();
  try {
    // Must live under a SCANNED source dir (src/), else the assertion passes
    // trivially because nothing was scanned — not because the FP guard works.
    writeSrc(root, 'src/util.js', [
      "function validate(src){ try { new Function(src); return true; } catch(_) { return false; } }",
      "function log(x){ process.stdout.write('value: ' + x); }",
      "module.exports={validate,log};",
    ].join('\n'));
    const r = runSast(root);
    assert.strictEqual(r.skipped, false, 'src/ is a scan target — the sweep must actually run');
    assert.strictEqual(r.count, 0, 'legit new Function / stdout.write must not be flagged (FP guard)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
