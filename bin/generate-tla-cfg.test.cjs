#!/usr/bin/env node
'use strict';
// bin/generate-tla-cfg.test.cjs
// Comprehensive tests for bin/generate-tla-cfg.cjs
//
// The CLI is not invoked with cwd isolation for write tests because ROOT is
// always path.join(__dirname, '..') — it writes to the real repo's .planning/formal/tla/.
// Content and error-path tests use --dry (safe) or a synthetic repo layout
// built under a tmpDir that is then referenced via symlink tricks are NOT used.
// Instead: write tests invoke the real CLI (which writes to the real repo) and
// verify the result, then restore from a backup taken before the run.
//
// Pattern for subprocess:
//   spawnSync(process.execPath, [CLI, ...args], { encoding:'utf8', cwd:tmpDir, timeout:5000 })

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CLI      = path.join(__dirname, 'generate-tla-cfg.cjs');
const REPO_ROOT = path.join(__dirname, '..');
const MACHINE_FILE = path.join(REPO_ROOT, 'src', 'machines', 'nf-workflow.machine.ts');
const SAFETY_PATH   = path.join(REPO_ROOT, '.planning', 'formal', 'tla', 'MCsafety.cfg');
const LIVENESS_PATH = path.join(REPO_ROOT, '.planning', 'formal', 'tla', 'MCliveness.cfg');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal synthetic repo tree under tmpDir with:
 *   src/machines/nf-workflow.machine.ts  (custom content)
 *   .planning/formal/tla/                            (empty dir)
 *
 * Returns an object with helpers to spawn the CLI pointing at that tree.
 * Because ROOT = path.join(__dirname, '..'), we cannot redirect the CLI to
 * tmpDir. We instead use a NODE_PATH trick: create a parallel bin directory
 * and rewrite the CLI with ROOT overridden. That is too brittle. The cleaner
 * approach: create a small wrapper script in tmpDir/bin/ that sets __dirname
 * via module patching. However, the cleanest approach for a CJS script that
 * uses __dirname is to launch it with a modified copy.
 *
 * We write a one-shot wrapper into tmpDir that requires the original CLI but
 * temporarily monkey-patches require('path').join to redirect ROOT. That is
 * also fragile. The cleanest approach for these tests is:
 *
 * 1. For error-path tests (missing machine file, missing pattern): set up a
 *    fake repo tree and point the CLI at it by pre-writing a modified wrapper.
 * 2. For content tests: use --dry against the REAL repo (which always has the
 *    machine file), and verify stdout.
 * 3. For write tests: take a backup, run, verify, restore.
 *
 * Approach 1 is implemented by copying the CLI source with ROOT overridden.
 */
function makeSyntheticCLI(tmpDir, machineContent) {
  // Read original CLI source
  const src = fs.readFileSync(CLI, 'utf8');

  // Replace the ROOT definition with one that points to tmpDir.
  // Use a string pattern (not a regex literal) to avoid unmatched-paren parse errors.
  const ROOT_PATTERN = new RegExp("const ROOT\\s*=\\s*path\\.join\\(__dirname,\\s*'\\.\\.'\\s*\\);");
  const patched = src.replace(
    ROOT_PATTERN,
    `const ROOT = ${JSON.stringify(tmpDir)};`
  );

  // Write the patched CLI into tmpDir/bin/
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const patchedCLI = path.join(binDir, 'generate-tla-cfg-patched.cjs');
  fs.writeFileSync(patchedCLI, patched, 'utf8');

  // Create the directory structure the CLI expects
  fs.mkdirSync(path.join(tmpDir, 'src', 'machines'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.planning', 'formal', 'tla'), { recursive: true });

  if (machineContent !== undefined) {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'machines', 'nf-workflow.machine.ts'),
      machineContent,
      'utf8'
    );
  }

  return patchedCLI;
}

function run(cli, args, opts) {
  return spawnSync(process.execPath, [cli, ...(args || [])], {
    encoding: 'utf8',
    timeout: 5000,
    ...(opts || {}),
  });
}

// ── Group 1: Missing machine file ─────────────────────────────────────────────

test('exits 1 when XState machine file does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    // Provide NO machine file — only the .planning/formal/tla dir
    const patchedCLI = makeSyntheticCLI(tmpDir, undefined);
    // Remove the machine file that was not written anyway
    const result = run(patchedCLI);
    assert.equal(result.status, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stderr mentions machine file path when it is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, undefined);
    const result = run(patchedCLI);
    assert.match(result.stderr, /XState machine not found|nf-workflow\.machine\.ts/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Group 2: maxDeliberation extraction failures ──────────────────────────────

test('exits 1 when maxDeliberation is absent from machine file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '// no maxDeliberation here\nconst x = 1;\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stderr mentions maxDeliberation when pattern is not found', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, 'export const foo = 42;\n');
    const result = run(patchedCLI);
    assert.match(result.stderr, /maxDeliberation/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits 1 when machine file is empty', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '');
    const result = run(patchedCLI);
    assert.equal(result.status, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('maxDeliberation must be a bare integer (not in a comment)', () => {
  // A value like "// maxDeliberation: 5" is still matched by the regex,
  // so this test validates that the regex DOES match even in a comment.
  // This documents the current behavior (no comment-stripping).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '// maxDeliberation: 99\n');
    const result = run(patchedCLI);
    // The regex matches it even in a comment — exits 0 and uses 99
    assert.equal(result.status, 0);
    assert.match(result.stdout, /maxDeliberation=99/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Group 3: Successful extraction (synthetic repo, non-dry) ─────────────────

test('exits 0 with a valid machine file containing maxDeliberation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, 'export const maxDeliberation: 10;\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stdout reports extracted maxDeliberation value', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    7,\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Extracted maxDeliberation=7/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stdout reports SafetyAgents=5 and LivenessAgents=3 in summary line', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    7,\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /SafetyAgents=5/);
    assert.match(result.stdout, /LivenessAgents=3/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writes MCsafety.cfg to .planning/formal/tla/ in non-dry mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    7,\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 0);
    const outPath = path.join(tmpDir, '.planning', 'formal', 'tla', 'MCsafety.cfg');
    assert.ok(fs.existsSync(outPath), 'MCsafety.cfg should be written');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writes MCliveness.cfg to .planning/formal/tla/ in non-dry mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    7,\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 0);
    const outPath = path.join(tmpDir, '.planning', 'formal', 'tla', 'MCliveness.cfg');
    assert.ok(fs.existsSync(outPath), 'MCliveness.cfg should be written');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stdout confirms both files written in non-dry mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    7,\n');
    const result = run(patchedCLI);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Written.*MCsafety\.cfg/);
    assert.match(result.stdout, /Written.*MCliveness\.cfg/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Group 4: --dry flag ───────────────────────────────────────────────────────

test('--dry flag exits 0 against the real repo', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
});

test('--dry prints MCsafety.cfg content to stdout', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--- MCsafety\.cfg ---/);
});

test('--dry prints MCliveness.cfg content to stdout', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--- MCliveness\.cfg ---/);
});

test('--dry does not write MCsafety.cfg (file mtime does not change)', () => {
  // If the file already exists, its mtime should remain unchanged after --dry.
  const existsBefore = fs.existsSync(SAFETY_PATH);
  const mtimeBefore  = existsBefore ? fs.statSync(SAFETY_PATH).mtimeMs : null;

  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);

  if (existsBefore) {
    const mtimeAfter = fs.statSync(SAFETY_PATH).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'MCsafety.cfg mtime should not change under --dry');
  }
  // If the file did not exist before --dry, it still should not exist after.
  if (!existsBefore) {
    assert.ok(!fs.existsSync(SAFETY_PATH), 'MCsafety.cfg must not be created by --dry');
  }
});

// ── Group 5: MCsafety.cfg content structure ───────────────────────────────────

test('MCsafety.cfg contains SPECIFICATION Spec', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SPECIFICATION Spec/);
});

test('MCsafety.cfg declares 5 agent model values (a1=a1 .. a5=a5)', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  // All five must appear in the safety section (before MCliveness section)
  const safetySection = result.stdout.split('--- MCliveness.cfg ---')[0];
  for (let i = 1; i <= 5; i++) {
    assert.match(safetySection, new RegExp(`a${i}\\s*=\\s*a${i}`));
  }
});

test('MCsafety.cfg Agents set contains exactly {a1, a2, a3, a4, a5}', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const safetySection = result.stdout.split('--- MCliveness.cfg ---')[0];
  assert.match(safetySection, /Agents\s*=\s*\{a1,\s*a2,\s*a3,\s*a4,\s*a5\}/);
});

test('MCsafety.cfg contains SYMMETRY AgentSymmetry', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const safetySection = result.stdout.split('--- MCliveness.cfg ---')[0];
  assert.match(safetySection, /SYMMETRY AgentSymmetry/);
});

test('MCsafety.cfg contains required invariants: TypeOK, MinQuorumMet', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const safetySection = result.stdout.split('--- MCliveness.cfg ---')[0];
  assert.match(safetySection, /INVARIANT TypeOK/);
  assert.match(safetySection, /INVARIANT MinQuorumMet/);
});

test('MCsafety.cfg contains CHECK_DEADLOCK FALSE', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const safetySection = result.stdout.split('--- MCliveness.cfg ---')[0];
  assert.match(safetySection, /CHECK_DEADLOCK FALSE/);
});

// ── Group 6: MCliveness.cfg content structure ─────────────────────────────────

test('MCliveness.cfg declares 3 agent model values (a1=a1 .. a3=a3)', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const livenessSection = result.stdout.split('--- MCliveness.cfg ---')[1];
  for (let i = 1; i <= 3; i++) {
    assert.match(livenessSection, new RegExp(`a${i}\\s*=\\s*a${i}`));
  }
  // a4, a5 must NOT appear in the liveness section
  assert.ok(!/a4\s*=\s*a4/.test(livenessSection), 'MCliveness.cfg must not declare a4');
  assert.ok(!/a5\s*=\s*a5/.test(livenessSection), 'MCliveness.cfg must not declare a5');
});

test('MCliveness.cfg Agents set contains exactly {a1, a2, a3}', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const livenessSection = result.stdout.split('--- MCliveness.cfg ---')[1];
  assert.match(livenessSection, /Agents\s*=\s*\{a1,\s*a2,\s*a3\}/);
});

test('MCliveness.cfg contains PROPERTY EventualConsensus', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const livenessSection = result.stdout.split('--- MCliveness.cfg ---')[1];
  assert.match(livenessSection, /PROPERTY EventualConsensus/);
});

test('MCliveness.cfg does NOT contain SYMMETRY (incompatible with liveness)', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const livenessSection = result.stdout.split('--- MCliveness.cfg ---')[1];
  assert.ok(!/SYMMETRY/.test(livenessSection), 'MCliveness.cfg must not contain SYMMETRY');
});

test('MCliveness.cfg contains CHECK_DEADLOCK FALSE', () => {
  const result = run(CLI, ['--dry'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  const livenessSection = result.stdout.split('--- MCliveness.cfg ---')[1];
  assert.match(livenessSection, /CHECK_DEADLOCK FALSE/);
});

// ── Group 7: maxDeliberation propagated to both cfg files ─────────────────────

test('maxDeliberation value from machine file appears in MCsafety.cfg output', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    42,\n');
    const result = run(patchedCLI, ['--dry']);
    assert.equal(result.status, 0);
    const safetySection = result.stdout.split('--- MCliveness.cfg ---')[0];
    assert.match(safetySection, /MaxDeliberation\s*=\s*42/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('maxDeliberation value from machine file appears in MCliveness.cfg output', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    42,\n');
    const result = run(patchedCLI, ['--dry']);
    assert.equal(result.status, 0);
    const livenessSection = result.stdout.split('--- MCliveness.cfg ---')[1];
    assert.match(livenessSection, /MaxDeliberation\s*=\s*42/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('maxDeliberation=1 (minimum) is correctly propagated', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    1,\n');
    const result = run(patchedCLI, ['--dry']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /MaxDeliberation\s*=\s*1/);
    assert.match(result.stdout, /maxDeliberation=1/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('maxDeliberation=100 (large value) is correctly propagated', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    100,\n');
    const result = run(patchedCLI, ['--dry']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /MaxDeliberation\s*=\s*100/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Group 8: Written file content matches --dry output ────────────────────────

test('written MCsafety.cfg content matches --dry stdout section', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const machineContent = '  maxDeliberation:    7,\n';
    const patchedCLI = makeSyntheticCLI(tmpDir, machineContent);

    // Run --dry to capture expected content
    const dryResult = run(patchedCLI, ['--dry']);
    assert.equal(dryResult.status, 0);

    // Run without --dry to write files
    const writeResult = run(patchedCLI, []);
    assert.equal(writeResult.status, 0);

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'formal', 'tla', 'MCsafety.cfg'), 'utf8');

    // Dry output section is between "--- MCsafety.cfg ---\n" and "--- MCliveness.cfg ---\n"
    const drySection = dryResult.stdout
      .split('--- MCsafety.cfg ---\n')[1]
      .split('\n--- MCliveness.cfg ---')[0];

    assert.equal(written, drySection);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('written MCliveness.cfg content matches --dry stdout section', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const machineContent = '  maxDeliberation:    7,\n';
    const patchedCLI = makeSyntheticCLI(tmpDir, machineContent);

    const dryResult = run(patchedCLI, ['--dry']);
    assert.equal(dryResult.status, 0);

    const writeResult = run(patchedCLI, []);
    assert.equal(writeResult.status, 0);

    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'formal', 'tla', 'MCliveness.cfg'), 'utf8');

    // Dry output section is everything after "--- MCliveness.cfg ---\n".
    // Strip trailing summary lines (prefixed with "[generate-tla-cfg]") that
    // the CLI emits to stdout after the cfg content but are not part of the file.
    const rawDrySection = dryResult.stdout.split('--- MCliveness.cfg ---\n')[1];
    const drySection = rawDrySection
      .split('\n')
      .filter(line => !line.startsWith('[generate-tla-cfg]'))
      .join('\n');

    assert.equal(written, drySection);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Group 9: Missing-resource robustness ──────────────────────────────────────

test('creates the output directory if .planning/formal/tla is missing (non-dry)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, '  maxDeliberation:    7,\n');
    // Remove the .planning tree that makeSyntheticCLI pre-created
    fs.rmSync(path.join(tmpDir, '.planning'), { recursive: true, force: true });
    const result = run(patchedCLI, []);
    assert.equal(result.status, 0, 'should not crash when output dir is missing; stderr=' + result.stderr);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'formal', 'tla', 'MCsafety.cfg')),
      'MCsafety.cfg should be created even when the output dir was missing'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'formal', 'tla', 'MCliveness.cfg')),
      'MCliveness.cfg should be created even when the output dir was missing'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exits cleanly (no EISDIR stack) when machine path is a directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-cfg-test-'));
  try {
    const patchedCLI = makeSyntheticCLI(tmpDir, undefined);
    // Make the machine "file" path a directory instead of a regular file
    fs.mkdirSync(path.join(tmpDir, 'src', 'machines', 'nf-workflow.machine.ts'));
    const result = run(patchedCLI);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /EISDIR|illegal operation on a directory/);
    assert.match(result.stderr, /XState machine not found|nf-workflow\.machine\.ts/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
